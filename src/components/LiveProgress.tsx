import { useEffect, useRef, useState } from "react";
import { Loader2, CheckCircle2 } from "lucide-react";

function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "--:--";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

/** Live progress bar: percentage, elapsed time and estimated time remaining. */
export function LiveProgress({
  done,
  total,
  unit,
  running,
}: {
  done: number;
  total: number;
  unit: string;
  running: boolean;
}) {
  const startRef = useRef<number | null>(null);
  const endRef = useRef<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  if (running && startRef.current === null) {
    startRef.current = Date.now();
    endRef.current = null;
  }
  if (!running && startRef.current !== null && endRef.current === null) {
    endRef.current = Date.now();
  }

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  useEffect(() => {
    if (running && endRef.current !== null) {
      startRef.current = Date.now();
      endRef.current = null;
    }
  }, [running]);

  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  const start = startRef.current ?? now;
  const elapsed = ((endRef.current ?? now) - start) / 1000;
  const rate = elapsed > 0 ? done / elapsed : 0;
  const remaining = done >= total ? 0 : rate > 0 ? (total - done) / rate : NaN;
  const complete = done >= total && total > 0;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium">
          {running ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : complete ? (
            <CheckCircle2 className="h-4 w-4 text-primary" />
          ) : null}
          {running ? "جارٍ العمل…" : complete ? "اكتمل" : "متوقف"}
        </span>
        <span className="text-2xl font-bold tabular-nums text-primary">{pct.toFixed(1)}%</span>
      </div>
      <div className="relative h-3 w-full overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
        {running && (
          <div className="absolute inset-0 animate-pulse bg-gradient-to-l from-transparent via-background/20 to-transparent" />
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
            {running ? (isNaN(remaining) ? "جارٍ الحساب" : fmt(remaining)) : complete ? "00:00" : "--:--"}
          </span>
        </div>
      </div>
    </div>
  );
}
