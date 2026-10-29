import { Buffer } from "node:buffer";

type RequestInitData = { method?: string; body?: unknown };
type Timing = { now: () => number; sleep: (ms: number) => Promise<void> };

const defaultTiming: Timing = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** One controller per transfer; both accounts share cooldown and write pacing. */
export class GithubAdaptiveController {
  concurrency = 3;
  pauseMs = 100;
  private healthyBatches = 0;
  private generation = 0;
  private cooldownUntil = 0;
  private writeTail: Promise<void> = Promise.resolve();
  private lastWriteAt = -Infinity;

  constructor(private timing: Timing = defaultTiming) {}

  now() { return this.timing.now(); }
  snapshot() { return this.generation; }

  async wait() {
    while (this.cooldownUntil > this.now()) {
      await this.timing.sleep(this.cooldownUntil - this.now());
    }
  }

  async beforeRequest(method: string) {
    if (method === "GET" || method === "HEAD") return this.wait();
    const previous = this.writeTail;
    let release = () => {};
    this.writeTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await this.wait();
      const delay = this.lastWriteAt + 1000 - this.now();
      if (delay > 0) await this.timing.sleep(delay);
      await this.wait();
      this.lastWriteAt = this.now();
    } finally {
      release();
    }
  }

  limited(waitMs: number) {
    this.generation += 1;
    this.healthyBatches = 0;
    this.concurrency = Math.max(1, Math.floor(this.concurrency / 2));
    this.pauseMs = Math.min(2000, Math.max(500, this.pauseMs * 2));
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + waitMs);
  }

  observe(headers: Headers) {
    const rawRemaining = headers.get("x-ratelimit-remaining");
    if (rawRemaining === null) return;
    const remaining = Number(rawRemaining);
    if (!Number.isFinite(remaining) || remaining > 20) return;
    if (remaining === 0) {
      const reset = Number(headers.get("x-ratelimit-reset")) * 1000;
      this.limited(Math.max(1000, reset - this.now()));
    } else {
      this.generation += 1;
      this.healthyBatches = 0;
      this.concurrency = 1;
      this.pauseMs = Math.max(1000, this.pauseMs);
    }
  }

  async batchCompleted(generation: number, hasMore: boolean) {
    if (generation === this.generation) {
      this.healthyBatches += 1;
      if (this.healthyBatches >= 3) {
        this.concurrency = Math.min(6, this.concurrency + 1);
        this.pauseMs = Math.max(0, this.pauseMs - 100);
        this.healthyBatches = 0;
      }
    }
    if (hasMore && this.pauseMs > 0) await this.timing.sleep(this.pauseMs);
  }
}

export function isGithubRateLimit(status: number, body: string, headers?: Headers) {
  if (status === 429) return true;
  if (status !== 403) return false;
  return headers?.get("x-ratelimit-remaining") === "0" ||
    /secondary rate limit|abuse detection|you have exceeded|api rate limit exceeded/i.test(body);
}

export function githubRetryDelay(headers: Headers, attempt: number, now: number) {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date) && date > now) return date - now;
  }
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset")) * 1000;
    if (reset > now) return reset - now + 1000;
  }
  return Math.min(90_000, 60_000 * 2 ** attempt);
}

export function createGithubTransport(
  token: string,
  controller: GithubAdaptiveController,
  unauthorized: () => Promise<never>,
  fetcher: typeof fetch = fetch,
) {
  return async (path: string, init?: RequestInitData): Promise<Response> => {
    const method = init?.method ?? "GET";
    for (let attempt = 0; ; attempt += 1) {
      await controller.beforeRequest(method);
      // Recheck after the write queue releases: another response may have limited us.
      await controller.wait();
      const response = await fetcher(`https://api.github.com${path.startsWith("/") ? path : `/${path}`}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "repo-transfer-app",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
      });
      if (response.status === 401) return unauthorized();
      if (response.status === 403 || response.status === 429) {
        const text = await response.clone().text();
        if (isGithubRateLimit(response.status, text, response.headers)) {
          controller.limited(githubRetryDelay(response.headers, attempt, controller.now()));
          if (attempt < 5) {
            await response.body?.cancel();
            continue;
          }
        }
      } else if (response.ok) {
        controller.observe(response.headers);
      }
      return response;
    }
  };
}

type BlobClient = {
  json: <T>(path: string, init?: RequestInitData) => Promise<T>;
};

export async function verifyGithubBlob(content: string, expectedSha: string) {
  const bytes = Buffer.from(content.replace(/\s/g, ""), "base64");
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const object = new Uint8Array(header.byteLength + bytes.byteLength);
  object.set(header);
  object.set(bytes, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", object);
  const sha = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return sha === expectedSha;
}

/** No tree/commit can be created by the caller until every batch is verified. */
export async function copyGithubBlobs(
  paths: string[],
  entries: Map<string, { sha: string }>,
  source: string,
  target: string,
  src: BlobClient,
  tgt: BlobClient,
  controller: GithubAdaptiveController,
) {
  const copied = new Map<string, string>();
  for (let index = 0; index < paths.length;) {
    const generation = controller.snapshot();
    const chunk = paths.slice(index, index + controller.concurrency);
    const results = await Promise.allSettled(chunk.map(async (path) => {
      const entry = entries.get(path);
      if (!entry) throw new Error(`تعذر العثور على الملف المصدر: ${path}`);
      const blob = await src.json<{ content: string; encoding: string; sha: string }>(
        `/repos/${source}/git/blobs/${entry.sha}`,
      );
      if (blob.sha !== entry.sha || blob.encoding !== "base64" || typeof blob.content !== "string") {
        throw new Error(`تعذر التحقق من محتوى الملف المصدر: ${path}`);
      }
      if (!await verifyGithubBlob(blob.content, entry.sha)) {
        throw new Error(`محتوى الملف المصدر لا يطابق بصمته: ${path}`);
      }
      const created = await tgt.json<{ sha: string }>(`/repos/${target}/git/blobs`, {
        method: "POST", body: { content: blob.content, encoding: "base64" },
      });
      if (created.sha !== entry.sha) throw new Error(`محتوى الملف المنقول غير مطابق للمصدر: ${path}`);
      copied.set(path, created.sha);
    }));
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    index += chunk.length;
    await controller.batchCompleted(generation, index < paths.length);
  }
  return copied;
}