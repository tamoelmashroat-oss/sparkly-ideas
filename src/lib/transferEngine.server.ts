// Server-only background transfer engine.
// Each call to `advanceJob` does a bounded slice of work and saves its
// position (cursor) so the next call — from any browser tab or the public
// tick endpoint — resumes exactly where it stopped.
import { encryptConnectionKey, decryptConnectionKey } from "@/lib/connectionKeyCrypto.server";

const API = "https://api.supabase.com/v1";
const SLICE_MS = 20_000;
const LOCK_MS = 60_000;
const CHUNK = 200;
const FILE_BATCH = 10;
const USER_BATCH = 100;
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_LOG = 400;

type Row = Record<string, unknown>;
export type JobKind = "db" | "storage" | "auth";
export type Tokens = { source: string; target: string };

/* ----------------------------- Management API ----------------------------- */

async function mgmt<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  let res!: Response;
  for (let attempt = 0; attempt < 6; attempt++) {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (res.status !== 429 && res.status !== 503) break;
    const ra = Number(res.headers.get("retry-after"));
    await new Promise((r) => setTimeout(r, ra > 0 ? ra * 1000 : 1500 * 2 ** attempt));
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const p = JSON.parse(text) as { message?: string; error?: string };
      msg = p.message ?? p.error ?? text;
    } catch {
      /* raw */
    }
    if (res.status === 401 || res.status === 403)
      throw new Error("رمز الوصول غير صالح أو انتهت صلاحيته.");
    throw new Error(`فشل الطلب (${res.status}): ${msg.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

async function runSql(token: string, ref: string, query: string): Promise<Row[]> {
  const out = await mgmt<Row[] | null>(token, `/projects/${ref}/database/query`, {
    method: "POST",
    body: JSON.stringify({ query }),
  });
  return Array.isArray(out) ? out : [];
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const ident = (n: string) => `"${n.replace(/"/g, '""')}"`;

async function stmts(token: string, ref: string, q: string): Promise<string[]> {
  return (await runSql(token, ref, q)).map((r) => str(r["stmt"])).filter((s) => s.trim());
}

/* ------------------------------- SQL queries ------------------------------ */

const Q_SEQUENCES = `select 'create sequence if not exists public.' || quote_ident(c.relname) || ';' as stmt
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'S' order by c.relname`;
const Q_ENUMS = `select 'create type public.' || quote_ident(t.typname) || ' as enum ('
  || string_agg(quote_literal(e.enumlabel), ', ' order by e.enumsortorder) || ');' as stmt
from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
where n.nspname = 'public' group by t.typname order by t.typname`;
const Q_FUNCTIONS = `select pg_get_functiondef(p.oid) || ';' as stmt
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind in ('f','p') order by p.proname`;
const Q_TABLES = `select 'create table if not exists public.' || quote_ident(c.relname) || ' (' || string_agg(
  quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod)
  || case when a.attgenerated = 's' then ' generated always as (' || pg_get_expr(d.adbin, d.adrelid) || ') stored'
          when pg_get_expr(d.adbin, d.adrelid) is not null then ' default ' || pg_get_expr(d.adbin, d.adrelid)
          else '' end
  || case when a.attnotnull then ' not null' else '' end, ', ' order by a.attnum) || ');' as stmt
from pg_class c join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
where n.nspname = 'public' and c.relkind = 'r' group by c.relname order by c.relname`;
const constraintsQuery = (types: string) => `select 'alter table public.' || quote_ident(c.relname) || ' add constraint '
  || quote_ident(k.conname) || ' ' || pg_get_constraintdef(k.oid) || ';' as stmt
from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and k.contype in (${types}) order by k.contype, k.conname`;
const Q_INDEXES = `select indexdef || ';' as stmt from pg_indexes i where schemaname = 'public'
  and not exists (select 1 from pg_constraint k join pg_namespace n on n.oid = k.connamespace
    where n.nspname = 'public' and k.conname = i.indexname) order by indexname`;
