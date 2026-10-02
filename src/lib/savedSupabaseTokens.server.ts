// Server-only: each user's Supabase access tokens, stored encrypted so they
// survive page reloads, sign-outs and finished jobs. Never sent back to the browser.
import { decryptConnectionKey, encryptConnectionKey } from "./connectionKeyCrypto.server";

export type TokenSide = "source" | "target";
const CONNECTOR = "supabase";

/** Placeholder the browser sends instead of the real token when one is saved. */
export const SAVED_TOKEN = { source: "__saved:source__", target: "__saved:target__" } as const;

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

export async function saveSupabaseToken(userId: string, side: TokenSide, token: string) {
  const db = await admin();
  const { error } = await db.from("app_user_connections").upsert(
    {
      user_id: userId,
      connector_id: CONNECTOR,
      slot: side,
      connection_key_ciphertext: await encryptConnectionKey(token),
      reconnect_required: false,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,connector_id,slot" },
  );
  if (error) throw error;
}

export async function savedSupabaseSides(userId: string): Promise<Record<TokenSide, boolean>> {
  const db = await admin();
  const { data } = await db
    .from("app_user_connections")
    .select("slot")
    .eq("user_id", userId)
    .eq("connector_id", CONNECTOR);
  const s = new Set((data ?? []).map((r) => r.slot));
  return { source: s.has("source"), target: s.has("target") };
}

export async function forgetSupabaseToken(userId: string, side: TokenSide) {
  const db = await admin();
  await db
    .from("app_user_connections")
    .delete()
    .eq("user_id", userId)
    .eq("connector_id", CONNECTOR)
    .eq("slot", side);
}

/** Turns a placeholder into the user's saved token; real tokens pass through. */
export async function resolveSupabaseToken(userId: string, token: string): Promise<string> {
  const t = token.trim();
  const side = (Object.keys(SAVED_TOKEN) as TokenSide[]).find((k) => SAVED_TOKEN[k] === t);
  if (!side) return t;
  const db = await admin();
  const { data } = await db
    .from("app_user_connections")
    .select("connection_key_ciphertext")
    .eq("user_id", userId)
    .eq("connector_id", CONNECTOR)
    .eq("slot", side)
    .maybeSingle();
  if (!data) throw new Error("الرمز المحفوظ غير موجود — أدخل رمز الوصول من جديد.");
  return decryptConnectionKey(data.connection_key_ciphertext);
}
