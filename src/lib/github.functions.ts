import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const GITHUB_API = "https://api.github.com";
const LOVABLE_DIR = ".lovable/";


type Slot = "source" | "target";

export type RepoInfo = {
  fullName: string;
  name: string;
  isPrivate: boolean;
  defaultBranch: string;
  canPush: boolean;
  createdAt: string;
  description: string | null;
};

export type TransferSummary = {
  dryRun: boolean;
  source: string;
  target: string;
  sourceBranch: string;
  targetBranch: string;
  added: string[];
  updated: string[];
  deleted: string[];
  preservedLovable: string[];
  skipped: string[];
  unchanged: number;
  committed: boolean;
  commitSha: string | null;
  targetUrl: string | null;
};

type GhTreeEntry = {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
};

const SLOT_LABEL: Record<Slot, string> = {
  source: "حساب المصدر",
  target: "حساب الهدف",
};

/** عميل GitHub مرتبط بحساب المستخدم في خانة معيّنة. */
async function makeClient(userId: string, slot: Slot) {
  const { getConnectionKeyForUser, markReconnectRequired } = await import(
    "@/lib/appUserConnections.server"
  );
  const accessToken = await getConnectionKeyForUser(userId, slot);
  if (!accessToken) {
    throw new Error(`${SLOT_LABEL[slot]} غير مربوط. اربط الحساب أولًا من الصفحة الرئيسية.`);
  }
  const token = accessToken;

  async function raw(path: string, init?: { method?: string; body?: unknown }) {
    const res = await fetch(`${GITHUB_API}${path.startsWith("/") ? path : `/${path}`}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "repo-transfer-app",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    });
    if (res.status === 401) {
      await markReconnectRequired(userId, slot);
      throw new Error(
        `انتهت صلاحية ربط ${SLOT_LABEL[slot]}. أعد ربط الحساب ثم حاول مرة أخرى.`,
      );
    }
    return res;
  }


  async function json<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const res = await raw(path, init);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`فشل طلب GitHub لـ${SLOT_LABEL[slot]} (${res.status}): ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  return { raw, json, label: SLOT_LABEL[slot] };
}

type GhClient = Awaited<ReturnType<typeof makeClient>>;

async function getRepoOrThrow(client: GhClient, full: string) {
  try {
    return await client.json<Record<string, unknown>>(`/repos/${full}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("(404")) {
      throw new Error(
        `تعذر الوصول إلى المستودع (${full}) عبر ${client.label}. تأكد من الاسم (owner/repo) ومن أن هذا الحساب يملك صلاحية الوصول إليه.`,
      );
    }
    throw e;
  }
}

async function listReposFor(client: GhClient): Promise<RepoInfo[]> {
  const repos: RepoInfo[] = [];
  for (let page = 1; page <= 5; page++) {
    const data = await client.json<Array<Record<string, unknown>>>(
      `/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member&page=${page}`,
    );
    for (const r of data) {
      const fullName = String(r['full_name']);
      repos.push({
        fullName,
        name: fullName.includes("/") ? fullName.slice(fullName.lastIndexOf("/") + 1) : fullName,
        isPrivate: Boolean(r['private']),
        defaultBranch: String(r['default_branch'] ?? "main"),
        canPush: Boolean((r['permissions'] as Record<string, boolean> | undefined)?.['push']),
        createdAt: String(r['created_at'] ?? ""),
        description: (r['description'] as string | null) ?? null,
      });
    }
    if (data.length < 100) break;
  }
  // الأحدث إنشاءً أولًا — وليس الأحدث تحديثًا.
  repos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return repos;
}

/** مستودعات الحساب المرتبط بخانة معيّنة. */
export const listRepos = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data) => z.object({ slot: z.enum(["source", "target"]) }).parse(data))
  .handler(async ({ data, context }): Promise<RepoInfo[]> => {
    const client = await makeClient(context.userId, data.slot);
    return listReposFor(client);
  });

const transferInput = z.object({
  source: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "صيغة المستودع: owner/repo"),
  target: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "صيغة المستودع: owner/repo"),
  message: z.string().max(300).optional(),
  dryRun: z.boolean().optional(),
  confirmDelete: z.boolean().optional(),
  sameAccount: z.boolean().optional(),
});

export const transferRepo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data) => transferInput.parse(data))
  .handler(async ({ data, context }): Promise<TransferSummary> => {
    const source = data.source;
    const target = data.target;
    const dryRun = data.dryRun ?? false;

    const src = await makeClient(context.userId, "source");
    const sameAccount = data.sameAccount ?? false;
    // داخل نفس الحساب: يُستخدم حساب المصدر للقراءة والكتابة معًا.
    const tgt = sameAccount ? src : await makeClient(context.userId, "target");

    const [sourceAccount, targetAccount] = await Promise.all([
      src.json<{ id: number }>("/user"),
      sameAccount ? Promise.resolve({ id: -1 }) : tgt.json<{ id: number }>("/user"),
    ]);
    if (!sameAccount && sourceAccount.id === targetAccount.id) {
      throw new Error("اربط حسابَي GitHub مختلفين للمصدر والهدف قبل بدء النقل.");
    }

    // ---- Source repo & tree ----
    const srcRepo = await getRepoOrThrow(src, source);
    const srcBranch = String(srcRepo['default_branch'] ?? "main");
    let srcTree: { tree: GhTreeEntry[]; truncated: boolean };
    try {
      srcTree = await src.json<{ tree: GhTreeEntry[]; truncated: boolean }>(
        `/repos/${source}/git/trees/${encodeURIComponent(srcBranch)}?recursive=1`,
      );
    } catch {
      throw new Error("المستودع المصدر فارغ أو لا يحتوي على فرع افتراضي — لا يوجد ما يُنقل.");
    }
    if (srcTree.truncated) {
      throw new Error(
        "المستودع المصدر أكبر من أن يُقرأ دفعة واحدة عبر واجهة GitHub. جرّب مستودعًا أصغر.",
      );
    }

    // ---- Target repo, branch head & tree ----
    const tgtRepo = await getRepoOrThrow(tgt, target);
    if (
      String(srcRepo['full_name']).toLowerCase() === String(tgtRepo['full_name']).toLowerCase()
    ) {
      throw new Error("المستودع المصدر والهدف متطابقان — اختر مستودعين مختلفين.");
    }
    if (!(tgtRepo['permissions'] as Record<string, boolean> | undefined)?.['push']) {
      throw new Error(
        `حساب الهدف لا يملك صلاحية الكتابة على المستودع (${target}). اختر مستودعًا يملكه هذا الحساب.`,
      );
    }
    let tgtBranch = String(tgtRepo['default_branch'] ?? "main");

    let tgtHeadSha: string | null = null;
    const readRef = async (branch: string) =>
      tgt.raw(`/repos/${target}/git/ref/heads/${encodeURIComponent(branch)}`);

    let refRes = await readRef(tgtBranch);
    if (!refRes.ok) {
      // الفرع الافتراضي غير مقروء: قد يكون المستودع فارغًا فعلًا، أو الاسم مختلف.
      const branchesRes = await tgt.raw(`/repos/${target}/branches?per_page=100`);
      const branches = branchesRes.ok
        ? ((await branchesRes.json()) as Array<{ name: string; commit: { sha: string } }>)
        : [];
      if (branches.length > 0) {
        const pick =
          branches.find((b) => b.name === tgtBranch) ??
          branches.find((b) => b.name === srcBranch) ??
          branches.find((b) => b.name === "main" || b.name === "master") ??
          branches[0]!;
        tgtBranch = pick.name;
        refRes = await readRef(tgtBranch);
        if (!refRes.ok) {
          throw new Error(
            `تعذر قراءة الفرع ${tgtBranch} في المستودع الهدف (${refRes.status}). تأكد من صلاحيات حساب الهدف.`,
          );
        }
      } else if (refRes.status !== 404 && refRes.status !== 409) {
        throw new Error(`تعذر قراءة الفرع ${tgtBranch} في المستودع الهدف (${refRes.status}).`);
      }
    }
    if (refRes.ok) {
      const ref = (await refRes.json()) as { object: { sha: string } };
      tgtHeadSha = ref.object.sha;
    }

    // ---- النقل يتم مباشرة على الفرع الافتراضي للهدف (الذي يقرؤه Lovable وGitHub) ----
    const baseBranch = tgtBranch;

    let tgtEntries: GhTreeEntry[] = [];
    let tgtTreeSha: string | null = null;
    if (tgtHeadSha) {
      const tgtTree = await tgt.json<{
        tree: GhTreeEntry[];
        truncated: boolean;
        sha: string;
      }>(`/repos/${target}/git/trees/${tgtHeadSha}?recursive=1`);
      if (tgtTree.truncated) {
        throw new Error("المستودع الهدف أكبر من أن يُقرأ دفعة واحدة عبر واجهة GitHub.");
      }
      tgtEntries = tgtTree.tree;
      tgtTreeSha = tgtTree.sha;
    }

    // ---- Build the diff maps ----
    const skipped: string[] = [];
    const srcBlobs = new Map<string, GhTreeEntry>();
    for (const e of srcTree.tree) {
      if (e.type === "commit") {
        skipped.push(`${e.path} (submodule)`);
        continue;
      }
      if (e.type !== "blob") continue;
      // The source repo's own Lovable link metadata never overwrites the target's.
      if (e.path.startsWith(LOVABLE_DIR)) continue;
      srcBlobs.set(e.path, e);
    }

    const tgtBlobs = new Map<string, GhTreeEntry>();
    for (const e of tgtEntries) {
      if (e.type !== "blob") continue;
      tgtBlobs.set(e.path, e);
    }

    const added: string[] = [];
    const updated: string[] = [];
    const unchangedPaths: string[] = [];
    for (const [path, entry] of srcBlobs) {
      const existing = tgtBlobs.get(path);
      if (!existing) added.push(path);
      else if (existing.sha !== entry.sha) updated.push(path);
      else unchangedPaths.push(path);
    }

    const deleted: string[] = [];
    const preservedLovable: string[] = [];
    for (const path of tgtBlobs.keys()) {
      if (path.startsWith(LOVABLE_DIR)) {
        preservedLovable.push(path);
        continue;
      }
      if (!srcBlobs.has(path)) deleted.push(path);
    }

    const changedPaths = [...added, ...updated];

    // ---- Identical repos: nothing to do ----
    if (changedPaths.length === 0 && deleted.length === 0) {
      return {
        dryRun,
        source,
        target,
        sourceBranch: srcBranch,
        targetBranch: tgtBranch,
        added: [],
        updated: [],
        deleted: [],
        preservedLovable,
        skipped,
        unchanged: unchangedPaths.length + preservedLovable.length,
        committed: false,
        commitSha: null,
        targetUrl: (tgtRepo['html_url'] as string | null) ?? null,
      };
    }

    if (dryRun) {
      return {
        dryRun,
        source,
        target,
        sourceBranch: srcBranch,
        targetBranch: tgtBranch,
        added,
        updated,
        deleted,
        preservedLovable,
        skipped,
        unchanged: unchangedPaths.length,
        committed: false,
        commitSha: null,
        targetUrl: (tgtRepo['html_url'] as string | null) ?? null,
      };
    }

    if (deleted.length > 0 && !data.confirmDelete) {
      throw new Error(
        `سيحذف النقل ${deleted.length} ملفًا زائدًا من المستودع الهدف. فعّل تأكيد الحذف ثم أعد المحاولة.`,
      );
    }

    // ---- Empty target repo: GitHub rejects blob/tree writes until a first commit exists ----
    const bootstrapPath = ".lovable-transfer-init";
    let bootstrapCreated = false;
    if (!tgtHeadSha) {
      const initRes = await tgt.raw(
        `/repos/${target}/contents/${encodeURIComponent(bootstrapPath)}`,
        {
          method: "PUT",
          body: {
            message: "Initialize repository",
            content: Buffer.from("init\n", "utf8").toString("base64"),
            branch: baseBranch,
          },
        },
      );
      if (!initRes.ok) {
        const body = await initRes.text();
        throw new Error(
          `تعذر تهيئة المستودع الهدف الفارغ (${initRes.status}). ${body.slice(0, 200)}`,
        );
      }
      const init = (await initRes.json()) as { commit: { sha: string; tree?: { sha: string } } };
      tgtHeadSha = init.commit.sha;
      tgtTreeSha = init.commit.tree?.sha ?? null;
      bootstrapCreated = true;
    }

    // ---- Copy changed blobs: read from source account, write to target account ----
    const newShaByPath = new Map<string, string>();

    for (let i = 0; i < changedPaths.length; i += 6) {
      const chunk = changedPaths.slice(i, i + 6);
      await Promise.all(
        chunk.map(async (p) => {
          const entry = srcBlobs.get(p);
          if (!entry) throw new Error(`تعذر العثور على الملف المصدر: ${p}`);
          const blob = await src.json<{ content: string }>(
            `/repos/${source}/git/blobs/${entry.sha}`,
          );
          const created = await tgt.json<{ sha: string }>(`/repos/${target}/git/blobs`, {
            method: "POST",
            body: { content: blob.content, encoding: "base64" },
          });
          newShaByPath.set(p, created.sha);
        }),
      );
    }

    // ---- Assemble the new tree ----
    const treeEntries: Array<{
      path: string;
      mode: string;
      type: "blob";
      sha: string | null;
    }> = [];
    for (const [path, entry] of srcBlobs) {
      treeEntries.push({
        path,
        mode: entry.mode,
        type: "blob",
        sha: newShaByPath.get(path) ?? entry.sha,
      });
    }
    // Preserve the target's own Lovable link metadata verbatim.
    for (const [path, entry] of tgtBlobs) {
      if (path.startsWith(LOVABLE_DIR)) {
        treeEntries.push({ path, mode: entry.mode, type: "blob", sha: entry.sha });
      }
    }
    // Git's base_tree keeps omitted entries, so deletions must be explicit.
    for (const path of deleted) {
      treeEntries.push({ path, mode: "100644", type: "blob", sha: null });
    }
    // ملف التهيئة المؤقت ليس له نظير في المصدر، فيُحذف من الفرع.
    if (bootstrapCreated && !srcBlobs.has(bootstrapPath)) {
      treeEntries.push({ path: bootstrapPath, mode: "100644", type: "blob", sha: null });
    }

    const newTree = await tgt.json<{ sha: string }>(`/repos/${target}/git/trees`, {
      method: "POST",
      body: {
        ...(tgtTreeSha ? { base_tree: tgtTreeSha } : {}),
        tree: treeEntries,
      },
    });

    const commitMessage =
      data.message?.trim() || `Sync from ${source} (${new Date().toISOString()})`;

    const commit = await tgt.json<{ sha: string }>(`/repos/${target}/git/commits`, {
      method: "POST",
      body: {
        message: commitMessage,
        tree: newTree.sha,
        parents: tgtHeadSha ? [tgtHeadSha] : [],
      },
    });

    // الفرع موجود دائمًا هنا (إما أصلًا أو بعد التهيئة)، فنحدّثه للالتزام الجديد.
    await tgt.json(`/repos/${target}/git/refs/heads/${encodeURIComponent(tgtBranch)}`, {
      method: "PATCH",
      body: { sha: commit.sha, force: false },
    });

    return {
      dryRun,
      source,
      target,
      sourceBranch: srcBranch,
      targetBranch: tgtBranch,
      added,
      updated,
      deleted,
      preservedLovable,
      skipped,
      unchanged: unchangedPaths.length,
      committed: true,
      commitSha: commit.sha,
      targetUrl: (tgtRepo['html_url'] as string | null) ?? null,
    };
  });