const Q_VIEWS = `select 'create or replace view public.' || quote_ident(viewname) || ' as ' || definition as stmt
from pg_views where schemaname = 'public' order by viewname`;
const Q_TRIGGERS = `select pg_get_triggerdef(t.oid) || ';' as stmt from pg_trigger t
join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and not t.tgisinternal order by t.tgname`;
const Q_RLS = `select 'alter table public.' || quote_ident(tablename) || ' enable row level security;' as stmt
from pg_tables where schemaname = 'public' and rowsecurity order by tablename`;
const Q_POLICIES = `select 'create policy ' || quote_ident(policyname) || ' on public.' || quote_ident(tablename)
  || ' as ' || permissive || ' for ' || cmd || ' to ' || array_to_string(roles, ', ')
  || coalesce(' using (' || qual || ')', '') || coalesce(' with check (' || with_check || ')', '') || ';' as stmt
from pg_policies where schemaname = 'public' order by tablename, policyname`;
const Q_GRANTS = `select distinct 'grant ' || privilege_type || ' on public.' || quote_ident(table_name)
  || ' to ' || quote_ident(grantee) || ';' as stmt from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon','authenticated','service_role') order by 1`;
const Q_SETVAL = `select 'select setval(' || quote_literal('public.' || quote_ident(sequencename)) || ', '
  || greatest(coalesce(last_value, 1), 1) || ', ' || (last_value is not null) || ');' as stmt
from pg_sequences where schemaname = 'public' order by sequencename`;
const Q_TABLE_ROWS = `select c.relname as name,
  (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', c.relname), false, true, '')))[1]::text::bigint as rows
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' order by c.relname`;
const pubColumns = (table: string) => `select a.attname as name from pg_attribute a
join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = ${lit(table)}
  and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' order by a.attnum`;
const authColumns = (table: string) => `select a.attname as name from pg_attribute a
join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'auth' and c.relname = ${lit(table)}
  and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' order by a.attnum`;

/* --------------------------------- Cursor --------------------------------- */

type StmtRun = {
  list: string[];
  i: number;
  failed: Array<{ s: string; m: string }>;
  pass: number;
  applied: number;
  /** When set, statements before this index run one by one (after a batch failed). */
  solo?: number;
};

const BATCH_STMTS = 80;
const BATCH_BYTES = 300_000;

type Cursor = {
  phase: string;
  // db
  tables?: Array<{ name: string; rows: number }>;
  ti?: number;
  offset?: number;
  run?: StmtRun | null;
  // storage
  buckets?: Array<{ id: string; name: string; objects: number }>;
  bi?: number;
  bucketCopied?: number;
  // auth
  users?: number;
  ids?: number;
};

type Job = {
  id: string;
  kind: JobKind;
  source_ref: string;
  target_ref: string;
  status: string;
  stage: string;
  counting: boolean;
  done: number;
  total: number;
  cursor: Cursor;
  log: string[];
  errors: string[];
  tokens_ciphertext: string | null;
};

class Ctx {
  logAdd: string[] = [];
  errAdd: string[] = [];
  constructor(public job: Job, public tok: Tokens) {}
  log(l: string) {
    this.logAdd.push(l);
  }
  warn(l: string) {
    this.errAdd.push(l);
    this.logAdd.push(`   ⚠ ${l}`);
  }
}

/** Run one statement; a foreign key that existing rows break is added NOT VALID. */
async function runOne(ctx: Ctx, run: StmtRun, s: string) {
  try {
    await runSql(ctx.tok.target, ctx.job.target_ref, s);
    run.applied += 1;
  } catch (e) {
    const m = (e as Error).message;
    if (m.includes("23503") && /foreign key/i.test(s) && !/not valid/i.test(s)) {
      try {
        await runSql(ctx.tok.target, ctx.job.target_ref, s.replace(/;\s*$/, "") + " NOT VALID;");
        run.applied += 1;
        ctx.warn(
          `أُضيفت علاقة بدون فحص الصفوف الحالية (بعض الصفوف تشير لسجلات غير موجودة — غالبًا حسابات مستخدمين لم تُنقل بعد): ${s.slice(0, 140)}`,
        );
        return;
      } catch {
        /* fall through to failure */
      }
    }
    run.failed.push({ s, m });
  }
}

/**
 * Apply some statements of a multi-pass run; returns true when finished.
 * Statements are sent in atomic batches (one request for many statements);
 * if a batch fails, that batch is replayed one statement at a time.
 */
