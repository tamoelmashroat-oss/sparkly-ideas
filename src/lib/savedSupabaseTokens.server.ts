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

export type SavedSide = { saved: boolean; ref: string | null };

export async function savedSupabaseSides(userId: string): Promise<Record<TokenSide, SavedSide>> {
  const db = await admin();
  const { data } = await db
    .from("app_user_connections")
    .select("slot, remembered_ref")
    .eq("user_id", userId)
    .eq("connector_id", CONNECTOR);
  const bySlot = new Map((data ?? []).map((r) => [r.slot, r.remembered_ref as string | null]));
  return {
    source: { saved: bySlot.has("source"), ref: bySlot.get("source") ?? null },
    target: { saved: bySlot.has("target"), ref: bySlot.get("target") ?? null },
  };
}

/** Remember the picked project ref for a side (survives new devices/browsers). */
export async function saveSupabaseRef(userId: string, side: TokenSide, ref: string) {
  const db = await admin();
  await db
    .from("app_user_connections")
    .update({ remembered_ref: ref })
    .eq("user_id", userId)
    .eq("connector_id", CONNECTOR)
    .eq("slot", side);
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
