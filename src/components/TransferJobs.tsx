import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, History, Square, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LiveProgress } from "@/components/LiveProgress";
import {
  cancelTransferJob,
  listTransferJobs,
  nudgeTransferJobs,
  type TransferJob,
} from "@/lib/transferJobs.functions";

export const KIND_LABEL: Record<TransferJob["kind"], string> = {
  db: "قاعدة البيانات",
  storage: "الملفات المخزَّنة",
  auth: "حسابات المستخدمين",
};
const UNIT: Record<TransferJob["kind"], string> = { db: "صفًا", storage: "ملفًا", auth: "حسابًا" };
const STATUS: Record<TransferJob["status"], string> = {
  running: "قيد التشغيل",
  completed: "اكتمل",
  failed: "فشل",
  cancelled: "أُلغي",
};

function duration(job: TransferJob): string {
  const end = job.finished_at ? new Date(job.finished_at).getTime() : Date.now();
  const s = Math.max(0, Math.round((end - new Date(job.started_at).getTime()) / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} س ${m % 60} د` : `${m} د ${s % 60} ث`;
}

/** Loads the user's jobs; while any runs, keeps advancing them and refreshing. */
export function useTransferJobs() {
  const list = useServerFn(listTransferJobs);
  const nudge = useServerFn(nudgeTransferJobs);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["transfer-jobs"],
    queryFn: () => list(),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((j) => j.status === "running") ? 3000 : false,
  });
  const anyRunning = (q.data ?? []).some((j) => j.status === "running");

  useEffect(() => {
    if (!anyRunning) return;
    let stop = false;
    (async () => {
      while (!stop) {
        try {
          await nudge();
        } catch {
          await new Promise((r) => setTimeout(r, 5000));
        }
        if (!stop) await qc.invalidateQueries({ queryKey: ["transfer-jobs"] });
        await new Promise((r) => setTimeout(r, 500));
      }
    })();
    return () => {
      stop = true;
    };
  }, [anyRunning, nudge, qc]);

  const jobs = q.data ?? [];
  const latest = (kind: TransferJob["kind"]) => jobs.find((j) => j.kind === kind) ?? null;
  return { jobs, latest, refresh: () => qc.invalidateQueries({ queryKey: ["transfer-jobs"] }) };
}

/** Live panel for the most recent job of one kind. */
export function JobPanel({ job, onChanged }: { job: TransferJob | null; onChanged: () => void }) {
  const cancel = useServerFn(cancelTransferJob);
  const logBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight;
  }, [job?.log.length]);
  if (!job) return null;
  const running = job.status === "running";
  const startedAt = new Date(job.started_at).getTime();
  const lastLine = job.log[job.log.length - 1] ?? "";

  return (
    <div className="flex flex-col gap-3">
      <LiveProgress
        done={Number(job.done)}
        total={Number(job.total)}
        unit={UNIT[job.kind]}
        running={running}
        stage={job.stage}
        startedAt={startedAt}
        estimate={job.counting}
        failed={job.status === "failed" || job.status === "cancelled"}
      />
      {running && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>يعمل على الخادم — يمكنك إغلاق الصفحة والعودة لاحقًا.</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={async () => {
              await cancel({ data: { id: job.id } });
              onChanged();
            }}
          >
            <Square className="h-3 w-3" />
            إلغاء
          </Button>
        </div>
      )}
      {job.status === "failed" && (
        <div className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <p className="whitespace-pre-wrap text-sm leading-6 text-destructive" dir="auto">
            {lastLine.replace(/^✕\s*/, "")}
          </p>
        </div>
      )}
      {job.status === "completed" && (
        <div className="flex items-start gap-3 rounded-xl border border-success/40 bg-success/10 px-4 py-3">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          <p className="text-sm text-success">
            اكتمل خلال {duration(job)}
            {job.errors.length ? ` — مع ${job.errors.length} تحذيرًا (انظر السجل)` : ""}.
          </p>
        </div>
      )}
      {job.log.length > 0 && (
        <div
          ref={logBox}
          className="mono max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-background/60 p-3 text-xs leading-6 text-muted-foreground"
          dir="auto"
        >
          {job.log.join("\n")}
        </div>
      )}
    </div>
  );
}

/** History of all transfers with expandable reports. */
export function JobHistory({ jobs }: { jobs: TransferJob[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (jobs.length === 0) return null;
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card p-4 sm:p-6">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <History className="h-4 w-4 text-primary" />
        عمليات النقل السابقة
      </h2>
      <ul className="flex flex-col gap-2">
        {jobs.map((j) => (
          <li key={j.id} className="rounded-xl border border-border bg-background/60">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 p-3 text-start"
              onClick={() => setOpen(open === j.id ? null : j.id)}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {KIND_LABEL[j.kind]} — {STATUS[j.status]}
                </p>
                <p className="truncate text-xs text-muted-foreground" dir="auto">
                  {new Date(j.started_at).toLocaleString("ar-EG")} · {j.source_name ?? j.source_ref} ←{" "}
                  {j.target_name ?? j.target_ref} · {duration(j)} · {Number(j.done).toLocaleString()}/
                  {Number(j.total).toLocaleString()}
                </p>
              </div>
              <ChevronDown
                className={`h-4 w-4 shrink-0 transition-transform ${open === j.id ? "rotate-180" : ""}`}
              />
            </button>
            {open === j.id && (
              <div className="flex flex-col gap-2 border-t border-border p-3">
                {j.errors.length > 0 && (
                  <p className="text-xs text-destructive">{j.errors.length} تحذيرًا</p>
                )}
                <div
                  className="mono max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-6 text-muted-foreground"
                  dir="auto"
                >
                  {j.log.join("\n") || "لا يوجد سجل."}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
