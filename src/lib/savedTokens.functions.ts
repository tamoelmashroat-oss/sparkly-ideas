import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const SAVED_TOKEN = { source: "__saved:source__", target: "__saved:target__" } as const;

/** Which sides have a saved token (the tokens themselves never leave the server). */
export const getSavedSupabaseTokens = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { savedSupabaseSides } = await import("@/lib/savedSupabaseTokens.server");
    return savedSupabaseSides(context.userId);
  });

export const forgetSavedSupabaseToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { side: "source" | "target" }) => {
    if (input.side !== "source" && input.side !== "target") throw new Error("جهة غير معروفة.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { forgetSupabaseToken } = await import("@/lib/savedSupabaseTokens.server");
    await forgetSupabaseToken(context.userId, data.side);
    return { ok: true };
  });
