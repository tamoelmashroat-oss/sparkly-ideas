import { createFileRoute } from "@tanstack/react-router";
import { Database, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/supabase/within")({
  head: () => ({
    meta: [
      { title: "نقل بين مشاريع Supabase في نفس الحساب — قريبًا" },
      {
        name: "description",
        content: "انسخ قاعدة بيانات من مشروع إلى آخر داخل نفس حساب Supabase.",
      },
      { property: "og:title", content: "نقل بين مشاريع Supabase في نفس الحساب" },
      {
        property: "og:description",
        content: "قسم قيد الإعداد: انسخ قاعدة بيانات بين مشروعين داخل نفس حساب Supabase.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SupabaseWithinPage,
});

function SupabaseWithinPage() {
  return (
    <div className="app-shell min-h-screen overflow-x-hidden">
      <div className="app-grid-bg min-h-screen">
        <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-4 pb-12 sm:px-5 sm:pb-16">
          <header className="flex flex-col gap-3 py-6 sm:py-10">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                <Database className="h-5 w-5" />
              </span>
              <h1 className="min-w-0 break-words text-xl font-bold sm:text-2xl">
                نقل بين مشاريع في نفس حساب Supabase
              </h1>
            </div>
            <span className="mono w-fit rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs text-primary">
              قريبًا
            </span>
            <p className="max-w-2xl break-words text-sm leading-6 text-muted-foreground">
              انسخ قاعدة بيانات مشروع Supabase إلى مشروع آخر داخل نفس الحساب — الجداول، الأعمدة،
              البيانات، الدوال، وقواعد الحماية.
            </p>
          </header>

          <main className="flex flex-col gap-5">
            <section className="min-w-0 rounded-2xl border border-border bg-card p-4 shadow-lg shadow-background/20 sm:p-6">
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Clock className="h-4 w-4 text-primary" />
                  هذا القسم قيد الإعداد
                </div>
                <p className="break-words text-sm leading-6 text-muted-foreground">
                  سنضيف هنا خطوات النقل داخل نفس الحساب: اختيار المشروع المصدر والمشروع الهدف، ثم
                  نسخ كل المحتوى كما هو. لحد الآن يمكنك استخدام صفحة النقل بين الحسابات المختلفة.
                </p>
                <Button type="button" size="lg" disabled className="w-full sm:w-auto">
                  <Database className="h-4 w-4" />
                  قيد الإعداد
                </Button>
              </div>
            </section>
          </main>
        </div>
      </div>
    </div>
  );
}
