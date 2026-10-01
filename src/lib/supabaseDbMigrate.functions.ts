import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** ---------------------------------------------------------------
 * Supabase Management API helpers (per-user personal access tokens)
 * -------------------------------------------------------------- */

const API = "https://api.supabase.com/v1";

type Row = Record<string, unknown>;

async function mgmt<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  // Retry on rate limiting (429) with exponential backoff.
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
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      msg = parsed.message ?? parsed.error ?? text;
    } catch {
      /* keep raw text */
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error("رمز الوصول غير صالح أو لا يملك صلاحية على هذا المشروع.");
    }
    throw new Error(`فشل الطلب (${res.status}): ${msg.slice(0, 400)}`);
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

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

/** Quote a text value as a Postgres literal (standard_conforming_strings). */
function lit(v: string | null): string {
  if (v === null) return "NULL";
  return `'${v.replace(/'/g, "''")}'`;
}

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** ---------------------------------------------------------------
 * Introspection queries — build the DDL from the source project
 * -------------------------------------------------------------- */

const Q_SEQUENCES = `
select 'create sequence if not exists public.' || quote_ident(c.relname) || ';' as stmt
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'S'
order by c.relname`;

const Q_ENUMS = `
select 'create type public.' || quote_ident(t.typname) || ' as enum ('
       || string_agg(quote_literal(e.enumlabel), ', ' order by e.enumsortorder) || ');' as stmt
from pg_type t
join pg_enum e on e.enumtypid = t.oid
join pg_namespace n on n.oid = t.typnamespace
where n.nspname = 'public'
group by t.typname
order by t.typname`;

const Q_FUNCTIONS = `
select pg_get_functiondef(p.oid) || ';' as stmt
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind in ('f','p')
order by p.proname`;

const Q_TABLES = `
select 'create table if not exists public.' || quote_ident(c.relname) || ' (' || string_agg(
         quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod)
         || case when a.attgenerated = 's'
                 then ' generated always as (' || pg_get_expr(d.adbin, d.adrelid) || ') stored'
                 when pg_get_expr(d.adbin, d.adrelid) is not null
                 then ' default ' || pg_get_expr(d.adbin, d.adrelid)
                 else '' end
         || case when a.attnotnull then ' not null' else '' end,
         ', ' order by a.attnum) || ');' as stmt
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
where n.nspname = 'public' and c.relkind = 'r'
group by c.relname
order by c.relname`;

const constraintsQuery = (types: string) => `
select 'alter table public.' || quote_ident(c.relname) || ' add constraint '
       || quote_ident(k.conname) || ' ' || pg_get_constraintdef(k.oid) || ';' as stmt
from pg_constraint k
join pg_class c on c.oid = k.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and k.contype in (${types})
order by k.contype, k.conname`;

const Q_INDEXES = `
select indexdef || ';' as stmt
from pg_indexes i
where schemaname = 'public'
  and not exists (
    select 1 from pg_constraint k join pg_namespace n on n.oid = k.connamespace
    where n.nspname = 'public' and k.conname = i.indexname)
order by indexname`;

const Q_VIEWS = `
select 'create or replace view public.' || quote_ident(viewname) || ' as ' || definition as stmt
from pg_views where schemaname = 'public' order by viewname`;

const Q_TRIGGERS = `
select pg_get_triggerdef(t.oid) || ';' as stmt
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and not t.tgisinternal
order by t.tgname`;

const Q_RLS = `
select 'alter table public.' || quote_ident(tablename) || ' enable row level security;' as stmt
from pg_tables where schemaname = 'public' and rowsecurity
order by tablename`;

const Q_POLICIES = `
select 'create policy ' || quote_ident(policyname) || ' on public.' || quote_ident(tablename)
       || ' as ' || permissive || ' for ' || cmd
       || ' to ' || array_to_string(roles, ', ')
       || coalesce(' using (' || qual || ')', '')
       || coalesce(' with check (' || with_check || ')', '') || ';' as stmt
from pg_policies where schemaname = 'public'
order by tablename, policyname`;

