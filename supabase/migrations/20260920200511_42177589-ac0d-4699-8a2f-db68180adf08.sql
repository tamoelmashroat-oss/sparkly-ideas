CREATE TABLE IF NOT EXISTS public.app_runtime_secrets (
  name text PRIMARY KEY,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON public.app_runtime_secrets FROM anon, authenticated;
GRANT ALL ON public.app_runtime_secrets TO service_role;

ALTER TABLE public.app_runtime_secrets ENABLE ROW LEVEL SECURITY;