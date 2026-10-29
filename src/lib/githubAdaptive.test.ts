import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  copyGithubBlobs, createGithubTransport, GithubAdaptiveController,
  githubRetryDelay, verifyGithubBlob,
} from "./githubAdaptive.server";

function clock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    timing: { now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; } },
  };
}

function blobSha(content: string) {
  const bytes = Buffer.from(content, "base64");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

describe("backend adaptive GitHub transfer", () => {
  it("accelerates healthy batches, halves on limits, and recovers gradually", async () => {
    const time = clock();
    const c = new GithubAdaptiveController(time.timing);
    for (let i = 0; i < 9; i++) await c.batchCompleted(c.snapshot(), false);
    expect(c.concurrency).toBe(6);
    expect(c.pauseMs).toBe(0);
    const old = c.snapshot();
    c.limited(60_000);
    expect(c.concurrency).toBe(3);
    expect(c.pauseMs).toBe(500);
    await c.batchCompleted(old, false);
    expect(c.concurrency).toBe(3);
    await c.wait();
    expect(time.sleeps).toEqual([60_000]);
    for (let i = 0; i < 3; i++) await c.batchCompleted(c.snapshot(), false);
    expect(c.concurrency).toBe(4);
  });

  it("stops new requests for either account during shared cooldown", async () => {
    const time = clock();
    const c = new GithubAdaptiveController(time.timing);
    const calledAt: number[] = [];
    const fetcher: typeof fetch = async () => {
      calledAt.push(time.timing.now());
      return new Response("{}", { status: 200 });
    };
    const unauthorized = async (): Promise<never> => { throw new Error("401"); };
    const src = createGithubTransport("fake-source", c, unauthorized, fetcher);
    const tgt = createGithubTransport("fake-target", c, unauthorized, fetcher);
    c.limited(5000);
    await src("/source");
    await tgt("/target");
    expect(calledAt).toEqual([5000, 5000]);
  });

  it("paces mutations at least one second apart", async () => {
    const time = clock();
    const c = new GithubAdaptiveController(time.timing);
    await c.beforeRequest("POST");
    const first = time.timing.now();
    await c.beforeRequest("PATCH");
    expect(time.timing.now() - first).toBe(1000);
  });

  it("honors retry-after and primary reset, and uses a one-minute secondary fallback", () => {
    expect(githubRetryDelay(new Headers({ "retry-after": "12" }), 0, 0)).toBe(12_000);
    expect(githubRetryDelay(new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "120" }), 0, 0)).toBe(121_000);
    expect(githubRetryDelay(new Headers(), 0, 0)).toBe(60_000);
    expect(githubRetryDelay(new Headers(), 4, 0)).toBe(90_000);
  });

  it("retains exactly five retries without multiplying the retry budget", async () => {
    const time = clock();
    const c = new GithubAdaptiveController(time.timing);
    let attempts = 0;
    const raw = createGithubTransport("fake", c, async () => { throw new Error("401"); }, async () => {
      attempts++;
      return new Response("secondary rate limit", { status: 429, headers: { "retry-after": "2" } });
    });
    expect((await raw("/test")).status).toBe(429);
    expect(attempts).toBe(6);
    expect(time.sleeps).toEqual([2000, 2000, 2000, 2000, 2000]);
    expect(c.concurrency).toBe(1);
  });

  it("does not retry permission errors and invokes reconnect handling for 401", async () => {
    const time = clock();
    let calls = 0;
    const raw = createGithubTransport("fake", new GithubAdaptiveController(time.timing), async () => {
      throw new Error("reconnect");
    }, async () => { calls++; return new Response("Forbidden", { status: 403 }); });
    expect((await raw("/test")).status).toBe(403);
    expect(calls).toBe(1);
    const expired = createGithubTransport("fake", new GithubAdaptiveController(time.timing), async () => {
      throw new Error("reconnect");
    }, async () => new Response("", { status: 401 }));
    await expect(expired("/test")).rejects.toThrow("reconnect");
  });

  it("slows before primary quota exhaustion", () => {
    const c = new GithubAdaptiveController(clock().timing);
    c.observe(new Headers({ "x-ratelimit-remaining": "20" }));
    expect(c.concurrency).toBe(1);
    expect(c.pauseMs).toBe(1000);
  });

  it("copies every path exactly once when width changes and preserves base64", async () => {
    const time = clock();
    const c = new GithubAdaptiveController(time.timing);
    const paths = Array.from({ length: 27 }, (_, i) => `file-${i}`);
    const fixtures = new Map(paths.map((p) => {
      const content = Buffer.from(p).toString("base64");
      return [blobSha(content), content];
    }));
    const entries = new Map(paths.map((p) => [p, { sha: blobSha(Buffer.from(p).toString("base64")) }]));
    const reads: string[] = [];
    const writes: string[] = [];
    const src = { json: async <T>(path: string): Promise<T> => {
      const sha = path.split("/").at(-1) ?? "";
      reads.push(sha);
      if (reads.length === 8) c.limited(0);
      return { sha, content: fixtures.get(sha), encoding: "base64" } as T;
    } };
    const tgt = { json: async <T>(_path: string, init?: { body?: unknown }): Promise<T> => {
      const body = init?.body as { content: string; encoding: string };
      expect(body.encoding).toBe("base64");
      writes.push(Buffer.from(body.content, "base64").toString());
      return { sha: blobSha(body.content) } as T;
    } };
    const copied = await copyGithubBlobs(paths, entries, "a/source", "b/target", src, tgt, c);
    expect([...copied.keys()].sort()).toEqual([...paths].sort());
    expect(reads).toHaveLength(27);
    expect(writes).toHaveLength(27);
    expect(new Set(writes).size).toBe(27);
  });

  it("rejects mismatched target content before returning publishable results", async () => {
    const expected = blobSha("AAEC/w==");
    const src = { json: async <T>(): Promise<T> => ({ sha: expected, content: "AAEC/w==", encoding: "base64" }) as T };
    const tgt = { json: async <T>(): Promise<T> => ({ sha: "wrong" }) as T };
    await expect(copyGithubBlobs(["binary"], new Map([["binary", { sha: expected }]]),
      "a/s", "b/t", src, tgt, new GithubAdaptiveController(clock().timing))).rejects.toThrow("غير مطابق");
  });

  it("rejects invalid source content without writing it", async () => {
    let writes = 0;
    const src = { json: async <T>(): Promise<T> => ({ sha: "wrong", content: "AA==", encoding: "base64" }) as T };
    const tgt = { json: async <T>(): Promise<T> => { writes++; return { sha: "expected" } as T; } };
    await expect(copyGithubBlobs(["x"], new Map([["x", { sha: "expected" }]]),
      "a/s", "b/t", src, tgt, new GithubAdaptiveController(clock().timing))).rejects.toThrow("الملف المصدر");
    expect(writes).toBe(0);
  });

  it("independently verifies binary bytes even when the reported SHA looks valid", async () => {
    const expected = blobSha("AAEC/w==");
    expect(await verifyGithubBlob("AAEC\n/w==\n", expected)).toBe(true);
    expect(await verifyGithubBlob("AAED/w==", expected)).toBe(false);
    let writes = 0;
    const src = { json: async <T>(): Promise<T> => ({ sha: expected, content: "AAED/w==", encoding: "base64" }) as T };
    const tgt = { json: async <T>(): Promise<T> => { writes++; return { sha: expected } as T; } };
    await expect(copyGithubBlobs(["binary"], new Map([["binary", { sha: expected }]]),
      "a/s", "b/t", src, tgt, new GithubAdaptiveController(clock().timing))).rejects.toThrow("بصمته");
    expect(writes).toBe(0);
  });

  it("completes a binary transfer through both backend HTTP clients", async () => {
    const content = "AAEC/w==";
    const sha = blobSha(content);
    const time = clock();
    const c = new GithubAdaptiveController(time.timing);
    const calls: Array<{ url: string; method: string }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { content: string; encoding: string };
        expect(body).toEqual({ content, encoding: "base64" });
        return Response.json({ sha: blobSha(body.content) });
      }
      return Response.json({ sha, content, encoding: "base64" });
    };
    const unauthorized = async (): Promise<never> => { throw new Error("401"); };
    function client(token: string) {
      const raw = createGithubTransport(token, c, unauthorized, fetcher);
      return { json: async <T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> =>
        (await raw(path, init)).json() as Promise<T> };
    }
    const result = await copyGithubBlobs(["asset.bin"], new Map([["asset.bin", { sha }]]),
      "source/repo", "target/repo", client("fake-src"), client("fake-tgt"), c);
    expect(result.get("asset.bin")).toBe(sha);
    expect(calls).toEqual([
      { url: `https://api.github.com/repos/source/repo/git/blobs/${sha}`, method: "GET" },
      { url: "https://api.github.com/repos/target/repo/git/blobs", method: "POST" },
    ]);
  });

  it("drains successful in-flight writes before reporting a failed batch", async () => {
    const sha = blobSha("AA==");
    let finished = false;
    let release = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const src = { json: async <T>(path: string): Promise<T> => {
      if (path.endsWith("missing")) throw new Error("missing source");
      return { sha, content: "AA==", encoding: "base64" } as T;
    } };
    const tgt = { json: async <T>(): Promise<T> => {
      await blocked;
      finished = true;
      return { sha } as T;
    } };
    let returned = false;
    const pending = copyGithubBlobs(["bad", "good"], new Map([
      ["bad", { sha: "missing" }], ["good", { sha }],
    ]), "a/s", "b/t", src, tgt, new GithubAdaptiveController(clock().timing))
      .catch((error: unknown) => { returned = true; return error; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(returned).toBe(false);
    release();
    expect(await pending).toBeInstanceOf(Error);
    expect(finished).toBe(true);
  });
});