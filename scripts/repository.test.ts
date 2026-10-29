import { describe, expect, it } from "vitest";
import { parseGithubRepository } from "./repository";

describe("automatic repository identity", () => {
  it("uses the current repository rather than a fixed app name", () => {
    expect(parseGithubRepository("https://github.com/owner/first.git")).toBe("owner/first");
    expect(parseGithubRepository("https://github.com/other/second.git")).toBe("other/second");
  });
  it("handles GitHub Actions, HTTPS and SSH identities", () => {
    expect(parseGithubRepository("owner/repo")).toBe("owner/repo");
    expect(parseGithubRepository("git@github.com:owner/repo.git")).toBe("owner/repo");
    expect(parseGithubRepository("ssh://git@github.com/owner/repo.git")).toBe("owner/repo");
  });
  it("never includes credentials or mistakes internal storage for GitHub", () => {
    expect(parseGithubRepository("https://user:fake-password@github.com/owner/repo.git")).toBe("owner/repo");
    expect(parseGithubRepository("https://internal.invalid/project-id.git")).toBeNull();
    expect(parseGithubRepository(undefined)).toBeNull();
  });
});
import { parseSyncCommitSubject } from "./repository";
describe("Lovable sync history", () => {
  it("reads the repository from sync commits", () => {
    expect(parseSyncCommitSubject("Sync from owner/my-app (2026-10-29T15:29:22.726Z)")).toBe("owner/my-app");
    expect(parseSyncCommitSubject("Add project README")).toBeNull();
  });
});

import { mkdtempSync, readFileSync as readCache, writeFileSync as writeCache } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRepository } from "./repository";
describe("publishing without Git history", () => {
  it("uses the saved name when nothing can be detected, and refreshes it when the repo moves", () => {
    const file = join(mkdtempSync(join(tmpdir(), "repo-")), "repository.json");
    writeCache(file, JSON.stringify({ repository: "owner/old" }));
    expect(resolveRepository(file, null)).toBe("owner/old");
    expect(resolveRepository(file, "owner/new")).toBe("owner/new");
    expect(JSON.parse(readCache(file, "utf8")).repository).toBe("owner/new");
  });
});
