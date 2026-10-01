import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/$")({
  beforeLoad: ({ params }) => {
    if (params._splat === "index") {
      throw redirect({ to: "/", replace: true });
    }
    throw notFound();
  },
  head: () => ({
    meta: [
      { title: "الصفحة غير موجودة — ناقل المستودعات" },
      { name: "description", content: "تعذّر العثور على الصفحة المطلوبة في ناقل المستودعات." },
      { property: "og:title", content: "الصفحة غير موجودة — ناقل المستودعات" },
      { property: "og:description", content: "تعذّر العثور على الصفحة المطلوبة في ناقل المستودعات." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
});