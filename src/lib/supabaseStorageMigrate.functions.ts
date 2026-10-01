import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** ---------------------------------------------------------------
 * Storage migration between two completely separate Supabase projects.
 * Uses the Management API (personal access token) to read the project's
 * secret API key, then the Storage REST API to download / upload files.
 * -------------------------------------------------------------- */

const API = "https://api.supabase.com/v1";

async function mgmt<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error("رمز الوصول غير صالح أو لا يملك صلاحية على هذا المشروع.");
    }
    throw new Error(`فشل الطلب (${res.status}): ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

type ApiKey = { name?: string; api_key?: string; type?: string; id?: string };

/** Reveal the project's secret (service-role) key so Storage can be accessed. */
async function secretKey(token: string, ref: string): Promise<string> {
  const keys = await mgmt<ApiKey[]>(token, `/projects/${ref}/api-keys?reveal=true`);
  const pick =
    keys.find((k) => k.name === "service_role") ??
    keys.find((k) => k.type === "secret") ??
    keys.find((k) => (k.api_key ?? "").startsWith("sb_secret_"));
  const key = pick?.api_key;
  if (!key) throw new Error("لم أتمكن من قراءة مفتاح المشروع السري — تحقّق من صلاحيات الرمز.");
  return key;
}

function storageHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function storageUrl(ref: string, path: string): string {
  return `https://${ref}.supabase.co/storage/v1${path}`;
}

export type StorageBucket = {
  id: string;
  name: string;
  public: boolean;
  fileSizeLimit: number | null;
  allowedMimeTypes: string[] | null;
  objects: number;
  bytes: number;
};

async function listBuckets(token: string, ref: string): Promise<StorageBucket[]> {
  const key = await secretKey(token, ref);
  const res = await fetch(storageUrl(ref, "/bucket"), { headers: storageHeaders(key) });
  const text = await res.text();
  if (!res.ok) throw new Error(`تعذّر قراءة مجلدات التخزين (${res.status}): ${text.slice(0, 200)}`);
  const raw = JSON.parse(text) as Array<{
    id: string;
    name: string;
    public?: boolean;
    file_size_limit?: number | null;
    allowed_mime_types?: string[] | null;
  }>;

  // Object counts / sizes come from the storage metadata table via the SQL endpoint.
  let stats: Record<string, { objects: number; bytes: number }> = {};
  try {
    const rows = await mgmt<Array<Record<string, unknown>>>(
      token,
      `/projects/${ref}/database/query`,
      {
        method: "POST",
        body: JSON.stringify({
          query: `select bucket_id, count(*) as objects,
                         coalesce(sum((metadata->>'size')::bigint), 0) as bytes
                  from storage.objects group by bucket_id`,
        }),
      },
    );
    stats = Object.fromEntries(
      (rows ?? []).map((r) => [
        String(r["bucket_id"]),
        { objects: Number(r["objects"] ?? 0), bytes: Number(r["bytes"] ?? 0) },
      ]),
    );
  } catch {
    /* counts are informational only */
  }

  return raw.map<StorageBucket>((b) => ({
    id: b.id,
    name: b.name,
    public: Boolean(b.public),
    fileSizeLimit: b.file_size_limit ?? null,
    allowedMimeTypes: b.allowed_mime_types ?? null,
    objects: stats[b.id]?.objects ?? 0,
    bytes: stats[b.id]?.bytes ?? 0,
  }));
}

/** ---------------------------------------------------------------
 * Server functions
 * -------------------------------------------------------------- */

export const inspectStorage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { token: string; ref: string }) => {
    if (!input.token?.trim() || !input.ref?.trim()) throw new Error("حدّد المشروع أولًا.");
    return { token: input.token.trim(), ref: input.ref.trim() };
  })
  .handler(async ({ data }) => {
    const buckets = await listBuckets(data.token, data.ref);
    return {
      buckets,
      totalObjects: buckets.reduce((s, b) => s + b.objects, 0),
      totalBytes: buckets.reduce((s, b) => s + b.bytes, 0),
    };
  });

