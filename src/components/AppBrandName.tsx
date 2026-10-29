/** The checkout identity is injected by Vite for both SSR and the browser. */
export function AppBrandName() {
  const fullName = import.meta.env['VITE_CODE_REPOSITORY'] as string | undefined;
  const name = fullName?.split("/").at(-1);
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm font-semibold">
      <span className="shrink-0">ناقل المستودعات</span>
      {name && (
        <bdi title={fullName} className="min-w-0 break-all font-mono text-xs font-normal text-muted-foreground">
          ({name})
        </bdi>
      )}
    </span>
  );
}