const Q_GRANTS = `
select distinct 'grant ' || privilege_type || ' on public.' || quote_ident(table_name)
       || ' to ' || quote_ident(grantee) || ';' as stmt
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon','authenticated','service_role')
order by 1`;

const Q_SETVAL = `
select 'select setval(' || quote_literal('public.' || quote_ident(sequencename)) || ', '
       || greatest(coalesce(last_value, 1), 1) || ', ' || (last_value is not null) || ');' as stmt
from pg_sequences where schemaname = 'public'
order by sequencename`;

const Q_TABLE_ROWS = `
select c.relname as name,
       (xpath('/row/c/text()', query_to_xml(
          format('select count(*) as c from public.%I', c.relname), false, true, '')))[1]::text::bigint as rows
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname`;

const columnsQuery = (table: string) => `
select quote_ident(a.attname) as q, a.attname as name
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = ${lit(table)}
  and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
order by a.attnum`;

async function stmts(token: string, ref: string, query: string): Promise<string[]> {
  const rows = await runSql(token, ref, query);
  return rows.map((r) => str(r["stmt"])).filter((s) => s.trim().length > 0);
}

/** Apply statements one by one; collect failures instead of aborting. */
async function apply(token: string, ref: string, list: string[]) {
  let applied = 0;
  const errors: string[] = [];
  for (const s of list) {
    try {
      await runSql(token, ref, s);
      applied += 1;
    } catch (e) {
      errors.push(`${s.slice(0, 160)} → ${(e as Error).message}`);
    }
  }
  return { applied, errors };
}

/** ---------------------------------------------------------------
 * Server functions
 * -------------------------------------------------------------- */

export type SupabaseProject = { ref: string; name: string; region: string; organizationId: string };

export const listSupabaseProjects = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { token: string }) => {
    const token = input.token?.trim();
    if (!token) throw new Error("أدخل رمز الوصول أولًا.");
    return { token };
  })
  .handler(async ({ data }) => {
    const projects = await mgmt<
      Array<{ id: string; name: string; region?: string; organization_id?: string }>
    >(data.token, "/projects");
    return projects.map<SupabaseProject>((p) => ({
      ref: p.id,
      name: p.name,
      region: p.region ?? "",
      organizationId: p.organization_id ?? "",
    }));
  });

export type SourceReport = {
  tables: Array<{ name: string; rows: number }>;
  totalRows: number;
  counts: {
    enums: number;
    functions: number;
    views: number;
    triggers: number;
    policies: number;
    indexes: number;
    sequences: number;
  };
};

export const inspectSourceDb = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { token: string; ref: string }) => {
    if (!input.token?.trim() || !input.ref?.trim()) throw new Error("حدّد مشروع المصدر.");
    return { token: input.token.trim(), ref: input.ref.trim() };
  })
  .handler(async ({ data }) => {
    const { token, ref } = data;
    const [tablesRows, enums, functions, views, triggers, policies, indexes, sequences] =
      await Promise.all([
        runSql(token, ref, Q_TABLE_ROWS),
        stmts(token, ref, Q_ENUMS),
        stmts(token, ref, Q_FUNCTIONS),
        stmts(token, ref, Q_VIEWS),
        stmts(token, ref, Q_TRIGGERS),
        stmts(token, ref, Q_POLICIES),
        stmts(token, ref, Q_INDEXES),
        stmts(token, ref, Q_SEQUENCES),
      ]);

    const tables = tablesRows.map((r) => ({
      name: str(r["name"]),
      rows: Number(r["rows"] ?? 0),
    }));

    return {
      tables,
      totalRows: tables.reduce((sum, t) => sum + t.rows, 0),
      counts: {
        enums: enums.length,
        functions: functions.length,
        views: views.length,
        triggers: triggers.length,
        policies: policies.length,
        indexes: indexes.length,
        sequences: sequences.length,
      },
    } satisfies SourceReport;
  });

