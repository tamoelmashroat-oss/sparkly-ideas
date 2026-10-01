import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  ArrowLeftRight,
  CheckCircle2,
  ExternalLink,
  Github,
  Loader2,
  Play,
  ShieldCheck,
  Unplug,
  XCircle,
} from "lucide-react";
import { listRepos, transferRepo, type TransferSummary } from "@/lib/github.functions";
import {
  completeGithubConnect,
  disconnectGithub,
  getConnections,
  startGithubConnect,
  type Slot,
} from "@/lib/githubConnect.functions";
import { Button } from "@/components/ui/button";
import { RepoCombobox } from "@/components/RepoCombobox";

export const Route = createFileRoute("/_authenticated/transfer")({
  validateSearch: (search: Record<string, unknown>): { mode?: "same" } =>
    search["mode"] === "same" ? { mode: "same" } : {},
  head: () => ({
    meta: [
      { title: "نقل المستودعات — اربط حسابَي GitHub" },
      {
        name: "description",
        content:
          "اربط حساب GitHub المصدر وحساب GitHub الهدف، ثم انقل أي مستودع بينهما بمزامنة كاملة.",
      },
      { property: "og:title", content: "نقل المستودعات بين حسابَي GitHub" },
      {
        property: "og:description",
        content: "اربط حسابيك وانقل المستودعات بمزامنة كاملة: إضافة، تحديث، وحذف الزائد.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: TransferPage,
});

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

function waitForOAuthCompletion(popup: Window) {
  return new Promise<{ code: string; state: string } | null>((resolve, reject) => {
    let poll: number | undefined;
    let timeout: number | undefined;
    // GitHub's security headers can cut the link between the popup and this page
    // (window.opener becomes null), so also listen on a same-origin BroadcastChannel.
    const channel =
      typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("github-oauth") : null;
    let closedAt: number | undefined;
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      channel?.close();
      if (poll !== undefined) window.clearInterval(poll);
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
    const handle = (raw: unknown) => {
      const data = raw as { type?: string; connectorId?: string; code?: unknown; state?: unknown } | null;
      const type = data?.type;
      if (
        data?.connectorId !== "github" ||
        (type !== "appUserConnectorOAuthComplete" && type !== "appUserConnectorOAuthFailed")
      )
        return;
      cleanup();
      if (type === "appUserConnectorOAuthComplete") {
        resolve(
          typeof data.code === "string" && typeof data.state === "string"
            ? { code: data.code, state: data.state }
            : null,
        );
        return;
      }
      popup.close();
      reject(new Error("لم تكتمل عملية ربط حساب GitHub."));
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      handle(event.data);
    };
    window.addEventListener("message", onMessage);
    if (channel) channel.onmessage = (event) => handle(event.data);
    poll = window.setInterval(() => {
      if (!popup.closed) return;
      closedAt ??= Date.now();
      if (Date.now() - closedAt < 3000) return; // give the broadcast time to arrive
      cleanup();
      reject(new Error("أُغلقت نافذة الربط قبل اكتمالها."));
    }, 500);
    timeout = window.setTimeout(() => {
      cleanup();
      popup.close();
      reject(new Error("انتهت مهلة ربط GitHub. حاول مرة أخرى."));
    }, 10 * 60 * 1000);
  });
}


function StatChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "added" | "updated" | "deleted" | "kept";
}) {
  const toneClass = {
    added: "text-success border-success/30 bg-success/10",
    updated: "text-primary border-primary/30 bg-primary/10",
    deleted: "text-destructive border-destructive/30 bg-destructive/10",
    kept: "text-muted-foreground border-border bg-muted/40",
  }[tone];
  return (
    <div
      className={`grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl border px-3 py-3 sm:px-4 ${toneClass}`}
    >
      <span className="min-w-0 break-words text-sm">{label}</span>
      <span className="mono shrink-0 text-xl font-medium sm:text-2xl">{value}</span>
    </div>
  );
}

function FileList({ title, files }: { title: string; files: string[] }) {
  if (files.length === 0) return null;
  return (
    <details className="group min-w-0 rounded-xl border border-border bg-card/60">
      <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-sm text-foreground">
        <span className="min-w-0 break-words">{title}</span>
        <span className="mono text-xs text-muted-foreground">{files.length} ملف</span>
      </summary>
      <ul className="mono max-h-64 space-y-1 overflow-y-auto border-t border-border px-4 py-3 text-xs text-muted-foreground">
        {files.map((f) => (
          <li key={f} className="truncate" dir="ltr">
            {f}
          </li>
        ))}
      </ul>
    </details>
  );
}

function TransferPage() {
  const queryClient = useQueryClient();

  const getConnectionsFn = useServerFn(getConnections);
  const startConnectFn = useServerFn(startGithubConnect);
  const completeConnectFn = useServerFn(completeGithubConnect);
  const disconnectFn = useServerFn(disconnectGithub);
  const listReposFn = useServerFn(listRepos);
  const transferFn = useServerFn(transferRepo);

  const connectionsQuery = useQuery({
    queryKey: ["github-connections"],
    queryFn: () => getConnectionsFn(),
  });

  const connections = connectionsQuery.data ?? [];
  const sourceConn = connections.find((c) => c.slot === "source");
  const targetConn = connections.find((c) => c.slot === "target");
  const search = Route.useSearch();
  const [sameAccount, setSameAccount] = useState(search.mode === "same");
  const bothConnected = sameAccount
    ? Boolean(sourceConn?.connected)
    : Boolean(sourceConn?.connected && targetConn?.connected);

  const [connectMessage, setConnectMessage] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [busySlot, setBusySlot] = useState<Slot | null>(null);

  const sourceRepos = useQuery({
    queryKey: ["repos", "source"],
    queryFn: () => listReposFn({ data: { slot: "source" as Slot } }),
    enabled: Boolean(sourceConn?.connected),
  });
  const targetRepos = useQuery({
    queryKey: ["repos", "target"],
    queryFn: () => listReposFn({ data: { slot: "target" as Slot } }),
    enabled: Boolean(targetConn?.connected),
  });

  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [dryRun, setDryRun] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const transfer = useMutation({
    mutationFn: (vars: {
      source: string;
      target: string;
      dryRun: boolean;
      confirmDelete: boolean;
      sameAccount: boolean;
    }) =>
      transferFn({ data: vars }),
  });

  async function connect(slot: Slot) {
    setConnectError(null);
    setConnectMessage(null);
    setBusySlot(slot);
    const popup = window.open("", "github-oauth", "width=620,height=740");
    if (!popup) {
      setBusySlot(null);
      setConnectError("النوافذ المنبثقة محجوبة. اسمح بها ثم حاول مرة أخرى.");
      return;
    }
    try {
      const startResult = await startConnectFn({ data: { slot } });
      if (!startResult.ok) {
        const { stage, code, message, details } = startResult.error;
        throw new Error(
          [`المرحلة: ${stage}`, `رمز الخطأ: ${code}`, message, ...details].join("\n"),
        );
      }
      const completion = waitForOAuthCompletion(popup);
      popup.location.href = startResult.authorizationUrl;
      const result = await completion;
      if (result) {
        const res = await completeConnectFn({ data: result });
        setConnectMessage(
          `تم ربط ${slot === "source" ? "حساب المصدر" : "حساب الهدف"}${
            res.accountLogin ? ` (${res.accountLogin})` : ""
          } بنجاح.`,
        );
      } else {
        setConnectMessage("اكتملت الموافقة على الصلاحيات.");
      }

      await queryClient.invalidateQueries({ queryKey: ["github-connections"] });
      await queryClient.invalidateQueries({ queryKey: ["repos", slot] });
    } catch (err) {
      popup.close();
      setConnectError(err instanceof Error ? err.message : "فشل ربط الحساب.");
    } finally {
      setBusySlot(null);
    }
  }

  async function disconnect(slot: Slot) {
    setConnectError(null);
    setConnectMessage(null);
    setBusySlot(slot);
    try {
      await disconnectFn({ data: { slot } });
      setConnectMessage("تم فصل الحساب.");
      await queryClient.invalidateQueries({ queryKey: ["github-connections"] });
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : "فشل فصل الحساب.");
    } finally {
      setBusySlot(null);
    }
  }

  const srcValid = REPO_PATTERN.test(source.trim());
  const tgtValid = REPO_PATTERN.test(target.trim());
  const sameRepo =
    srcValid && tgtValid && source.trim().toLowerCase() === target.trim().toLowerCase();
  const canRun =
    bothConnected &&
    srcValid &&
    tgtValid &&
    !sameRepo &&
    (dryRun || confirmDelete) &&
    !transfer.isPending;
  const summary: TransferSummary | undefined = transfer.data;

  function ConnectionCard({ slot }: { slot: Slot }) {
    const conn = slot === "source" ? sourceConn : targetConn;
    const busy = busySlot === slot;
    return (
      <div className="min-w-0 flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 sm:p-5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Github className="h-4 w-4 text-primary" />
          {slot === "source" ? "حساب المصدر" : "حساب الهدف"}
        </div>

        {conn?.connected ? (
          <div className="flex min-w-0 items-center gap-3">
            {conn.accountAvatarUrl && (
              <img
                src={conn.accountAvatarUrl}
                alt=""
                className="h-9 w-9 shrink-0 rounded-full border border-border"
              />
            )}
            <div className="flex min-w-0 flex-col">
              <span className="mono truncate text-sm" dir="ltr">
                {conn.accountLogin ?? "متصل"}
              </span>
              <span className="text-xs text-success">مربوط</span>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {slot === "source"
              ? "اربط الحساب الذي يحتوي المستودع الذي تريد نقله."
              : "اربط الحساب الذي ستُكتب فيه المستودعات."}
          </p>
        )}

        {conn?.reconnectRequired && (
          <p className="text-xs text-destructive">
            انتهت صلاحية الوصول لهذا الحساب — أعد الربط.
          </p>
        )}

        <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
          <Button
            type="button"
            onClick={() => connect(slot)}
            disabled={busy}
            size="sm"
            className="w-full sm:w-auto"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Github className="h-3.5 w-3.5" />}
            {conn?.connected ? "إعادة الربط" : "اربط حساب GitHub"}
          </Button>
          {conn?.connected && (
            <Button
              type="button"
              onClick={() => disconnect(slot)}
              disabled={busy}
              size="sm"
              variant="outline"
              className="w-full sm:w-auto"
            >
              <Unplug className="h-3.5 w-3.5" />
              فصل
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell min-h-screen overflow-x-hidden">
      <div className="app-grid-bg min-h-screen">
        <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-4 pb-12 sm:px-5 sm:pb-16">
          <header className="flex flex-col gap-3 py-6 sm:py-10">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                <ArrowLeftRight className="h-5 w-5" />
              </span>
              <h1 className="truncate text-xl font-bold sm:text-2xl">نقل المستودعات</h1>
            </div>
            <p className="max-w-2xl break-words text-sm leading-6 text-muted-foreground">
              اربط حسابَي GitHub الخاصين بك (المصدر والهدف)، ثم انقل أي مستودع بينهما.
            </p>
          </header>

          <main className="flex flex-col gap-5">
            <section className="grid gap-4 sm:grid-cols-2">
              <ConnectionCard slot="source" />
              <ConnectionCard slot="target" />
            </section>

            {connectMessage && (
              <div className="flex items-start gap-3 rounded-xl border border-success/40 bg-success/10 px-4 py-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                <p className="text-sm text-success">{connectMessage}</p>
              </div>
            )}
            {connectError && (
              <div className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="whitespace-pre-wrap text-sm leading-6 text-destructive" dir="auto">
                  {connectError}
                </p>
              </div>
            )}

            <section className="min-w-0 rounded-2xl border border-border bg-card p-4 shadow-lg shadow-background/20 sm:p-6">
              <div className="flex flex-col gap-5">
                <div className="grid grid-cols-2 gap-1 rounded-xl border border-border bg-muted/40 p-1 text-sm">
                  {[
                    { v: false, l: "بين حسابين مختلفين" },
                    { v: true, l: "داخل نفس الحساب" },
                  ].map((o) => (
                    <button
                      key={o.l}
                      type="button"
                      onClick={() => {
                        setSameAccount(o.v);
                        setTarget("");
                        transfer.reset();
                      }}
                      className={`rounded-lg px-3 py-2 transition-colors ${
                        sameAccount === o.v
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {o.l}
                    </button>
                  ))}
                </div>
                {sameAccount && (
                  <p className="text-xs leading-5 text-muted-foreground">
                    مزامنة كاملة بين مستودعين في حساب المصدر: تُضاف ملفات المصدر الجديدة، وتُحدَّث الملفات
                    المتشابهة، وتُحذف ملفات الهدف التي لا مقابل لها — مع حماية ملفات ربط Lovable.
                  </p>
                )}
                <div className="flex flex-col gap-2">
                  <label htmlFor="source" className="text-sm font-medium">
                    المستودع المصدر
                  </label>
                  <RepoCombobox
                    id="source"
                    repos={sourceRepos.data ?? []}
                    value={source}
                    onChange={setSource}
                    loading={sourceRepos.isFetching}
                    disabled={!sourceConn?.connected}
                    error={
                      sourceRepos.isError
                        ? (sourceRepos.error as Error).message
                        : null
                    }
                    onRefresh={() => sourceRepos.refetch()}
                    placeholder={
                      sourceConn?.connected
                        ? "اختر مستودعًا من حساب المصدر…"
                        : "اربط حساب المصدر أولًا"
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    من حساب المصدر — يُنقل محتوى الفرع الافتراضي بالكامل.
                  </p>
                </div>

                <div className="flex items-center gap-3 text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  <ArrowLeftRight className="h-4 w-4 text-primary" />
                  <span className="h-px flex-1 bg-border" />
                </div>

                <div className="flex flex-col gap-2">
                  <label htmlFor="target" className="text-sm font-medium">
                    المستودع الهدف
                  </label>
                  <RepoCombobox
                    id="target"
                    repos={((sameAccount ? sourceRepos.data : targetRepos.data) ?? []).filter((r) => r.canPush)}
                    value={target}
                    onChange={setTarget}
                    loading={sameAccount ? sourceRepos.isFetching : targetRepos.isFetching}
                    disabled={sameAccount ? !sourceConn?.connected : !targetConn?.connected}
                    error={
                      targetRepos.isError
                        ? (targetRepos.error as Error).message
                        : null
                    }
                    onRefresh={() => (sameAccount ? sourceRepos.refetch() : targetRepos.refetch())}
                    placeholder={
                      sameAccount
                        ? sourceConn?.connected
                          ? "اختر مستودعًا آخر من نفس الحساب…"
                          : "اربط حساب المصدر أولًا"
                        : targetConn?.connected
                        ? "اختر مستودعًا من حساب الهدف…"
                        : "اربط حساب الهدف أولًا"
                    }
                    emptyText="لا يوجد مستودع مطابق تملك صلاحية الكتابة عليه."
                  />
                  <p className="text-xs text-muted-foreground">
                    {sameAccount
                      ? "من نفس حساب المصدر — يجب أن تملك صلاحية الكتابة عليه."
                      : "من حساب الهدف — يجب أن يملك صلاحية الكتابة عليه."}
                  </p>
                </div>

                {sameRepo && (
                  <p className="text-sm text-destructive">
                    اختر مستودعين مختلفين — المصدر والهدف متطابقان.
                  </p>
                )}
                {!bothConnected && (
                  <p className="text-sm text-muted-foreground">
                    {sameAccount ? "اربط حساب المصدر أعلاه لتفعيل النقل." : "اربط الحسابين أعلاه لتفعيل النقل."}
                  </p>
                )}

                <div className="grid min-w-0 grid-cols-1 gap-4 border-t border-border pt-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <div className="min-w-0 flex flex-col gap-3">
                    <label className="flex cursor-pointer items-center gap-3 text-sm">
                      <input
                        type="checkbox"
                        checked={dryRun}
                        onChange={(e) => setDryRun(e.target.checked)}
                        className="h-4 w-4 accent-[var(--primary)]"
                      />
                       <span className="min-w-0 break-words text-muted-foreground">
                        تجربة بدون تنفيذ (اعرض التغييرات فقط)
                      </span>
                    </label>
                    {!dryRun && (
                      <label className="flex cursor-pointer items-center gap-3 text-sm">
                        <input
                          type="checkbox"
                          checked={confirmDelete}
                          onChange={(e) => setConfirmDelete(e.target.checked)}
                          className="h-4 w-4 accent-[var(--primary)]"
                        />
                         <span className="min-w-0 break-words text-muted-foreground">
                          أوافق على حذف الملفات الزائدة من الهدف
                        </span>
                      </label>
                    )}
                  </div>

                  <Button
                    type="button"
                    disabled={!canRun}
                    onClick={() =>
                      transfer.mutate({
                        source: source.trim(),
                        target: target.trim(),
                        dryRun,
                        confirmDelete: dryRun || confirmDelete,
                        sameAccount,
                      })
                    }
                    size="lg"
                    className="w-full sm:w-auto"
                  >
                    {transfer.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                    {dryRun ? "اعرض التغييرات" : "ابدأ النقل"}
                  </Button>
                </div>

                {transfer.isPending && (
                  <p className="text-sm text-muted-foreground">
                    جارٍ النقل… قد يستغرق وقتًا حسب حجم المستودع.
                  </p>
                )}

                {transfer.isError && (
                  <div className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3">
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    <p className="mono text-sm text-destructive" dir="auto">
                      {transfer.error.message}
                    </p>
                  </div>
                )}
              </div>
            </section>

            <section className="min-w-0 rounded-2xl border border-border bg-card/60 p-4 sm:p-6">
              <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
                <ShieldCheck className="h-4 w-4 text-primary" />
                منطق النقل
              </h2>
              <ol className="space-y-2 text-sm text-muted-foreground">
                <li>١. كل ما في المستودع المصدر يُنقل إلى المستودع الهدف.</li>
                <li>٢. الملفات الموجودة في الاثنين تُحدَّث بنسخة المصدر الجديدة.</li>
                <li>٣. الملفات الموجودة في الهدف فقط تُحذف.</li>
                <li>
                  ٤. ملفات ربط Lovable في الهدف (مجلد{" "}
                  <span className="mono text-foreground" dir="ltr">
                    .lovable
                  </span>
                  ) تُستثنى وتبقى كما هي.
                </li>
              </ol>
            </section>

            {summary && (
              <section className="min-w-0 flex flex-col gap-4 rounded-2xl border border-border bg-card p-4 sm:p-6">
                <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <h2 className="flex min-w-0 items-start gap-2 text-sm font-semibold">
                    <CheckCircle2 className="h-4 w-4 text-success" />
                    {summary.dryRun
                      ? "نتيجة المعاينة (لم يُنفَّذ أي تغيير)"
                      : summary.committed
                        ? "تم النقل بنجاح"
                        : "لا توجد تغييرات — الهدف مطابق للمصدر"}
                  </h2>
                  {summary.targetUrl && (
                    <a
                      href={`${summary.targetUrl}/tree/${encodeURIComponent(summary.targetBranch)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-w-0 items-center gap-1.5 text-xs text-primary hover:underline"
                    >
                      <span className="truncate">
                        {summary.target} ({summary.targetBranch})
                      </span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>

                <p className="min-w-0 break-all text-xs text-muted-foreground">
                  <span className="mono" dir="ltr">
                    {summary.source}
                  </span>{" "}
                  →{" "}
                  <span className="mono" dir="ltr">
                    {summary.target}
                  </span>{" "}
                  (الفرع{" "}
                  <span className="mono" dir="ltr">
                    {summary.targetBranch}
                  </span>
                  )
                </p>

                {!summary.dryRun && !summary.committed && (
                  <p className="min-w-0 break-words rounded-lg border border-border bg-muted p-3 text-xs leading-6 text-muted-foreground">
                    لم يُكتب أي شيء: المستودع الهدف مطابق للمصدر بالفعل، فلا توجد تغييرات لنقلها.
                  </p>
                )}

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <StatChip label="مضاف" value={summary.added.length} tone="added" />
                  <StatChip label="محدَّث" value={summary.updated.length} tone="updated" />
                  <StatChip label="محذوف" value={summary.deleted.length} tone="deleted" />
                  <StatChip label="بدون تغيير" value={summary.unchanged} tone="kept" />
                </div>

                <div className="flex flex-col gap-2">
                  <FileList title="ملفات مضافة" files={summary.added} />
                  <FileList title="ملفات محدَّثة" files={summary.updated} />
                  <FileList title="ملفات محذوفة" files={summary.deleted} />
                  {summary.preservedLovable.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      حُفظت {summary.preservedLovable.length} ملف ربط Lovable في الهدف دون
                      تغيير.
                    </p>
                  )}
                  {summary.skipped.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      تُجاهل: {summary.skipped.length} عنصر (مثل الوحدات الفرعية).
                    </p>
                  )}
                </div>

                {summary.committed && summary.commitSha && (
                  <p className="mono text-xs text-muted-foreground" dir="ltr">
                    commit: {summary.commitSha.slice(0, 10)}
                  </p>
                )}
              </section>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