async function stepStatements(ctx: Ctx, run: StmtRun, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (run.i >= run.list.length) {
      const progressed = run.failed.length < run.list.length;
      if (run.failed.length === 0 || !progressed || run.pass >= 4) return true;
      run.list = run.failed.map((f) => f.s);
      run.failed = [];
      run.i = 0;
      run.solo = undefined;
      run.pass += 1;
      continue;
    }
    if (run.solo !== undefined && run.i < run.solo) {
      await runOne(ctx, run, run.list[run.i]!);
      run.i += 1;
      continue;
    }
    run.solo = undefined;
    const batch: string[] = [];
    let bytes = 0;
    for (let j = run.i; j < run.list.length && batch.length < BATCH_STMTS; j++) {
      const s = run.list[j]!;
      if (batch.length > 0 && bytes + s.length > BATCH_BYTES) break;
      batch.push(s);
      bytes += s.length;
    }
    if (batch.length === 1) {
      await runOne(ctx, run, batch[0]!);
      run.i += 1;
      continue;
    }
    // A DO block is all-or-nothing, so a failed batch leaves nothing half-applied.
    const body = batch.map((s) => `execute ${lit(s.trim().replace(/;\s*$/, ""))};`).join("\n");
    try {
      await runSql(ctx.tok.target, ctx.job.target_ref, `do $lovable_batch$ begin\n${body}\nend $lovable_batch$;`);
      run.applied += batch.length;
      run.i += batch.length;
    } catch {
      run.solo = run.i + batch.length;
    }
  }
  return false;
}

function finishRun(ctx: Ctx, run: StmtRun, total: number) {
  ctx.log(`   نُفِّذ ${run.applied} من ${total} أمرًا.`);
  run.failed.slice(0, 20).forEach((f) => ctx.warn(`${f.s.slice(0, 140)} → ${f.m}`));
}

/* ------------------------------- DB transfer ------------------------------ */

