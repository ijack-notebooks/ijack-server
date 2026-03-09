-- =============================================================================
-- Invoices Storage Bucket (Supabase Storage)
-- Run this in Supabase SQL Editor if you prefer SQL over the Node script.
-- Alternatively run: node scripts/createInvoicesBucket.js
-- =============================================================================

-- Create the Invoices bucket (private; PDFs accessed via signed URLs)
-- Recommended: use Node script instead: node scripts/createInvoicesBucket.js
INSERT INTO storage.buckets (id, name, public)
VALUES ('Invoices', 'Invoices', false)
ON CONFLICT (id) DO NOTHING;

-- Allow backend access to upload/read/update invoice PDFs.
-- Run these if your uploads fail with:
-- "new row violates row-level security policy"
DROP POLICY IF EXISTS "Service role can upload invoices" ON storage.objects;
DROP POLICY IF EXISTS "Service role can read invoices" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can upload invoices" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can read invoices" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can update invoices" ON storage.objects;

CREATE POLICY "Anon and authenticated can upload invoices"
ON storage.objects FOR INSERT
TO anon, authenticated, service_role
WITH CHECK (bucket_id = 'Invoices');

CREATE POLICY "Anon and authenticated can read invoices"
ON storage.objects FOR SELECT
TO anon, authenticated, service_role
USING (bucket_id = 'Invoices');

CREATE POLICY "Anon and authenticated can update invoices"
ON storage.objects FOR UPDATE
TO anon, authenticated, service_role
USING (bucket_id = 'Invoices')
WITH CHECK (bucket_id = 'Invoices');

-- Optional: allow authenticated users with role 'admin' to read (if you use custom auth)
-- CREATE POLICY "Admins can read invoices"
-- ON storage.objects FOR SELECT
-- TO authenticated
-- USING (bucket_id = 'Invoices' AND auth.jwt() ->> 'role' = 'admin');