/** Create the source buckets in the target (skips ones that already exist). */
export const createTargetBuckets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { sourceToken: string; sourceRef: string; targetToken: string; targetRef: string }) => {
      if (!input.sourceToken || !input.sourceRef || !input.targetToken || !input.targetRef)
        throw new Error("بيانات المصدر أو الهدف ناقصة.");
      return input;
    },
  )
  .handler(async ({ data }) => {
    const source = await listBuckets(data.sourceToken, data.sourceRef);
    const key = await secretKey(data.targetToken, data.targetRef);
    const existing = new Set((await listBuckets(data.targetToken, data.targetRef)).map((b) => b.id));

    const created: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];
    for (const b of source) {
      if (existing.has(b.id)) {
        skipped.push(b.name);
        continue;
      }
      const res = await fetch(storageUrl(data.targetRef, "/bucket"), {
        method: "POST",
        headers: { ...storageHeaders(key), "Content-Type": "application/json" },
        body: JSON.stringify({
          id: b.id,
          name: b.name,
          public: b.public,
          file_size_limit: b.fileSizeLimit,
          allowed_mime_types: b.allowedMimeTypes,
        }),
      });
      if (res.ok) created.push(b.name);
      else errors.push(`${b.name} → ${(await res.text()).slice(0, 160)}`);
    }
    return { buckets: source.map((b) => ({ name: b.name, id: b.id, objects: b.objects })), created, skipped, errors };
  });

/** List one page of object paths inside a bucket (read from storage metadata). */
export const listBucketObjects = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { token: string; ref: string; bucket: string; offset: number; limit: number }) => {
    if (!input.token?.trim() || !input.ref?.trim() || !input.bucket?.trim())
      throw new Error("بيانات المجلد ناقصة.");
    return {
      token: input.token.trim(),
      ref: input.ref.trim(),
      bucket: input.bucket.trim(),
      offset: Math.max(0, Math.floor(input.offset)),
      limit: Math.min(200, Math.max(1, Math.floor(input.limit))),
    };
  })
  .handler(async ({ data }) => {
    const rows = await mgmt<Array<Record<string, unknown>>>(
      data.token,
      `/projects/${data.ref}/database/query`,
      {
        method: "POST",
        body: JSON.stringify({
          query: `select name, coalesce((metadata->>'size')::bigint, 0) as size,
                         coalesce(metadata->>'mimetype', 'application/octet-stream') as mimetype
                  from storage.objects
                  where bucket_id = '${data.bucket.replace(/'/g, "''")}' and name is not null
                  order by name
                  offset ${data.offset} limit ${data.limit}`,
        }),
      },
    );
    return (rows ?? []).map((r) => ({
      name: String(r["name"]),
      size: Number(r["size"] ?? 0),
      mimetype: String(r["mimetype"] ?? "application/octet-stream"),
    }));
  });

const MAX_FILE_BYTES = 40 * 1024 * 1024;

/** Copy a small batch of files (download from source, upload to target). */
export const copyStorageFiles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      sourceToken: string;
      sourceRef: string;
      targetToken: string;
      targetRef: string;
      bucket: string;
      files: Array<{ name: string; size: number; mimetype: string }>;
    }) => {
      if (!input.bucket?.trim()) throw new Error("اسم المجلد مفقود.");
      return { ...input, bucket: input.bucket.trim(), files: input.files.slice(0, 20) };
    },
  )
  .handler(async ({ data }) => {
    const srcKey = await secretKey(data.sourceToken, data.sourceRef);
    const dstKey = await secretKey(data.targetToken, data.targetRef);

    let copied = 0;
    let bytes = 0;
    const errors: string[] = [];
    const skipped: string[] = [];

    for (const file of data.files) {
      if (file.size > MAX_FILE_BYTES) {
        skipped.push(`${file.name} (كبير جدًا: ${Math.round(file.size / 1048576)} ميغابايت)`);
        continue;
      }
      try {
        const path = file.name.split("/").map(encodeURIComponent).join("/");
        const dl = await fetch(
          storageUrl(data.sourceRef, `/object/${encodeURIComponent(data.bucket)}/${path}`),
          { headers: storageHeaders(srcKey) },
        );
        if (!dl.ok) throw new Error(`تحميل فاشل (${dl.status})`);
        const body = await dl.arrayBuffer();

        const up = await fetch(
          storageUrl(data.targetRef, `/object/${encodeURIComponent(data.bucket)}/${path}`),
          {
            method: "POST",
            headers: {
              ...storageHeaders(dstKey),
              "Content-Type": dl.headers.get("content-type") ?? file.mimetype,
              "x-upsert": "true",
            },
            body,
          },
        );
        if (!up.ok) throw new Error(`رفع فاشل (${up.status}): ${(await up.text()).slice(0, 120)}`);
        copied += 1;
        bytes += body.byteLength;
      } catch (e) {
        errors.push(`${file.name} → ${(e as Error).message}`);
      }
    }

    return { copied, bytes, errors, skipped };
  });