async function stepDb(ctx: Ctx, deadline: number): Promise<boolean> {
  const { job, tok } = ctx;
  const c = job.cursor;
  const src = job.source_ref;
  const dst = job.target_ref;

  while (Date.now() < deadline) {
    switch (c.phase) {
      case "start": {
        job.stage = "تجهيز: فحص المصدر…";
        const rows = await runSql(tok.source, src, Q_TABLE_ROWS);
        c.tables = rows
          .map((r) => ({ name: str(r["name"]), rows: Number(r["rows"] ?? 0) }))
          .filter((t) => t.rows > 0);
        job.total = c.tables.reduce((s, t) => s + t.rows, 0);
        c.phase = "reset";
        break;
      }
      case "reset": {
        job.stage = "المرحلة 1 من 4: تفريغ المشروع الهدف…";
        ctx.log("① تفريغ المشروع الهدف…");
        await runSql(
          tok.target,
          dst,
          `drop schema if exists public cascade; create schema public;
           grant usage on schema public to anon, authenticated, service_role;
           grant create on schema public to postgres;`,
        );
        ctx.log("   تم حذف محتوى المخطط public في الهدف.");
        c.phase = "structure";
        c.run = null;
        break;
      }
      case "structure": {
        job.stage = "المرحلة 2 من 4: إنشاء الجداول والدوال…";
        if (!c.run) {
          ctx.log("② إنشاء الأنواع والدوال والجداول…");
          const list: string[] = [];
          for (const q of [Q_SEQUENCES, Q_ENUMS, Q_FUNCTIONS, Q_TABLES, constraintsQuery("'p','u'")])
            list.push(...(await stmts(tok.source, src, q)));
          c.run = { list, i: 0, failed: [], pass: 0, applied: 0 };
          (c as Cursor & { runTotal?: number }).runTotal = list.length;
        }
        if (!(await stepStatements(ctx, c.run, deadline))) return false;
        finishRun(ctx, c.run, (c as Cursor & { runTotal?: number }).runTotal ?? 0);
        c.run = null;
        c.phase = "rows";
        c.ti = 0;
        c.offset = 0;
        ctx.log(`③ نسخ البيانات (${job.total} صفًا في ${c.tables?.length ?? 0} جدولًا)…`);
        break;
      }
      case "rows": {
        const tables = c.tables ?? [];
        const ti = c.ti ?? 0;
        if (ti >= tables.length) {
          c.phase = "extras";
          c.run = null;
          break;
        }
        const t = tables[ti]!;
        job.stage = `المرحلة 3 من 4: نسخ البيانات — ${t.name} (${ti + 1}/${tables.length})`;
        job.counting = true;
        const cols = (await runSql(tok.source, src, pubColumns(t.name))).map((r) => str(r["name"]));
        let copied = 0;
        if (cols.length > 0) {
          const sel = cols.map((col) => `${ident(col)}::text as ${ident(col)}`).join(", ");
          const rows = await runSql(
            tok.source,
            src,
            `select ${sel} from public.${ident(t.name)} order by ctid offset ${c.offset ?? 0} limit ${CHUNK}`,
          );
          copied = rows.length;
          if (rows.length > 0) {
            const values = rows.map(
              (row) =>
                `(${cols.map((col) => (row[col] == null ? "NULL" : lit(String(row[col])))).join(", ")})`,
            );
            const head = `insert into public.${ident(t.name)} (${cols.map(ident).join(", ")}) values `;
            let batch: string[] = [];
            let size = 0;
            for (const v of values) {
              if (size + v.length > 400_000 && batch.length) {
                await runSql(tok.target, dst, `${head}${batch.join(", ")};`);
                batch = [];
                size = 0;
              }
              batch.push(v);
              size += v.length;
            }
            if (batch.length) await runSql(tok.target, dst, `${head}${batch.join(", ")};`);
          }
        }
        c.offset = (c.offset ?? 0) + copied;
        job.done += copied;
        if (copied < CHUNK) {
          ctx.log(`   ${t.name}: ${c.offset} صفًا.`);
          c.ti = ti + 1;
          c.offset = 0;
        }
        break;
      }
      case "extras": {
        job.counting = false;
        job.stage = "المرحلة 4 من 4: العلاقات والفهارس وقواعد الحماية…";
        if (!c.run) {
          ctx.log("④ إضافة العلاقات والفهارس وقواعد الحماية…");
          const list: string[] = [];
          for (const q of [
            constraintsQuery("'f','c','x'"),
            Q_INDEXES,
            Q_VIEWS,
            Q_TRIGGERS,
            Q_RLS,
            Q_POLICIES,
            Q_GRANTS,
            Q_SETVAL,
          ])
            list.push(...(await stmts(tok.source, src, q)));
          c.run = { list, i: 0, failed: [], pass: 0, applied: 0 };
          (c as Cursor & { runTotal?: number }).runTotal = list.length;
        }
        const r = c.run;
        job.stage = `المرحلة 4 من 4: العلاقات والفهارس وقواعد الحماية (${Math.min(r.i, r.list.length)}/${r.list.length})`;
        if (!(await stepStatements(ctx, r, deadline))) return false;
        finishRun(ctx, r, (c as Cursor & { runTotal?: number }).runTotal ?? 0);
        c.run = null;
        ctx.log("✔ تم النقل. المشروع الهدف الآن نسخة مطابقة للمصدر.");
        return true;
      }
      default:
        return true;
    }
  }
  return false;
}

/* ---------------------------- Storage transfer ---------------------------- */

type ApiKey = { name?: string; api_key?: string; type?: string };
async function secretKey(token: string, ref: string): Promise<string> {
  const keys = await mgmt<ApiKey[]>(token, `/projects/${ref}/api-keys?reveal=true`);
  const k =
    keys.find((x) => x.name === "service_role") ??
    keys.find((x) => x.type === "secret") ??
    keys.find((x) => (x.api_key ?? "").startsWith("sb_secret_"));
  if (!k?.api_key) throw new Error("تعذّر قراءة مفتاح المشروع السري — تحقّق من صلاحيات الرمز.");
  return k.api_key;
}
const sUrl = (ref: string, p: string) => `https://${ref}.supabase.co/storage/v1${p}`;
const sHead = (key: string) => ({ apikey: key, Authorization: `Bearer ${key}` });

