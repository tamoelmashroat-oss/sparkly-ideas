// Server-only storage helpers for per-app-user GitHub connections.
import { decryptConnectionKey, encryptConnectionKey } from "./connectionKeyCrypto.server";

export type Slot = "source" | "target";

export const CONNECTOR_ID = "github";

export type StoredConnection = {
  slot: Slot;
  accountLogin: string | null;
  accountAvatarUrl: string | null;
  reconnectRequired: boolean;
};

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

export async function saveConnectionForUser(args: {
  userId: string;
  slot: Slot;
  connectionAPIKey: string;
  accountLogin: string | null;
  accountAvatarUrl: string | null;
}) {
  const db = await admin();
  const { error } = await db.from("app_user_connections").upsert(
    {
      user_id: args.userId,
      connector_id: CONNECTOR_ID,
      slot: args.slot,
      connection_key_ciphertext: await encryptConnectionKey(args.connectionAPIKey),
      account_login: args.accountLogin,
      account_avatar_url: args.accountAvatarUrl,
      reconnect_required: false,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,connector_id,slot" },
  );
  if (error) throw error;
}

export async function getConnectionKeyForUser(
  userId: string,
  slot: Slot,
): Promise<string | null> {
  const db = await admin();
  const { data, error } = await db
    .from("app_user_connections")
    .select("connection_key_ciphertext")
    .eq("user_id", userId)
    .eq("connector_id", CONNECTOR_ID)
    .eq("slot", slot)
    .maybeSingle();
  if (error) throw error;
  return data ? await decryptConnectionKey(data.connection_key_ciphertext) : null;
}

export async function listConnectionsForUser(userId: string): Promise<StoredConnection[]> {
  const db = await admin();
  const { data, error } = await db
    .from("app_user_connections")
    .select("slot, account_login, account_avatar_url, reconnect_required")
    .eq("user_id", userId)
    .eq("connector_id", CONNECTOR_ID);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    slot: row.slot as Slot,
    accountLogin: row.account_login,
    accountAvatarUrl: row.account_avatar_url,
    reconnectRequired: row.reconnect_required,
  }));
}

export async function markReconnectRequired(userId: string, slot: Slot) {
  const db = await admin();
  await db
    .from("app_user_connections")
    .update({ reconnect_required: true })
    .eq("user_id", userId)
    .eq("connector_id", CONNECTOR_ID)
    .eq("slot", slot);
}

export async function deleteConnectionForUser(userId: string, slot: Slot) {
  const db = await admin();
  const { error } = await db
    .from("app_user_connections")
    .delete()
    .eq("user_id", userId)
    .eq("connector_id", CONNECTOR_ID)
    .eq("slot", slot);
  if (error) throw error;
}
