import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { JobKind } from "@/lib/transferEngine.server";

export type TransferJob = {
  id: string;
  kind: JobKind;
  source_ref: string;
  target_ref: string;
  source_name: string | null;
  target_name: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  stage: string;
  counting: boolean;
  done: number;
  total: number;
  log: string[];
  errors: string[];
  started_at: string;
  finished_at: string | null;
};

const SELECT =
  "id, kind, source_ref, target_ref, source_name, target_name, status, stage, counting, done, total, log, errors, started_at, finished_at";

export const startTransferJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      kind: JobKind;
      sourceToken: string;
      sourceRef: string;
      targetToken: string;
      targetRef: string;
      sourceName?: string;
      targetName?: string;
    }) => {
      if (!["db", "storage", "auth"].includes(input.kind)) throw new Error("نوع نقل غير معروف.");
      if (!input.sourceToken || !input.sourceRef || !input.targetToken || !input.targetRef)
        throw new Error("بيانات المصدر أو الهدف ناقصة.");
      if (input.sourceRef === input.targetRef) throw new Error("المصدر والهدف نفس المشروع.");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const { createJob } = await import("@/lib/transferEngine.server");
    const id = await createJob({
      userId: context.userId,
      kind: data.kind,
      sourceRef: data.sourceRef,
      targetRef: data.targetRef,
      sourceName: data.sourceName,
      targetName: data.targetName,
      tokens: { source: data.sourceToken.trim(), target: data.targetToken.trim() },
    });
    return { id };
  });

/** List the user's jobs (newest first). */
export const listTransferJobs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("transfer_jobs")
      .select(SELECT)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as TransferJob[];
  });

/**
 * Advance the caller's running jobs by one slice (keeps work moving while a
 * tab is open), then return them. Ownership is checked through RLS first.
 */
export const nudgeTransferJobs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("transfer_jobs")
      .select("id")
      .eq("status", "running");
    const { advanceJob } = await import("@/lib/transferEngine.server");
    await Promise.all((data ?? []).map((r) => advanceJob(r.id as string).catch(() => undefined)));
    return { ok: true };
  });

export const cancelTransferJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => {
    if (!input.id) throw new Error("معرّف مفقود.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { data: own } = await context.supabase
      .from("transfer_jobs")
      .select("id")
      .eq("id", data.id)
      .maybeSingle();
    if (!own) throw new Error("غير موجود.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin
      .from("transfer_jobs")
      .update({
        status: "cancelled",
        stage: "أُلغي",
        counting: false,
        finished_at: new Date().toISOString(),
        tokens_ciphertext: null,
      })
      .eq("id", data.id)
      .eq("status", "running");
    return { ok: true };
  });
