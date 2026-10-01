INSERT INTO public.user_roles (user_id, role)
VALUES ('ede9016e-212d-4389-b9b0-0251bcf88e29', 'admin')
ON CONFLICT (user_id, role) DO NOTHING;