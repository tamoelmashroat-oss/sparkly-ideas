# Run Supabase transfers in the background, with saved reports

## Goal
A transfer keeps running on the server even if the user closes the tab, refreshes, loses internet, or signs out. When they come back they see live progress or the final report of the finished transfer.

## What the user will see
- "Start transfer" creates a saved job and returns immediately.
- The page shows the job's live progress (stage, %, elapsed, remaining), read from the server every few seconds, so a refresh or new device picks it up.
- A "Previous transfers" list showing each job: date, source → target, status (running / completed / failed / cancelled), duration, rows copied, warnings, and the full log.
- A "Cancel" button for a running job.
- Applies to database, storage files, and user accounts transfers (each a job type).

## How it works
```text
Browser --start--> server: save job (tokens encrypted) --> status "queued"
Scheduler (every minute) --> /api/public/transfer-tick (secret-protected)
   tick: pick running jobs, do work for ~25s, save position (stage, table, offset, log)
   repeat next minute until done --> status "completed"/"failed", tokens erased
Browser polls job row --> progress + report
```
Each tick resumes exactly where the last stopped (stage + table + offset), so nothing depends on the browser.

## Security
- Supabase access tokens are needed while the job runs, so they are stored **encrypted** (same encryption as GitHub connections) and **deleted** as soon as the job ends, fails, or is cancelled.
- Jobs table is readable only by its owner; tokens column is never sent to the browser.
- The tick endpoint requires the existing cron secret.

## Technical details
- Migration: `transfer_jobs` (user_id, kind, source_ref, target_ref, status, stage, cursor jsonb, done, total, log text[], errors text[], tokens_ciphertext, started_at, finished_at, heartbeat_at). Grants: authenticated select (own rows via RLS), service_role all. Locking via `heartbeat_at` so two ticks never process the same job.
- pg_cron + pg_net job calling `https://project--a59c242a-...lovable.app/api/public/transfer-tick` every minute with `LOVABLE_CRON_SECRET` header. Note: runs against the **published** app, so the app must be published for background jobs to run.
- Refactor current per-step server functions into a shared `*.server.ts` step engine used by the tick route; UI switches to start/poll/cancel server functions.
- Speed: ~25s of work per minute, so transfers take roughly 2x longer than the current in-browser flow.
