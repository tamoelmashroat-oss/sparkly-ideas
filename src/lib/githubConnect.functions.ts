import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const GITHUB_SCOPES = ["read:user", "repo"];

export type Slot = "source" | "target";

export type ConnectionStatus = {
  slot: Slot;
  connected: boolean;
  accountLogin: string | null;
  accountAvatarUrl: string | null;
  reconnectRequired: boolean;
};

export type GithubConnectStartResult =
  | { ok: true; authorizationUrl: string }
  | {
      ok: false;
      error: { stage: string; code: string; message: string; details: string[] };
    };

const slotInput = z.object({ slot: z.enum(["source", "target"]) });

function appOrigin(): string | null {
  const request = getRequest();
  if (!request) return null;
  const url = new URL(request.url);
  const sandboxHost =
    url.hostname === "localhost" ? request.headers.get("x-forwarded-host") : null;
  return sandboxHost ? `https://${sandboxHost}` : url.origin;
}

/** حالة ربط الحسابين للمستخدم الحالي. */
export const getConnections = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ConnectionStatus[]> => {
    const { listConnectionsForUser } = await import("@/lib/appUserConnections.server");
    const rows = await listConnectionsForUser(context.userId);
    const slots: Slot[] = ["source", "target"];
    return slots.map((slot) => {
      const row = rows.find((r) => r.slot === slot);
      return {
        slot,
        connected: Boolean(row),
        accountLogin: row?.accountLogin ?? null,
        accountAvatarUrl: row?.accountAvatarUrl ?? null,
        reconnectRequired: row?.reconnectRequired ?? false,
      };
    });
  });

/** هل ضبط المدير تطبيق GitHub الخاص بالمشروع؟ */
export const getGithubSetupStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { isGithubOAuthConfigured } = await import("@/lib/githubOAuthConfig.server");
  return { configured: await isGithubOAuthConfigured() };
});

/** بدء ربط حساب GitHub لخانة معيّنة (مصدر/هدف). */
export const startGithubConnect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data) => slotInput.parse(data))
  .handler(async ({ data, context }): Promise<GithubConnectStartResult> => {
    const { getGithubOAuthConfig, signOAuthState } = await import(
      "@/lib/githubOAuthConfig.server"
    );
    const config = await getGithubOAuthConfig();
    if (!config) {
      return {
        ok: false,
        error: {
          stage: "التحقق من إعداد تطبيق GitHub",
          code: "GITHUB_APP_NOT_CONFIGURED",
          message: "لم يتم ضبط تطبيق GitHub الخاص بهذا الموقع بعد.",
          details: ["يرجى التواصل مع مدير التطبيق لإكمال الإعداد."],
        },
      };
    }

    const origin = appOrigin();
    if (!origin) {
      return {
        ok: false,
        error: {
          stage: "تحديد عنوان الرجوع",
          code: "REQUEST_CONTEXT_MISSING",
          message: "لم يتمكن الخادم من قراءة عنوان الصفحة الحالية.",
          details: ["تعذر إنشاء رابط الرجوع بعد موافقة GitHub."],
        },
      };
    }

    const state = await signOAuthState({ userId: context.userId, slot: data.slot });
    const authorizationUrl = new URL("https://github.com/login/oauth/authorize");
    authorizationUrl.searchParams.set("client_id", config.clientId);
    authorizationUrl.searchParams.set("redirect_uri", `${origin}/oauth/github/return`);
    authorizationUrl.searchParams.set("scope", GITHUB_SCOPES.join(" "));
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("allow_signup", "false");
    return { ok: true, authorizationUrl: authorizationUrl.toString() };
  });

/** إتمام الربط: تبديل الكود المؤقّت برمز وصول وحفظه مشفَّرًا. */
export const completeGithubConnect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data) =>
    z.object({ code: z.string().min(1), state: z.string().min(1) }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const { getGithubOAuthConfig, verifyOAuthState } = await import(
      "@/lib/githubOAuthConfig.server"
    );
    const config = await getGithubOAuthConfig();
    if (!config) throw new Error("لم يتم ضبط تطبيق GitHub الخاص بهذا الموقع.");

    const verified = await verifyOAuthState(data.state);
    if (!verified || verified.userId !== context.userId) {
      throw new Error("جلسة الربط غير صالحة أو منتهية. أعد المحاولة.");
    }
    const slot = verified.slot as Slot;
    const origin = appOrigin();

    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: data.code,
        ...(origin ? { redirect_uri: `${origin}/oauth/github/return` } : {}),
      }),
    });
    const tokenBody = (await tokenRes.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!tokenRes.ok || !tokenBody.access_token) {
      throw new Error(
        `تعذر إتمام ربط GitHub: ${tokenBody.error_description ?? tokenBody.error ?? tokenRes.status}`,
      );
    }
    const accessToken = tokenBody.access_token;

    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "repo-transfer-app",
      },
    });
    if (!userRes.ok) {
      const text = await userRes.text();
      throw new Error(
        `اكتملت الموافقة، لكن تعذر التحقق من حساب GitHub (${userRes.status}): ${text.slice(0, 200)}`,
      );
    }
    const profile = (await userRes.json()) as { login?: string; avatar_url?: string };
    if (!profile.login) throw new Error("لم يُرجع GitHub اسم الحساب بعد إتمام الربط.");

    const { saveConnectionForUser } = await import("@/lib/appUserConnections.server");
    await saveConnectionForUser({
      userId: context.userId,
      slot,
      connectionAPIKey: accessToken,
      accountLogin: profile.login,
      accountAvatarUrl: profile.avatar_url ?? null,
    });
    return { ok: true, accountLogin: profile.login, slot };
  });

/** فصل حساب GitHub عن خانة معيّنة. */
export const disconnectGithub = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data) => slotInput.parse(data))
  .handler(async ({ data, context }) => {
    const { getConnectionKeyForUser, deleteConnectionForUser } = await import(
      "@/lib/appUserConnections.server"
    );
    const { getGithubOAuthConfig } = await import("@/lib/githubOAuthConfig.server");
    const token = await getConnectionKeyForUser(context.userId, data.slot);
    const config = await getGithubOAuthConfig();
    if (token && config) {
      try {
        // إبطال رمز الوصول لدى GitHub.
        const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
        await fetch(`https://api.github.com/applications/${config.clientId}/token`, {
          method: "DELETE",
          headers: {
            Authorization: `Basic ${basic}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "repo-transfer-app",
          },
          body: JSON.stringify({ access_token: token }),
        });
      } catch (e) {
        console.error("github token revoke failed", e);
      }
    }
    await deleteConnectionForUser(context.userId, data.slot);
    return { ok: true };
  });
