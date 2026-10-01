import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** ---------------------------------------------------------------
 * نقل حسابات المستخدمين (auth.users + auth.identities) بين مشروعين
 * عبر Management API — تُنسخ كلمات المرور المشفَّرة كما هي،
 * فيستطيع المستخدمون الدخول بنفس كلمات مرورهم.
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

function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

const columnsQuery = (table: string) => `
select a.attname as name
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'auth' and c.relname = ${lit(table)}
  and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
order by a.attnum`;

async function columns(token: string, ref: string, table: string): Promise<string[]> {
  const rows = await runSql(token, ref, columnsQuery(table));
  return rows.map((r) => str(r["name"])).filter(Boolean);
}

/** الأعمدة الموجودة في المصدر والهدف معًا — لتفادي فروق إصدارات Supabase. */
async function sharedColumns(
  sourceToken: string,
  sourceRef: string,
  targetToken: string,
  targetRef: string,
  table: string,
): Promise<string[]> {
  const [src, tgt] = await Promise.all([
    columns(sourceToken, sourceRef, table),
    columns(targetToken, targetRef, table),
  ]);
  const set = new Set(tgt);
  return src.filter((c) => set.has(c));
}

type Creds = {
  sourceToken: string;
  sourceRef: string;
  targetToken: string;
  targetRef: string;
};

function validateCreds(input: Creds): Creds {
  if (!input.sourceToken || !input.sourceRef || !input.targetToken || !input.targetRef)
    throw new Error("بيانات المصدر أو الهدف ناقصة.");
  return input;
}

export type AuthReport = {
  users: number;
  confirmed: number;
  withPassword: number;
  providers: Array<{ provider: string; count: number }>;
};

/** فحص عدد الحسابات في المصدر. */
export const inspectAuthUsers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { token: string; ref: string }) => {
    if (!input.token?.trim() || !input.ref?.trim()) throw new Error("حدّد مشروع المصدر.");
    return { token: input.token.trim(), ref: input.ref.trim() };
  })
  .handler(async ({ data }) => {
    const { token, ref } = data;
    const [totals, providers] = await Promise.all([
      runSql(
        token,
        ref,
        `select count(*)::int as users,
                count(email_confirmed_at)::int as confirmed,
                count(nullif(encrypted_password, ''))::int as with_password
         from auth.users where deleted_at is null`,
      ),
      runSql(
        token,
        ref,
        `select provider, count(*)::int as count from auth.identities group by provider order by provider`,
      ),
    ]);
    const t = totals[0] ?? {};
    return {
      users: Number(t["users"] ?? 0),
      confirmed: Number(t["confirmed"] ?? 0),
      withPassword: Number(t["with_password"] ?? 0),
      providers: providers.map((p) => ({
        provider: str(p["provider"]),
        count: Number(p["count"] ?? 0),
      })),
    } satisfies AuthReport;
  });

/** نسخ دفعة من الحسابات، مع تخطّي الموجود مسبقًا في الهدف. */
async function copyChunk(
  creds: Creds,
  table: string,
  order: string,
  offset: number,
  limit: number,
  where: string,
) {
  const cols = await sharedColumns(
    creds.sourceToken,
    creds.sourceRef,
    creds.targetToken,
    creds.targetRef,
    table,
  );
  if (cols.length === 0) return { copied: 0, read: 0, errors: [] as string[] };

  const selectList = cols.map((c) => `${ident(c)}::text as ${ident(c)}`).join(", ");
  const rows = await runSql(
    creds.sourceToken,
    creds.sourceRef,
    `select ${selectList} from auth.${ident(table)} ${where} order by ${order} offset ${offset} limit ${limit}`,
  );
  if (rows.length === 0) return { copied: 0, read: 0, errors: [] as string[] };

  const values = rows.map((row) => {
    const cells = cols.map((c) => {
      const v = row[c];
      return v === null || v === undefined ? "NULL" : lit(String(v));
    });
    return `(${cells.join(", ")})`;
  });

  const head = `insert into auth.${ident(table)} (${cols.map(ident).join(", ")}) values `;
  const errors: string[] = [];
  let copied = 0;

  try {
    await runSql(creds.targetToken, creds.targetRef, `${head}${values.join(", ")} on conflict do nothing;`);
    copied = rows.length;
  } catch {
    // إن فشلت الدفعة، أعد المحاولة صفًا صفًا لتحديد السبب بدقة.
    for (let i = 0; i < values.length; i += 1) {
      try {
        await runSql(creds.targetToken, creds.targetRef, `${head}${values[i]} on conflict do nothing;`);
        copied += 1;
      } catch (e) {
        errors.push(`${table}: ${(e as Error).message.slice(0, 160)}`);
      }
    }
  }

  return { copied, read: rows.length, errors };
}

/** نسخ دفعة من المستخدمين. */
export const copyAuthUsersChunk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: Creds & { offset: number; limit: number }) => ({
    ...validateCreds(input),
    offset: Math.max(0, Math.floor(input.offset)),
    limit: Math.min(200, Math.max(1, Math.floor(input.limit))),
  }))
  .handler(async ({ data }) => {
    const res = await copyChunk(
      data,
      "users",
      "created_at",
      data.offset,
      data.limit,
      "where deleted_at is null",
    );
    return { ...res, done: res.read < data.limit };
  });

/** نسخ دفعة من هويّات الدخول (بريد/جوجل/…)، بعد نسخ المستخدمين. */
export const copyAuthIdentitiesChunk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: Creds & { offset: number; limit: number }) => ({
    ...validateCreds(input),
    offset: Math.max(0, Math.floor(input.offset)),
    limit: Math.min(200, Math.max(1, Math.floor(input.limit))),
  }))
  .handler(async ({ data }) => {
    const res = await copyChunk(
      data,
      "identities",
      "created_at",
      data.offset,
      data.limit,
      `where user_id in (select id from auth.users where deleted_at is null)`,
    );
    return { ...res, done: res.read < data.limit };
  });
