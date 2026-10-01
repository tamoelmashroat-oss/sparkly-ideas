// Server-only: إعدادات تطبيق GitHub OAuth المملوكة للمشروع (محفوظة في Supabase).
import { createHmac, timingSafeEqual } from "node:crypto";
import { decryptConnectionKey, encryptConnectionKey } from "./connectionKeyCrypto.server";

const CLIENT_ID_NAME = "GITHUB_OAUTH_CLIENT_ID";
const CLIENT_SECRET_NAME = "GITHUB_OAUTH_CLIENT_SECRET";

export type GithubOAuthConfig = { clientId: string; clientSecret: string };

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function readSecret(name: string): Promise<string | null> {
  const db = await admin();
  const { data, error } = await db
    .from("app_runtime_secrets")
    .select("value")
    .eq("name", name)
    .maybeSingle();
  if (error) throw error;
  return data?.value ?? null;
}

async function writeSecret(name: string, value: string) {
  const db = await admin();
  const { error } = await db
    .from("app_runtime_secrets")
    .upsert({ name, value }, { onConflict: "name" });
  if (error) throw error;
}

/** هل ضبط المدير تطبيق GitHub؟ */
export async function isGithubOAuthConfigured(): Promise<boolean> {
  const id = await readSecret(CLIENT_ID_NAME);
  const secret = await readSecret(CLIENT_SECRET_NAME);
  return Boolean(id && secret);
}

export async function getGithubOAuthConfig(): Promise<GithubOAuthConfig | null> {
  const clientId = await readSecret(CLIENT_ID_NAME);
  const stored = await readSecret(CLIENT_SECRET_NAME);
  if (!clientId || !stored) return null;
  return { clientId, clientSecret: await decryptConnectionKey(stored) };
}

export async function saveGithubOAuthConfig(config: GithubOAuthConfig) {
  await writeSecret(CLIENT_ID_NAME, config.clientId.trim());
  await writeSecret(CLIENT_SECRET_NAME, await encryptConnectionKey(config.clientSecret.trim()));
}

export async function clearGithubOAuthConfig() {
  const db = await admin();
  const { error } = await db
    .from("app_runtime_secrets")
    .delete()
    .in("name", [CLIENT_ID_NAME, CLIENT_SECRET_NAME]);
  if (error) throw error;
}

/** حالة OAuth موقّعة حتى لا يمكن التلاعب بها. */
async function stateKey(): Promise<Buffer> {
  // نشتق مفتاح التوقيع من سر التشفير المخزّن في قاعدة البيانات.
  const probe = await encryptConnectionKey("state-signing-probe");
  return createHmac("sha256", probe.slice(0, 32)).update("github-oauth-state").digest();
}

let cachedStateKey: Buffer | null = null;
async function signingKey(): Promise<Buffer> {
  if (!cachedStateKey) cachedStateKey = await stateKey();
  return cachedStateKey;
}

export async function signOAuthState(payload: { userId: string; slot: string }): Promise<string> {
  const body = Buffer.from(
    JSON.stringify({ ...payload, ts: Date.now() }),
    "utf8",
  ).toString("base64url");
  const sig = createHmac("sha256", await signingKey()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export async function verifyOAuthState(
  state: string,
): Promise<{ userId: string; slot: string } | null> {
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", await signingKey()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      userId: string;
      slot: string;
      ts: number;
    };
    if (Date.now() - parsed.ts > 15 * 60 * 1000) return null;
    return { userId: parsed.userId, slot: parsed.slot };
  } catch {
    return null;
  }
}
