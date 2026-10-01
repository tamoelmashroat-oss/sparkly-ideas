CREATE TABLE public.transfer_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  kind text NOT NULL,
  source_ref text NOT NULL,
  target_ref text NOT NULL,
  source_name text,
  target_name text,
  status text NOT NULL DEFAULT 'running',
  stage text NOT NULL DEFAULT '',
  counting boolean NOT NULL DEFAULT false,
  done bigint NOT NULL DEFAULT 0,
  total bigint NOT NULL DEFAULT 0,
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  log text[] NOT NULL DEFAULT '{}',
  errors text[] NOT NULL DEFAULT '{}',
  tokens_ciphertext text,
  locked_until timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX transfer_jobs_user_idx ON public.transfer_jobs (user_id, created_at DESC);
CREATE INDEX transfer_jobs_status_idx ON public.transfer_jobs (status);

GRANT SELECT (id, user_id, kind, source_ref, target_ref, source_name, target_name, status, stage, counting, done, total, log, errors, started_at, finished_at, created_at, updated_at)
  ON public.transfer_jobs TO authenticated;
GRANT ALL ON public.transfer_jobs TO service_role;

ALTER TABLE public.transfer_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own transfer jobs"
  ON public.transfer_jobs FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE TRIGGER update_transfer_jobs_updated_at
  BEFORE UPDATE ON public.transfer_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();