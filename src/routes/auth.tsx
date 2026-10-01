import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ExternalLink, Github, Loader2, LogIn, UserPlus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/auth")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "تسجيل الدخول — ناقل المستودعات" },
      {
        name: "description",
        content:
          "سجّل الدخول أو أنشئ حسابًا لربط حسابَي GitHub وبدء نقل المستودعات بينهما.",
      },
      { property: "og:title", content: "تسجيل الدخول — ناقل المستودعات" },
      {
        property: "og:description",
        content: "دخول إلى ناقل المستودعات لربط حسابَي GitHub ونقل المستودعات.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsConfirm, setNeedsConfirm] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) navigate({ to: "/transfer", search: {}, replace: true });
    });
  }, [navigate]);

  function toArabic(message: string) {
    const m = message.toLowerCase();
    if (m.includes("email not confirmed")) {
      setNeedsConfirm(true);
      return "بريدك لم يُفعّل بعد. افتح رسالة التأكيد في بريدك واضغط الرابط، ثم عد وسجّل الدخول.";
    }
    if (m.includes("invalid login credentials"))
      return "البريد أو كلمة المرور غير صحيحة.";
    if (m.includes("already registered") || m.includes("already been registered"))
      return "هذا البريد مسجَّل بالفعل. استخدم «تسجيل الدخول».";
    if (m.includes("after") && m.includes("seconds")) {
      const s = message.match(/(\d+)\s*seconds/)?.[1] ?? "بعض";
      return `لأسباب أمنية، انتظر ${s} ثانية قبل المحاولة مرة أخرى.`;
    }
    if (m.includes("rate limit"))
      return "عدد المحاولات كبير. انتظر قليلًا ثم أعد المحاولة.";
    if (m.includes("password"))
      return "كلمة المرور قصيرة جدًا — استخدم 6 أحرف على الأقل.";
    return message;
  }

  async function resendConfirmation() {
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const { error } = await supabase.auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) throw error;
      setInfo("أرسلنا رابط تأكيد جديد إلى بريدك.");
    } catch (err) {
      setError(toArabic(err instanceof Error ? err.message : "تعذّر الإرسال."));
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setNeedsConfirm(false);
    setBusy(true);
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        if (!data.session) {
          setNeedsConfirm(true);
          setInfo("أنشئنا حسابك. افتح بريدك واضغط رابط التأكيد ثم سجّل الدخول.");
          return;
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      navigate({ to: "/transfer", search: {}, replace: true });
    } catch (err) {
      setError(toArabic(err instanceof Error ? err.message : "حدث خطأ غير متوقع."));
    } finally {
      setBusy(false);
    }
  }


  return (
    <div className="app-shell min-h-screen overflow-x-hidden">
      <div className="app-grid-bg min-h-screen">
        <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10 sm:px-5 sm:py-16">
          <Link to="/" className="mb-6 text-center text-sm text-muted-foreground hover:underline">
            ← عودة للصفحة الرئيسية
          </Link>
          <div className="min-w-0 rounded-2xl border border-border bg-card p-5 shadow-lg shadow-background/20 sm:p-6">
            <h1 className="text-xl font-bold">
              {mode === "signin" ? "تسجيل الدخول" : "إنشاء حساب"}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              حسابك هنا يحفظ ربط حسابَي GitHub الخاصين بك بشكل آمن.
            </p>

            <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <label htmlFor="email" className="text-sm font-medium">
                  البريد الإلكتروني
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  dir="ltr"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mono w-full rounded-xl border border-input bg-input/40 px-4 py-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
                />
              </div>
              <div className="flex flex-col gap-2">
                <label htmlFor="password" className="text-sm font-medium">
                  كلمة المرور
                </label>
                <input
                  id="password"
                  type="password"
                  required
                  minLength={6}
                  dir="ltr"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mono w-full rounded-xl border border-input bg-input/40 px-4 py-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
                />
              </div>

              {error && <p className="break-words text-sm text-destructive">{error}</p>}
              {info && <p className="break-words text-sm text-muted-foreground">{info}</p>}

              <Button
                type="submit"
                disabled={busy}
                size="lg"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : mode === "signin" ? (
                  <LogIn className="h-4 w-4" />
                ) : (
                  <UserPlus className="h-4 w-4" />
                )}
                {mode === "signin" ? "دخول" : "إنشاء حساب"}
              </Button>
            </form>

            <Button
              type="button"
              variant="link"
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin");
                setError(null);
                setInfo(null);
              }}
              className="mt-4 w-full"
            >
              {mode === "signin" ? "ليس لديك حساب؟ أنشئ حسابًا" : "لديك حساب؟ سجّل الدخول"}
            </Button>
          </div>

          <div className="mt-5 min-w-0 rounded-2xl border border-border bg-card/60 p-5 sm:mt-6 sm:p-6">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                <Github className="h-5 w-5 text-primary" />
              </div>
              <h2 className="font-bold">لا تملك حساب GitHub؟</h2>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              لربط مستودعاتك عبر OAuth ستحتاج حساب GitHub لكل طرف (المصدر
              والهدف). إنشاء الحساب مجاني ويستغرق دقيقة واحدة:
            </p>
            <ol className="mt-3 list-decimal space-y-1.5 pr-5 text-sm text-muted-foreground">
              <li>افتح صفحة التسجيل في GitHub.</li>
              <li>أدخل بريدك واختر كلمة مرور واسم مستخدم.</li>
              <li>أكّد بريدك ثم عُد هنا واربط حسابك بضغطة واحدة.</li>
            </ol>
            <Button asChild variant="outline" className="mt-4 w-full" size="lg">
              <a
                href="https://github.com/signup"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Github className="h-4 w-4" />
                إنشاء حساب GitHub مجاني
                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
              </a>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