async function stepStorage(ctx: Ctx, deadline: number): Promise<boolean> {
  const { job, tok } = ctx;
  const c = job.cursor;
  const src = job.source_ref;
  const dst = job.target_ref;
  const srcKey = await secretKey(tok.source, src);
  const dstKey = await secretKey(tok.target, dst);

  while (Date.now() < deadline) {
    if (c.phase === "start") {
      job.stage = "المرحلة 1 من 2: إنشاء مجلدات التخزين…";
      ctx.log("① إنشاء مجلدات التخزين في الهدف…");
      const list = async (ref: string, key: string) => {
        const r = await fetch(sUrl(ref, "/bucket"), { headers: sHead(key) });
        if (!r.ok) throw new Error(`تعذّر قراءة مجلدات التخزين (${r.status})`);
        return (await r.json()) as Array<{
          id: string;
          name: string;
          public?: boolean;
          file_size_limit?: number | null;
          allowed_mime_types?: string[] | null;
        }>;
      };
      const srcB = await list(src, srcKey);
      const existing = new Set((await list(dst, dstKey)).map((b) => b.id));
      const counts = await runSql(
        tok.source,
        src,
        `select bucket_id, count(*)::int as n from storage.objects group by bucket_id`,
      );
      const cnt = Object.fromEntries(counts.map((r) => [str(r["bucket_id"]), Number(r["n"] ?? 0)]));
      let created = 0;
      for (const b of srcB) {
        if (existing.has(b.id)) continue;
        const r = await fetch(sUrl(dst, "/bucket"), {
          method: "POST",
          headers: { ...sHead(dstKey), "Content-Type": "application/json" },
          body: JSON.stringify({
            id: b.id,
            name: b.name,
            public: Boolean(b.public),
            file_size_limit: b.file_size_limit ?? null,
            allowed_mime_types: b.allowed_mime_types ?? null,
          }),
        });
        if (r.ok) created += 1;
        else ctx.warn(`${b.name} → ${(await r.text()).slice(0, 160)}`);
      }
      ctx.log(`   أُنشئ ${created} مجلدًا.`);
      c.buckets = srcB.map((b) => ({ id: b.id, name: b.name, objects: cnt[b.id] ?? 0 }));
      job.total = c.buckets.reduce((s, b) => s + b.objects, 0);
      c.phase = "files";
      c.bi = 0;
      c.offset = 0;
      c.bucketCopied = 0;
      ctx.log(`② نسخ الملفات (${job.total} ملفًا)…`);
      continue;
    }
    if (c.phase === "files") {
      const buckets = c.buckets ?? [];
      const bi = c.bi ?? 0;
      if (bi >= buckets.length) {
        ctx.log("✔ تم نقل الملفات المخزَّنة.");
        return true;
      }
      const b = buckets[bi]!;
      job.counting = true;
      job.stage = `المرحلة 2 من 2: نسخ الملفات — ${b.name} (${bi + 1}/${buckets.length})`;
      const files = await runSql(
        tok.source,
        src,
        `select name, coalesce((metadata->>'size')::bigint, 0) as size,
                coalesce(metadata->>'mimetype', 'application/octet-stream') as mimetype
         from storage.objects where bucket_id = ${lit(b.id)} and name is not null
         order by name offset ${c.offset ?? 0} limit ${FILE_BATCH}`,
      );
      for (const f of files) {
        const name = str(f["name"]);
        const size = Number(f["size"] ?? 0);
        if (size > MAX_FILE_BYTES) {
          ctx.log(`   ↷ تُخطّي ${name} (كبير جدًا)`);
          continue;
        }
        try {
          const path = name.split("/").map(encodeURIComponent).join("/");
          const bk = encodeURIComponent(b.id);
          const dl = await fetch(sUrl(src, `/object/${bk}/${path}`), { headers: sHead(srcKey) });
          if (!dl.ok) throw new Error(`تحميل فاشل (${dl.status})`);
          const body = await dl.arrayBuffer();
          const up = await fetch(sUrl(dst, `/object/${bk}/${path}`), {
            method: "POST",
            headers: {
              ...sHead(dstKey),
              "Content-Type": dl.headers.get("content-type") ?? str(f["mimetype"]),
              "x-upsert": "true",
            },
            body,
          });
          if (!up.ok) throw new Error(`رفع فاشل (${up.status})`);
          c.bucketCopied = (c.bucketCopied ?? 0) + 1;
        } catch (e) {
          ctx.warn(`${name} → ${(e as Error).message}`);
        }
      }
      c.offset = (c.offset ?? 0) + files.length;
      job.done += files.length;
      if (job.done > job.total) job.total = job.done;
      if (files.length < FILE_BATCH) {
        ctx.log(`   ${b.name}: ${c.bucketCopied ?? 0} ملفًا.`);
        c.bi = bi + 1;
        c.offset = 0;
        c.bucketCopied = 0;
      }
      continue;
    }
    return true;
  }
  return false;
}

