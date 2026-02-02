-- =====================================================
-- Supabase Storage Bucket Setup Script
-- Run this in Supabase SQL Editor
-- =====================================================

-- Step 1: Create the storage bucket
-- Using a function to bypass RLS if needed

DO $$
BEGIN
  -- Check if bucket exists
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'product-images') THEN
    -- Insert bucket (this may require superuser or bypassing RLS)
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'product-images',
      'product-images',
      true, -- Public bucket
      10485760, -- 10MB file size limit (10485760 bytes = 10MB)
      ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
    );
    RAISE NOTICE 'Bucket "product-images" created successfully';
  ELSE
    RAISE NOTICE 'Bucket "product-images" already exists';
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Insufficient privileges. Please create the bucket via Dashboard first, then run the rest of this script for RLS policies.';
  WHEN OTHERS THEN
    RAISE NOTICE 'Error creating bucket: %. Please create it via Dashboard first, then run the rest of this script.', SQLERRM;
END $$;

-- Step 2: Disable RLS on storage.objects for this bucket (or create permissive policies)
-- Note: Service role should bypass RLS, but if RLS is enabled, we need permissive policies

-- First, check if RLS is enabled and disable it for service_role operations
-- Or create policies that allow all operations for authenticated users

-- Drop all existing policies for product-images bucket
DROP POLICY IF EXISTS "Public Access for product-images" ON storage.objects;
DROP POLICY IF EXISTS "Service role can upload to product-images" ON storage.objects;
DROP POLICY IF EXISTS "Service role can update product-images" ON storage.objects;
DROP POLICY IF EXISTS "Service role can delete from product-images" ON storage.objects;
DROP POLICY IF EXISTS "Allow all for product-images" ON storage.objects;

-- Create a single permissive policy that allows all operations for product-images bucket
-- This allows service_role and any authenticated user to manage files
CREATE POLICY "Allow all for product-images"
ON storage.objects
FOR ALL
USING (bucket_id = 'product-images')
WITH CHECK (bucket_id = 'product-images');

-- Also ensure public can read (since bucket is public)
CREATE POLICY "Public Access for product-images"
ON storage.objects
FOR SELECT
USING (bucket_id = 'product-images');

-- Step 3: Grant necessary permissions and ensure service_role can bypass RLS
-- Grant usage on storage schema
GRANT USAGE ON SCHEMA storage TO service_role;
GRANT ALL ON storage.objects TO service_role;
GRANT ALL ON storage.buckets TO service_role;

-- Ensure service_role can bypass RLS (if possible)
-- Note: In Supabase, service_role should bypass RLS by default
-- But if RLS is still blocking, the policies above should allow it

-- Step 4: Verify bucket was created
SELECT 
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types,
  created_at
FROM storage.buckets
WHERE id = 'product-images';

-- =====================================================
-- If the INSERT above fails due to RLS, try this alternative:
-- =====================================================

-- Alternative: Create bucket with explicit owner
-- Uncomment and run if the above INSERT fails:

/*
DO $$
BEGIN
  -- Check if bucket exists
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'product-images') THEN
    -- Insert bucket
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'product-images',
      'product-images',
      true,
      10485760,
      ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
    );
    
    RAISE NOTICE 'Bucket "product-images" created successfully';
  ELSE
    RAISE NOTICE 'Bucket "product-images" already exists';
  END IF;
END $$;
*/
