// Server-only — never import from the browser.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const SECRET_NAME = "APP_USER_CONNECTION_KEY_SECRET";

let cached: Buffer | null = null;

/**
 * مفتاح التشفير يُخزَّن داخل قاعدة بيانات Supabase الخاصة بالمستخدم،
 * لذلك يبقى ثابتًا حتى لو انتقل المشروع إلى حساب Lovable آخر وضاعت الأسرار.
 * متغير البيئة (إن وُجد) يُستخدم كقيمة أولية ويُنسخ إلى قاعدة البيانات مرة واحدة.
 */
async function key(): Promise<Buffer> {
  if (cached) return cached;

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data, error } = await supabaseAdmin
    .from("app_runtime_secrets")
    .select("value")
    .eq("name", SECRET_NAME)
    .maybeSingle();
  if (error) throw error;

  if (data?.value) {
    cached = Buffer.from(data.value, "base64");
    return cached;
  }

  const fromEnv = process.env[SECRET_NAME];
  const raw = fromEnv && fromEnv.length > 0 ? fromEnv : randomBytes(32).toString("base64");

  const { error: insertError } = await supabaseAdmin
    .from("app_runtime_secrets")
    .upsert({ name: SECRET_NAME, value: raw }, { onConflict: "name" });
  if (insertError) throw insertError;

  cached = Buffer.from(raw, "base64");
  return cached;
}

export async function encryptConnectionKey(plaintext: string): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export async function decryptConnectionKey(stored: string): Promise<string> {
  const buf = Buffer.from(stored, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", await key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