/* ------------------------------ Auth transfer ----------------------------- */

async function stepAuth(ctx: Ctx, deadline: number): Promise<boolean> {
  const { job, tok } = ctx;
  const c = job.cursor;
  const src = job.source_ref;
  const dst = job.target_ref;

  const shared = async (table: string) => {
    const [a, b] = await Promise.all([
      runSql(tok.source, src, authColumns(table)),
      runSql(tok.target, dst, authColumns(table)),
    ]);
    const set = new Set(b.map((r) => str(r["name"])));
    return a.map((r) => str(r["name"])).filter((x) => set.has(x));
  };

  while (Date.now() < deadline) {
    if (c.phase === "start") {
      const t = await runSql(
        tok.source,
        src,
        `select count(*)::int as n from auth.users where deleted_at is null`,
      );
      job.total = Number(t[0]?.["n"] ?? 0);
      ctx.log("① نسخ الحسابات مع كلمات المرور المشفَّرة…");
      c.phase = "users";
      c.offset = 0;
      c.users = 0;
      continue;
    }
    if (c.phase === "users" || c.phase === "identities") {
      const isUsers = c.phase === "users";
      const table = isUsers ? "users" : "identities";
      job.counting = isUsers;
      job.stage = isUsers ? "المرحلة 1 من 2: نسخ الحسابات…" : "المرحلة 2 من 2: نسخ طرق الدخول…";
      const where = isUsers
        ? "where deleted_at is null"
        : "where user_id in (select id from auth.users where deleted_at is null)";
      const cols = await shared(table);
      const sel = cols.map((x) => `${ident(x)}::text as ${ident(x)}`).join(", ");
      const rows = cols.length
        ? await runSql(
            tok.source,
            src,
            `select ${sel} from auth.${ident(table)} ${where} order by created_at offset ${c.offset ?? 0} limit ${USER_BATCH}`,
          )
        : [];
      const values = rows.map(
        (row) => `(${cols.map((x) => (row[x] == null ? "NULL" : lit(String(row[x])))).join(", ")})`,
      );
      const head = `insert into auth.${ident(table)} (${cols.map(ident).join(", ")}) values `;
      let copied = 0;
      if (values.length) {
        try {
          await runSql(tok.target, dst, `${head}${values.join(", ")} on conflict do nothing;`);
          copied = values.length;
        } catch {
          for (const v of values) {
            try {
              await runSql(tok.target, dst, `${head}${v} on conflict do nothing;`);
              copied += 1;
            } catch (e) {
              ctx.warn(`${table}: ${(e as Error).message.slice(0, 160)}`);
            }
          }
        }
      }
      c.offset = (c.offset ?? 0) + rows.length;
      if (isUsers) {
        c.users = (c.users ?? 0) + copied;
        job.done += rows.length;
      } else c.ids = (c.ids ?? 0) + copied;
      if (rows.length < USER_BATCH) {
        if (isUsers) {
          ctx.log(`   نُسخ ${c.users} حسابًا.`);
          ctx.log("② نسخ طرق الدخول (بريد/جوجل/…)…");
          c.phase = "identities";
          c.offset = 0;
          c.ids = 0;
        } else {
          ctx.log(`   نُسخت ${c.ids} هويّة دخول.`);
          ctx.log("✔ تم نقل المستخدمين — يدخلون بنفس البريد وكلمة المرور.");
          return true;
        }
      }
      continue;
    }
    return true;
  }
  return false;
}

