import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowLeftRight, CheckCircle2, Github, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ناقل المستودعات — نقل آمن بين حسابات GitHub" },
      {
        name: "description",
        content:
          "انقل محتوى مستودع GitHub من حساب إلى آخر، مع معاينة التغييرات والحفاظ على ملفات ربط Lovable.",
      },
      { property: "og:title", content: "ناقل المستودعات بين حسابات GitHub" },
      {
        property: "og:description",
        content: "اربط حسابَي GitHub، راجع التغييرات، ثم انقل المستودع بأمان.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: LandingPage,
});

const steps = [
  {
    icon: Github,
    title: "اربط الحسابين",
    text: "حدّد حساب المصدر وحساب الهدف بصورة مستقلة.",
  },
  {
    icon: ShieldCheck,
    title: "راجع قبل التنفيذ",
    text: "شغّل تجربة آمنة لترى الملفات المضافة والمحدّثة والمحذوفة.",
  },
  {
    icon: CheckCircle2,
    title: "انقل دفعة واحدة",
    text: "تُحفظ ملفات ربط Lovable في المستودع الهدف دون تغيير.",
  },
];

function LandingPage() {
  return (
    <main className="app-shell min-h-screen overflow-x-hidden">
      <div className="app-grid-bg min-h-screen">
        <div className="mx-auto flex w-full max-w-5xl flex-col px-4 pb-6 sm:px-8">

          <nav className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border py-3 sm:py-5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <ArrowLeftRight className="h-4 w-4" />
              </span>
              <span className="truncate text-sm font-semibold sm:text-base">ناقل المستودعات</span>
            </div>
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link to="/auth">تسجيل الدخول</Link>
            </Button>
          </nav>

          <section className="flex flex-col py-8 sm:py-16">
            <div className="min-w-0 max-w-3xl">
              <div className="mb-3 inline-flex max-w-full items-center gap-2 text-xs text-primary sm:mb-5 sm:text-sm">
                <Github className="h-4 w-4 shrink-0" />
                <span className="truncate">نقل مباشر بين حساباتك</span>
              </div>
              <h1 className="max-w-3xl break-words text-xl font-bold leading-[1.6] sm:text-5xl sm:leading-tight">
                انقل مستودع GitHub كاملًا، واعرف ما سيتغيّر قبل التنفيذ.
              </h1>
              <p className="mt-3 max-w-2xl break-words text-sm leading-6 text-muted-foreground sm:mt-6 sm:text-lg sm:leading-8">
                مزامنة محتوى الفرع الافتراضي من حساب المصدر إلى حساب الهدف، مع تحديث الملفات
                المتطابقة وحذف الزائد وحماية مجلد .lovable في الهدف.
              </p>
              <div className="mt-5 flex flex-col gap-2 sm:mt-8 sm:flex-row sm:flex-wrap">
                <Button asChild className="w-full sm:w-auto">
                  <Link to="/auth">
                    ابدأ النقل
                    <ArrowLeft className="h-4 w-4" />
                  </Link>
                </Button>
                <Button asChild variant="outline" className="w-full sm:w-auto">
                  <Link to="/auth">لديّ حساب</Link>
                </Button>
              </div>
              <div className="mt-4 rounded-xl border border-border bg-card/60 p-4">
                <h2 className="text-sm font-semibold">قسم جديد: نقل قاعدة بيانات Supabase</h2>
                <p className="mt-1.5 break-words text-xs leading-6 text-muted-foreground sm:text-sm">
                  انسخ قاعدة بيانات مشروع Supabase كما هي بالدقة — الجداول والبيانات وقواعد الحماية —
                  إلى مشروع في حساب آخر مختلف تمامًا.
                </p>
                <Button asChild variant="outline" size="sm" className="mt-3 w-full sm:w-auto">
                  <Link to="/auth">ابدأ نقل قاعدة البيانات</Link>
                </Button>
              </div>
            </div>
          </section>

          <section className="grid overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3 sm:gap-px">
            {steps.map(({ icon: Icon, title, text }, index) => (
              <article key={title} className="min-w-0 border-b border-border bg-background p-4 last:border-b-0 sm:border-b-0 sm:p-6">
                <div className="mb-3 flex items-center justify-between">
                  <Icon className="h-4 w-4 text-primary" />
                  <span className="mono text-xs text-muted-foreground">0{index + 1}</span>
                </div>
                <h2 className="break-words text-sm font-semibold sm:text-base">{title}</h2>
                <p className="mt-1.5 break-words text-xs leading-6 text-muted-foreground sm:text-sm">{text}</p>
              </article>
            ))}
          </section>


          <footer className="py-8 text-center text-xs text-muted-foreground">
            مفاتيح الربط مشفّرة، ولا تصل بيانات GitHub إلى المتصفح.
          </footer>
        </div>
      </div>
    </main>
  );
}