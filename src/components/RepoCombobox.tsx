import { useState } from "react";
import { Check, ChevronsUpDown, Loader2, Lock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import type { RepoInfo } from "@/lib/github.functions";

export type RepoComboboxProps = {
  id?: string;
  repos: RepoInfo[];
  value: string;
  onChange: (value: string) => void;
  loading?: boolean;
  disabled?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  placeholder?: string;
  emptyText?: string;
};

function split(fullName: string): { owner: string; name: string } {
  const i = fullName.lastIndexOf("/");
  if (i === -1) return { owner: "", name: fullName };
  return { owner: fullName.slice(0, i), name: fullName.slice(i + 1) };
}

function RepoList({
  repos,
  value,
  emptyText,
  onPick,
  compact,
}: {
  repos: RepoInfo[];
  value: string;
  emptyText: string;
  onPick: (v: string) => void;
  compact: boolean;
}) {
  return (
    <Command
      filter={(itemValue, search) =>
        itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
      }
    >
      <div className="shrink-0 border-b bg-popover">
        {/* text-base (16px) prevents iOS auto-zoom on focus */}
        <CommandInput
          placeholder="ابحث باسم المستودع…"
          dir="ltr"
          className="h-11 text-base sm:text-sm"
        />
      </div>
      <CommandList className="max-h-[45dvh] overscroll-contain sm:max-h-[380px]">
        <CommandEmpty>{emptyText}</CommandEmpty>
        <div className="divide-y divide-border">
          {repos.map((repo) => {
            const { owner, name } = split(repo.fullName);
            const isSelected = value === repo.fullName;
            return (
              <CommandItem
                key={repo.fullName}
                value={`${repo.fullName} ${repo.description ?? ""}`}
                onSelect={() => onPick(repo.fullName)}
                className={cn(
                  "gap-2.5 rounded-none px-3.5",
                  compact ? "py-3" : "py-3.5",
                  "data-[selected=true]:bg-accent",
                  isSelected && "bg-primary/10",
                )}
              >
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span
                    className="truncate text-[15px] font-semibold leading-snug sm:text-sm"
                    dir="ltr"
                  >
                    {name}
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="mono truncate" dir="ltr">
                      {owner}
                    </span>
                    {repo.isPrivate && <Lock className="h-3 w-3 shrink-0" />}
                  </span>
                </span>
                {isSelected && <Check className="h-4 w-4 shrink-0 text-primary" />}
              </CommandItem>
            );
          })}
        </div>
      </CommandList>
    </Command>
  );
}

export function RepoCombobox({
  id,
  repos,
  value,
  onChange,
  loading = false,
  disabled = false,
  error = null,
  onRefresh,
  placeholder = "اختر مستودعًا…",
  emptyText = "لا توجد مستودعات مطابقة.",
}: RepoComboboxProps) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const selected = value ? split(value) : null;

  const pick = (v: string) => {
    onChange(v === value ? "" : v);
    setOpen(false);
  };

  return (
    <div className="min-w-0 flex flex-col gap-2">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-stretch gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              id={id}
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              disabled={disabled || loading}
              className="h-auto min-h-14 min-w-0 w-full justify-between gap-3 rounded-xl px-4 py-2.5"
            >
              <span className="grid min-w-0 gap-0.5 text-start">
                <span
                  className={cn(
                    "truncate text-sm font-semibold leading-snug",
                    !selected && "font-normal text-muted-foreground",
                  )}
                  dir={selected ? "ltr" : "auto"}
                >
                  {selected ? selected.name : placeholder}
                </span>
                {selected && (
                  <span className="mono truncate text-xs text-muted-foreground" dir="ltr">
                    {selected.owner}
                  </span>
                )}
              </span>
              {loading ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin opacity-60" />
              ) : (
                <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-60" />
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            // Opens downward only, same width as the button, compact height with scroll.
            className="w-[var(--radix-popover-trigger-width)] overflow-hidden p-0"
            align="start"
            side="bottom"
            sideOffset={6}
            avoidCollisions={false}
            onOpenAutoFocus={(e) => {
              // Don't auto-focus search on mobile so the keyboard doesn't pop up on open.
              if (isMobile) e.preventDefault();
            }}
          >
            <RepoList
              repos={repos}
              value={value}
              emptyText={emptyText}
              onPick={pick}
              compact={isMobile}
            />
          </PopoverContent>
        </Popover>

        {onRefresh && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onRefresh}
            disabled={disabled || loading}
            aria-label="تحديث قائمة المستودعات"
            className="h-auto min-h-14 shrink-0 rounded-xl"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
        )}
      </div>

      {error && (
        <p className="text-xs text-destructive" dir="auto">
          {error}
        </p>
      )}
      {!error && !loading && !disabled && repos.length === 0 && (
        <p className="text-xs text-muted-foreground">لا توجد مستودعات في هذا الحساب.</p>
      )}
    </div>
  );
}
