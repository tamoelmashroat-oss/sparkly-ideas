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
- Supabase transfers run as resumable server-side jobs (`transfer_jobs` table + `src/lib/transferEngine.server.ts`); each advance does a bounded slice and saves a cursor, so work never depends on one long request or an open browser.
- Background progress when no tab is open comes from `/api/public/transfer-tick` being called by an external scheduler; open tabs also advance jobs via `nudgeTransferJobs`.
- Supabase access tokens are saved per user, encrypted, in app_user_connections (connector_id 'supabase'); the browser only sends a placeholder and server fns resolve it, so the real token never returns to the client.
- GitHub transfers use a transfer-local adaptive controller in `src/lib/githubAdaptive.server.ts`, loaded only inside server execution: 3–6 healthy blob pipelines, decreasing to 1 on limits, gradual recovery, shared account cooldown and ≥1 second mutation spacing. Respect Retry-After/primary reset, otherwise 60s→90s, with at most five retries after the initial request; this avoids secondary-limit retry storms without browser execution.
- Independently hash decoded source bytes using Git's blob object format and verify created blob SHAs before building the GitHub tree; drain each batch before failure and publish only after all copies succeed, preserving integrity when adaptive batch sizes change.
- GitHub transfers currently execute in one server request, not the resumable Supabase job engine; do not claim durable background continuation or checkpointed GitHub retries.
- Resolve the app's own repository identity at build time from hosting checkout metadata, GitHub remotes, then the newest Lovable "Sync from owner/repo" commit using `scripts/repository.ts`, caching the result in `scripts/repository.json` because publish builds lack Git history; keep source helpers outside ignored build-output directories so deployment receives them. Inject only sanitized owner/name through Vite and share `AppBrandName` across navigation. Do not guess from transfer selections or expose remote credentials; missing metadata leaves the suffix hidden, and repository moves require a fresh build.
- The repository GitHub button uses the same detected owner/name as the brand, opens in a new tab, and stays outside navigation links to avoid nested anchors; hide it when repository metadata is unavailable.