/* --------------------------------- Public --------------------------------- */

const SAFE_COLS =
  "id, kind, source_ref, target_ref, source_name, target_name, status, stage, counting, done, total, log, errors, started_at, finished_at, created_at, updated_at";
export { SAFE_COLS };

export async function createJob(input: {
  userId: string;
  kind: JobKind;
  sourceRef: string;
  targetRef: string;
  sourceName?: string | undefined;
  targetName?: string | undefined;
  tokens: Tokens;
}) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: busy } = await supabaseAdmin
    .from("transfer_jobs")
    .select("id")
    .eq("user_id", input.userId)
    .eq("kind", input.kind)
    .eq("status", "running")
    .limit(1);
  if (busy && busy.length) throw new Error("يوجد نقل من نفس النوع قيد التشغيل بالفعل.");
  const { data, error } = await supabaseAdmin
    .from("transfer_jobs")
    .insert({
      user_id: input.userId,
      kind: input.kind,
      source_ref: input.sourceRef,
      target_ref: input.targetRef,
      source_name: input.sourceName ?? null,
      target_name: input.targetName ?? null,
      status: "running",
      stage: "في الانتظار…",
      cursor: { phase: "start" },
      tokens_ciphertext: await encryptConnectionKey(JSON.stringify(input.tokens)),
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

/** Advance one job by a bounded slice. Safe to call concurrently (locked). */
export async function advanceJob(id: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const now = new Date();
  const { data: claimed } = await supabaseAdmin
    .from("transfer_jobs")
    .update({ locked_until: new Date(now.getTime() + LOCK_MS).toISOString() })
    .eq("id", id)
    .eq("status", "running")
    .or(`locked_until.is.null,locked_until.lt.${now.toISOString()}`)
    .select("*")
    .maybeSingle();
  if (!claimed) return;
  const job = claimed as unknown as Job;
  if (!job.tokens_ciphertext) {
    await supabaseAdmin
      .from("transfer_jobs")
      .update({ status: "failed", stage: "رموز الوصول مفقودة", finished_at: now.toISOString(), locked_until: null })
      .eq("id", id);
    return;
  }
  const tok = JSON.parse(await decryptConnectionKey(job.tokens_ciphertext)) as Tokens;
  const ctx = new Ctx(job, tok);
  const deadline = Date.now() + SLICE_MS;
  let finished = false;
  let failure: string | null = null;
  try {
    if (job.kind === "db") finished = await stepDb(ctx, deadline);
    else if (job.kind === "storage") finished = await stepStorage(ctx, deadline);
    else finished = await stepAuth(ctx, deadline);
  } catch (e) {
    failure = (e as Error).message;
    ctx.log(`✕ توقّف النقل: ${failure}`);
  }

  // Re-check cancellation that may have happened during the slice.
  const { data: cur } = await supabaseAdmin.from("transfer_jobs").select("status").eq("id", id).single();
  const cancelled = cur?.status === "cancelled";
  const ended = finished || !!failure || cancelled;
  const update: Record<string, unknown> = {
    stage: cancelled ? "أُلغي" : failure ? "توقّف بسبب خطأ" : finished ? "اكتمل" : job.stage,
    counting: ended ? false : job.counting,
    done: job.done,
    total: job.total,
    cursor: job.cursor,
    log: [...job.log, ...ctx.logAdd].slice(-MAX_LOG),
    errors: [...job.errors, ...ctx.errAdd].slice(-MAX_LOG),
    locked_until: null,
  };
  if (ended) {
    update["finished_at"] = new Date().toISOString();
    update["tokens_ciphertext"] = null;
    if (!cancelled) update["status"] = failure ? "failed" : "completed";
  }
  await supabaseAdmin.from("transfer_jobs").update(update as never).eq("id", id);
}

/** Advance every running job (used by the public tick endpoint). */
export async function advanceAll(): Promise<number> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("transfer_jobs")
    .select("id")
    .eq("status", "running")
    .order("created_at")
    .limit(5);
  const ids = (data ?? []).map((r) => r.id as string);
  await Promise.all(ids.map((id) => advanceJob(id).catch(() => undefined)));
  return ids.length;
}
