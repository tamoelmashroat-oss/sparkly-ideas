import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type AdminSettings = {
  configured: boolean;
  clientId: string | null;
  redirectUri: string;
};

type AuthedContext = {
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> };
  userId: string;
};

async function assertAdmin(context: AuthedContext) {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw error;
  if (!data) throw new Error("هذه الصفحة مخصّصة لمدير التطبيق فقط.");
}

/** هل المستخدم الحالي مدير؟ */
export const getIsAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (error) throw error;
    return { isAdmin: Boolean(data) };
  });

/** قراءة إعدادات تطبيق GitHub (بدون كشف السر). */
export const getGithubAppSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AdminSettings> => {
    await assertAdmin(context as unknown as AuthedContext);
    const { getGithubOAuthConfig } = await import("@/lib/githubOAuthConfig.server");
    const { getRequest } = await import("@tanstack/react-start/server");
    const config = await getGithubOAuthConfig();
    const request = getRequest();
    const url = request ? new URL(request.url) : null;
    const sandboxHost =
      url && url.hostname === "localhost" ? request!.headers.get("x-forwarded-host") : null;
    const origin = sandboxHost ? `https://${sandboxHost}` : (url?.origin ?? "");
    return {
      configured: Boolean(config),
      clientId: config?.clientId ?? null,
      redirectUri: `${origin}/oauth/github/return`,
    };
  });

/** حفظ بيانات تطبيق GitHub OAuth الخاص بالمشروع. */
export const saveGithubAppSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data) =>
    z
      .object({ clientId: z.string().min(3), clientSecret: z.string().min(10) })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context as unknown as AuthedContext);
    const { saveGithubOAuthConfig } = await import("@/lib/githubOAuthConfig.server");
    await saveGithubOAuthConfig(data);
    return { ok: true };
  });

/** حذف إعدادات تطبيق GitHub. */
export const clearGithubAppSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context as unknown as AuthedContext);
    const { clearGithubOAuthConfig } = await import("@/lib/githubOAuthConfig.server");
    await clearGithubOAuthConfig();
    return { ok: true };
  });
