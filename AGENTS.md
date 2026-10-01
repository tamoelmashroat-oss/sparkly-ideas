<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Authenticated pages render inside a shared sidebar layout (`AppSidebar` in `src/routes/_authenticated/route.tsx`); page headers must not duplicate nav/admin/logout — the sidebar owns them.
- The sidebar's "من مستودع لآخر في GitHub واحد" deep-links to `/transfer?mode=same`, which preselects the same-account toggle on the transfer page.
- Use the splat route to redirect legacy `/index` visits to `/`; a dedicated index-named route collides with the root index route generator.
