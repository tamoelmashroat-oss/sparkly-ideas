import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowRight, CheckCircle2, Copy, Loader2, ShieldCheck } from "lucide-react";
import {
  clearGithubAppSettings,
  getGithubAppSettings,
  getIsAdmin,
  saveGithubAppSettings,
} from "@/lib/admin.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({
    meta: [
      { title: "إعدادات المدير — ناقل المستودعات" },
      {
        name: "description",
        content: "ضبط تطبيق GitHub OAuth الخاص بالموقع مرة واحدة لتعمل عمليات الربط لكل المستخدمين.",
      },
      { property: "og:title", content: "إعدادات المدير" },
      { property: "og:description", content: "ضبط تطبيق GitHub OAuth الخاص بالموقع." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminPage,
});

function AdminPage() {
  const queryClient = useQueryClient();
  const isAdminFn = useServerFn(getIsAdmin);
  const settingsFn = useServerFn(getGithubAppSettings);
  const saveFn = useServerFn(saveGithubAppSettings);
  const clearFn = useServerFn(clearGithubAppSettings);

  const adminQuery = useQuery({ queryKey: ["is-admin"], queryFn: () => isAdminFn() });
  const isAdmin = adminQuery.data?.isAdmin ?? false;

  const settingsQuery = useQuery({
    queryKey: ["github-app-settings"],
    queryFn: () => settingsFn(),
    enabled: isAdmin,
  });

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => saveFn({ data: { clientId, clientSecret } }),
    onSuccess: async () => {
      setError(null);
      setMessage("تم حفظ إعدادات تطبيق GitHub في قاعدة بياناتك.");
      setClientSecret("");
      await queryClient.invalidateQueries({ queryKey: ["github-app-settings"] });
    },
    onError: (e) => {
      setMessage(null);
      setError(e instanceof Error ? e.message : "تعذر الحفظ.");
    },
  });

  const clear = useMutation({
    mutationFn: () => clearFn(),
    onSuccess: async () => {
      setMessage("تم حذف الإعدادات.");
      await queryClient.invalidateQueries({ queryKey: ["github-app-settings"] });
    },
  });

  if (adminQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-8 text-center">
        <ShieldCheck className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">هذه الصفحة مخصّصة لمدير التطبيق فقط.</p>
        <Button asChild variant="outline">
          <Link to="/transfer" search={{}}>العودة</Link>
        </Button>
      </div>
    );
  }

  const settings = settingsQuery.data;

  return (
    <div className="mx-auto min-h-screen w-full max-w-2xl space-y-6 overflow-x-hidden px-4 py-8 sm:space-y-8 sm:p-10" dir="rtl">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">إعدادات المدير</h1>
        <p className="text-sm text-muted-foreground">
          اضبط تطبيق GitHub OAuth الخاص بك مرة واحدة. تُحفظ البيانات مشفّرة داخل قاعدة بياناتك،
          فتبقى معك إذا نقلت المشروع إلى أي حساب أو منصة أخرى.
        </p>
      </header>

      <section className="min-w-0 space-y-3 rounded-xl border border-border bg-card/60 p-4 text-sm sm:p-5">
        <h2 className="font-medium">خطوات الإعداد على GitHub</h2>
        <ol className="list-decimal space-y-2 pe-5 text-muted-foreground">
          <li>
            افتح{" "}
            <a
              className="text-primary underline"
              href="https://github.com/settings/developers"
              target="_blank"
              rel="noreferrer"
            >
              GitHub Developer settings
            </a>{" "}
            ثم أنشئ تطبيق OAuth جديد.
          </li>
          <li>ضع أي اسم للتطبيق، وعنوان الموقع هو عنوان تطبيقك.</li>
          <li className="space-y-2">
            <span>ضع عنوان الرجوع (Authorization callback URL) التالي:</span>
            <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <code className="mono block min-w-0 truncate rounded-md bg-muted px-2 py-1 text-xs" dir="ltr">
                {settings?.redirectUri ?? "…"}
              </code>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  if (settings?.redirectUri) navigator.clipboard.writeText(settings.redirectUri);
                  setMessage("تم نسخ عنوان الرجوع.");
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </span>
          </li>
          <li>انسخ Client ID، وأنشئ Client secret جديداً، ثم الصقهما بالأسفل.</li>
        </ol>
      </section>

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="clientId">Client ID</Label>
          <Input
            id="clientId"
            dir="ltr"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={settings?.clientId ?? "Ov23li..."}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="clientSecret">Client Secret</Label>
          <Input
            id="clientSecret"
            dir="ltr"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="••••••••••••••••"
          />
        </div>

        {settings?.configured ? (
          <p className="flex items-center gap-2 text-sm text-success">
            <CheckCircle2 className="h-4 w-4" />
            التطبيق مضبوط حالياً {settings.clientId ? `(${settings.clientId})` : ""}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">لم يتم ضبط التطبيق بعد.</p>
        )}

        {message && <p className="text-sm text-success">{message}</p>}
        {error && <p className="text-sm text-destructive whitespace-pre-line">{error}</p>}

        <div className="grid grid-cols-1 gap-3 sm:flex sm:flex-wrap">
          <Button className="w-full sm:w-auto" type="submit" disabled={save.isPending || !clientId || !clientSecret}>
            {save.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            حفظ الإعدادات
          </Button>
          {settings?.configured && (
            <Button
              type="button"
              variant="outline"
              onClick={() => clear.mutate()}
              disabled={clear.isPending}
              className="w-full sm:w-auto"
            >
              حذف الإعدادات
            </Button>
          )}
          <Button asChild variant="ghost" className="w-full sm:w-auto">
            <Link to="/transfer" search={{}}>
              <ArrowRight className="me-2 h-4 w-4" />
              صفحة النقل
            </Link>
          </Button>
        </div>
      </form>
    </div>
  );
}
