import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

export function parseGithubRepository(value: string | undefined): string | null {
  if (!value) return null;
  const text = value.trim();
  const fullName = /^[\w.-]+\/[\w.-]+$/;
  if (fullName.test(text)) return text.replace(/\.git$/, "");
  const ssh = /^git@github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?$/i.exec(text);
  if (ssh?.[1]) return ssh[1];
  try {
    const url = new URL(text);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const path = url.pathname.replace(/^\/|\/$/g, "").replace(/\.git$/, "");
    return fullName.test(path) ? path : null;
  } catch {
    return null;
  }
}

/** Build-time only: never ship Git access or credentials into the application. */
export function detectRepository(env: Record<string, string | undefined> = process.env): string | null {
  // Hosting providers supply these for the checkout being built.
  const vercel = env['VERCEL_GIT_REPO_OWNER'] && env['VERCEL_GIT_REPO_SLUG']
    ? `${env['VERCEL_GIT_REPO_OWNER']}/${env['VERCEL_GIT_REPO_SLUG']}` : undefined;
  for (const candidate of [env['GITHUB_REPOSITORY'], vercel, env['REPOSITORY_URL'], env['CF_PAGES_REPOSITORY_URL']]) {
    const repository = parseGithubRepository(candidate);
    if (repository) return repository;
  }
  try {
    // Capture, never print, remote URLs: they may contain embedded credentials.
    const remotes = execFileSync("git", ["remote"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split(/\s+/).filter(Boolean);
    const ordered = ["origin", ...remotes.filter((remote) => remote !== "origin")];
    for (const remote of ordered) {
      const url = execFileSync("git", ["remote", "get-url", remote], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
      const repository = parseGithubRepository(url);
      if (repository) return repository;
    }
  } catch {
    // A ZIP checkout or isolated build can have no Git metadata.
  }
  return detectFromSyncHistory();
}

/** Lovable's Git sync records "Sync from owner/repo" commits; the newest one names the current repository. */
export function parseSyncCommitSubject(subject: string): string | null {
  const match = /^Sync from ([\w.-]+\/[\w.-]+)\b/.exec(subject.trim());
  return match?.[1] ? parseGithubRepository(match[1]) : null;
}

function detectFromSyncHistory(): string | null {
  try {
    const subjects = execFileSync("git", ["log", "-n", "200", "--format=%s", "--grep=^Sync from "], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).split("\n");
    for (const subject of subjects) {
      const repository = parseSyncCommitSubject(subject);
      if (repository) return repository;
    }
  } catch {
    // No Git history available.
  }
  return null;
}
/**
 * Publishing builds can run without Git metadata, so the last automatically detected identity
 * is cached in a source file that syncs with the code. Fresh detection always wins and refreshes it.
 */
export function resolveRepository(cacheFile: string, detected: string | null = detectRepository()): string | null {
  let cached: string | null = null;
  try {
    cached = parseGithubRepository(JSON.parse(readFileSync(cacheFile, "utf8")).repository);
  } catch {
    // No cache yet.
  }
  if (detected && detected !== cached) {
    try {
      writeFileSync(cacheFile, JSON.stringify({ repository: detected }, null, 2) + "\n");
    } catch {
      // Read-only checkout: still use the fresh value.
    }
  }
  return detected ?? cached;
}