/** Wipe the target's public schema so it becomes an exact copy of the source. */
export const resetTargetDb = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { token: string; ref: string; confirm: boolean }) => {
    if (!input.token?.trim() || !input.ref?.trim()) throw new Error("حدّد مشروع الهدف.");
    if (!input.confirm) throw new Error("لم تُؤكِّد حذف محتوى المشروع الهدف.");
    return { token: input.token.trim(), ref: input.ref.trim() };
  })
  .handler(async ({ data }) => {
    await runSql(
      data.token,
      data.ref,
      `drop schema if exists public cascade;
       create schema public;
       grant usage on schema public to anon, authenticated, service_role;
       grant create on schema public to postgres;`,
    );
    return { ok: true };
  });

/** Phase 1: sequences, enums, functions, tables, primary/unique keys. */
export const applySchemaStructure = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { sourceToken: string; sourceRef: string; targetToken: string; targetRef: string }) => {
      if (!input.sourceToken || !input.sourceRef || !input.targetToken || !input.targetRef)
        throw new Error("بيانات المصدر أو الهدف ناقصة.");
      return input;
    },
  )
  .handler(async ({ data }) => {
    const list: string[] = [];
    for (const q of [Q_SEQUENCES, Q_ENUMS, Q_FUNCTIONS, Q_TABLES, constraintsQuery("'p','u'")]) {
      list.push(...(await stmts(data.sourceToken, data.sourceRef, q)));
    }
    const res = await apply(data.targetToken, data.targetRef, list);
    return { total: list.length, ...res };
  });

/** Phase 3: foreign keys, checks, indexes, views, triggers, RLS, policies, grants, sequences. */
export const applySchemaExtras = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { sourceToken: string; sourceRef: string; targetToken: string; targetRef: string }) => {
      if (!input.sourceToken || !input.sourceRef || !input.targetToken || !input.targetRef)
        throw new Error("بيانات المصدر أو الهدف ناقصة.");
      return input;
    },
  )
  .handler(async ({ data }) => {
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
    ]) {
      list.push(...(await stmts(data.sourceToken, data.sourceRef, q)));
    }
    const res = await apply(data.targetToken, data.targetRef, list);
    return { total: list.length, ...res };
  });

/** Copy one chunk of rows of one table, source → target. */
export const copyTableChunk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      sourceToken: string;
      sourceRef: string;
      targetToken: string;
      targetRef: string;
      table: string;
      offset: number;
      limit: number;
    }) => {
      if (!input.table?.trim()) throw new Error("اسم الجدول مفقود.");
      return {
        ...input,
        table: input.table.trim(),
        offset: Math.max(0, Math.floor(input.offset)),
        limit: Math.min(500, Math.max(1, Math.floor(input.limit))),
      };
    },
  )
  .handler(async ({ data }) => {
    const { sourceToken, sourceRef, targetToken, targetRef, table, offset, limit } = data;

    const colRows = await runSql(sourceToken, sourceRef, columnsQuery(table));
    const columns = colRows.map((r) => str(r["name"]));
    if (columns.length === 0) return { copied: 0, done: true };

    // Read every column as text so the literal form round-trips exactly.
    const selectList = columns.map((c) => `${ident(c)}::text as ${ident(c)}`).join(", ");
    const rows = await runSql(
      sourceToken,
      sourceRef,
      `select ${selectList} from public.${ident(table)} order by ctid offset ${offset} limit ${limit}`,
    );
    if (rows.length === 0) return { copied: 0, done: true };

    const values = rows.map((row) => {
      const cells = columns.map((c) => {
        const v = row[c];
        return v === null || v === undefined ? "NULL" : lit(String(v));
      });
      return `(${cells.join(", ")})`;
    });

    const head = `insert into public.${ident(table)} (${columns.map(ident).join(", ")}) values `;
    // Split into batches so no single statement grows too large.
    let batch: string[] = [];
    let size = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      await runSql(targetToken, targetRef, `${head}${batch.join(", ")};`);
      batch = [];
      size = 0;
    };
    for (const v of values) {
      if (size + v.length > 400_000) await flush();
      batch.push(v);
      size += v.length;
    }
    await flush();

    return { copied: rows.length, done: rows.length < limit };
  });
