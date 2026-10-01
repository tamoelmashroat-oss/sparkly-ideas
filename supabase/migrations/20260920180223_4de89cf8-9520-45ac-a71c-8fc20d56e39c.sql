REVOKE ALL ON public.app_user_connections FROM anon, authenticated;

CREATE POLICY "No direct client access to app_user_connections"
ON public.app_user_connections
FOR ALL
TO anon, authenticated
USING (false)
WITH CHECK (false);