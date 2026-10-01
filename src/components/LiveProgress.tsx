import { useEffect, useRef, useState } from "react";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";

function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "--:--";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

/**
 * Live progress card.
 * - `stage`: what is happening right now (always shown while running).
 * - `startedAt`: start of the whole operation (elapsed counts from here).
 * - `estimate`: false during phases with no countable units → bar is
 *   indeterminate and remaining time shows "—" instead of a fake 00:00.
 */
export function LiveProgress({
  done,
  total,
  unit,
  running,
  stage,
  startedAt,
  estimate = true,
  failed = false,
}: {
  done: number;
  total: number;
  unit: string;
  running: boolean;
  stage?: string;
  startedAt?: number | null;
  estimate?: boolean;
  failed?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const endRef = useRef<number | null>(null);
  // Rate is measured only over the counting phase.
  const countStart = useRef<{ t: number; d: number } | null>(null);

  useEffect(() => {
    if (!running) {
      endRef.current = Date.now();
      return;
    }
    endRef.current = null;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  if (estimate && running && countStart.current === null) {
    countStart.current = { t: Date.now(), d: done };
  }
  if (!estimate) countStart.current = null;

  const t = endRef.current ?? now;
  const elapsed = startedAt ? (t - startedAt) / 1000 : 0;
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  const complete = !running && !failed && done >= total && total > 0;

  let remainingText = "—";
  if (complete) remainingText = "00:00";
  else if (running && estimate) {
    const cs = countStart.current;
    const secs = cs ? (t - cs.t) / 1000 : 0;
    const rate = secs > 0 ? (done - (cs?.d ?? 0)) / secs : 0;
    if (done >= total) remainingText = "—";
    else remainingText = rate > 0 ? fmt((total - done) / rate) : "جارٍ الحساب";
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium">
          {running ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
          ) : complete ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
          ) : failed ? (
            <XCircle className="h-4 w-4 shrink-0 text-destructive" />
          ) : null}
          {running ? stage ?? "جارٍ العمل…" : complete ? "اكتمل" : failed ? "توقّف" : "متوقف"}
        </span>
        <span className="text-2xl font-bold tabular-nums text-primary">
          {estimate || !running ? `${pct.toFixed(1)}%` : "…"}
        </span>
      </div>
      <div className="relative h-3 w-full overflow-hidden rounded-full bg-border">
        {running && !estimate ? (
          <div className="absolute inset-y-0 w-1/3 animate-pulse rounded-full bg-primary/60" />
        ) : (
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
        <div className="flex flex-col">
          <span>المنقول</span>
          <span className="font-medium tabular-nums text-foreground">
            {done.toLocaleString()} / {total.toLocaleString()} {unit}
          </span>
        </div>
        <div className="flex flex-col">
          <span>الوقت المنقضي</span>
          <span className="font-medium tabular-nums text-foreground" dir="ltr">
            {fmt(elapsed)}
          </span>
        </div>
        <div className="flex flex-col">
          <span>الوقت المتبقي</span>
          <span className="font-medium tabular-nums text-foreground" dir="ltr">
            {remainingText}
          </span>
        </div>
      </div>
    </div>
  );
}
