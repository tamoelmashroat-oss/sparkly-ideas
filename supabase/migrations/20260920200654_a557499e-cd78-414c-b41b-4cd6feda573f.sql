CREATE POLICY "No direct client access to app_runtime_secrets"
ON public.app_runtime_secrets
FOR ALL
TO anon, authenticated
USING (false)
WITH CHECK (false);