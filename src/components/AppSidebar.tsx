import { useState, type ComponentType } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  Database,
  GitBranch,
  Github,
  Loader2,
  LogOut,
  Menu,
  ShieldCheck,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getIsAdmin } from "@/lib/admin.functions";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type NavItem = {
  to: string;
  label: string;
  search?: { mode: "same" };
  icon: ComponentType<{ className?: string }>;
  badge?: string;
};

const sections: { title: string; items: NavItem[] }[] = [
  {
    title: "GitHub",
    items: [
      {
        to: "/transfer",
        label: "نقل بين حسابات مختلفة",
        icon: ArrowLeftRight,
      },
      {
        to: "/transfer",
        search: { mode: "same" },
        label: "من مستودع لآخر في GitHub واحد",
        icon: GitBranch,
      },
    ],
  },
  {
    title: "Supabase",
    items: [
      {
        to: "/database",
        label: "نقل بين حسابات مختلفة",
        icon: ArrowLeftRight,
      },
      {
        to: "/supabase/within",
        label: "من مشروع لآخر داخل Supabase واحد",
        icon: Database,
        badge: "قريبًا",
      },
    ],
  },
];

function Brand() {
  return (
    <Link to="/transfer" search={{}} className="flex min-w-0 items-center gap-2.5 px-4 py-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
        <Github className="h-4 w-4" />
      </span>
      <span className="truncate text-sm font-semibold">ناقل المستودعات</span>
    </Link>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const location = useRouterState({ select: (s) => s.location });
  const path = location.pathname;
  const search = (location.search ?? {}) as { mode?: string };

  const isActive = (item: NavItem) => {
    if (item.to === "/transfer") {
      if (path !== "/transfer") return false;
      return item.search?.mode === "same" ? search.mode === "same" : search.mode !== "same";
    }
    return path === item.to || path.startsWith(item.to + "/");
  };

  return (
    <div className="flex flex-col gap-5 px-3 py-4">
      {sections.map((section) => (
        <div key={section.title} className="flex flex-col gap-1">
          <p className="mono px-2 pb-1 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
            {section.title}
          </p>
          {section.items.map((item) => (
            <Link
              key={item.label}
              to={item.to}
              search={() => item.search ?? {}}
              onClick={onNavigate}
              aria-current={isActive(item) ? "page" : undefined}
              className={cn(
                "flex min-w-0 items-start gap-2.5 rounded-xl px-2.5 py-2.5 text-sm transition-colors",
                isActive(item)
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <item.icon className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 break-words leading-6">{item.label}</span>
              {item.badge && (
                <span className="mono shrink-0 rounded-md border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] leading-5 text-muted-foreground">
                  {item.badge}
                </span>
              )}
            </Link>
          ))}
        </div>
      ))}
    </div>
  );
}

function BottomActions({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const getIsAdminFn = useServerFn(getIsAdmin);
  const adminQuery = useQuery({ queryKey: ["is-admin"], queryFn: () => getIsAdminFn() });
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="flex flex-col gap-1.5 border-t border-border p-3">
      {adminQuery.data?.isAdmin && (
        <Button asChild size="sm" variant="ghost" className="justify-start">
          <Link to="/admin" onClick={onNavigate}>
            <ShieldCheck className="h-4 w-4" />
            الإعدادات
          </Link>
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="justify-start"
        onClick={signOut}
        disabled={signingOut}
      >
        {signingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
        تسجيل الخروج
      </Button>
    </div>
  );
}

export function AppSidebar() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Mobile top bar with drawer */}
      <div className="sticky top-0 z-40 flex h-14 items-center justify-between gap-3 border-b border-border bg-background/95 px-4 backdrop-blur lg:hidden">
        <Brand />
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" size="icon" aria-label="القائمة" className="shrink-0 rounded-xl">
              <Menu className="h-4 w-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="flex w-72 flex-col gap-0 p-0">
            <SheetHeader className="p-0">
              <SheetTitle className="sr-only">القائمة</SheetTitle>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <NavList onNavigate={() => setOpen(false)} />
            </div>
            <BottomActions onNavigate={() => setOpen(false)} />
          </SheetContent>
        </Sheet>
      </div>

      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-72 shrink-0 flex-col border-s border-border bg-background/60 lg:flex">
        <Brand />
        <nav className="min-h-0 flex-1 overflow-y-auto" aria-label="التنقل الرئيسي">
          <NavList />
        </nav>
        <BottomActions />
      </aside>
    </>
  );
}
