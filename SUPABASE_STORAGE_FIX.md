# Fixing Supabase Storage RLS Error

If you're getting the error: **"new row violates row-level security policy"**, follow these steps:

## Step 1: Create the Bucket via Dashboard (Easiest Method)

1. Go to your Supabase Dashboard
2. Navigate to **Storage** in the left sidebar
3. Click **New bucket**
4. Configure:
   - **Name**: `product-images`
   - **Public bucket**: ✅ Enable
   - **File size limit**: 10 MB
   - **Allowed MIME types**: `image/jpeg`, `image/jpg`, `image/png`, `image/gif`, `image/webp`
5. Click **Create bucket**

## Step 2: Run the SQL Script for RLS Policies

1. Go to **SQL Editor** in Supabase Dashboard
2. Copy and paste the contents of `supabase-storage-bucket.sql`
3. Click **Run**

This will:

- Create permissive RLS policies that allow service_role to upload/update/delete
- Allow public read access
- Grant necessary permissions

## Step 3: Verify

After running the SQL script, try uploading a product image again. It should work now.

## Why This Happens

Supabase Storage has Row Level Security (RLS) enabled by default. Even though `service_role` should bypass RLS, sometimes the Storage API still requires explicit policies. The SQL script creates policies that allow all operations for the `product-images` bucket.

## Alternative: Disable RLS (Not Recommended)

If you still have issues, you can disable RLS entirely on `storage.objects`, but this is less secure:

```sql
ALTER TABLE storage.objects DISABLE ROW LEVEL SECURITY;
```

**Note**: This is not recommended for production. Use the policies approach instead.
