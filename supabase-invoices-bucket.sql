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

-- Allow service role / authenticated backend to upload and read
-- Policy: Allow insert for authenticated (backend uses service role)
CREATE POLICY "Service role can upload invoices"
ON storage.objects FOR INSERT
TO service_role
WITH CHECK (bucket_id = 'Invoices');

CREATE POLICY "Service role can read invoices"
ON storage.objects FOR SELECT
TO service_role
USING (bucket_id = 'Invoices');

-- Optional: allow authenticated users with role 'admin' to read (if you use custom auth)
-- CREATE POLICY "Admins can read invoices"
-- ON storage.objects FOR SELECT
-- TO authenticated
-- USING (bucket_id = 'Invoices' AND auth.jwt() ->> 'role' = 'admin');
