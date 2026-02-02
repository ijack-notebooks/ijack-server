# Supabase Storage Setup for Product Images

This guide will help you set up Supabase Storage to store product images instead of using the server's local file system.

## Step 1: Create Storage Bucket in Supabase

### Option A: Using SQL Script (Recommended if API fails)

1. Open your Supabase Dashboard
2. Go to **SQL Editor**
3. Copy and paste the contents of `supabase-storage-bucket.sql`
4. Click **Run** to execute the script

This will:
- Create the `product-images` bucket
- Set up Row Level Security (RLS) policies
- Grant necessary permissions
- Verify the bucket was created

### Option B: Using Node.js Script

Run the provided script to automatically create the bucket:

```bash
npm run create-bucket
```

**Note**: If you get an RLS policy error, use Option A (SQL script) instead.

### Option C: Manual Setup via Dashboard

1. Go to your Supabase Dashboard
2. Navigate to **Storage** in the left sidebar
3. Click **New bucket**
4. Configure the bucket:
   - **Name**: `product-images`
   - **Public bucket**: ✅ Enable (so images can be accessed via public URLs)
   - **File size limit**: 10 MB (or your preferred limit)
   - **Allowed MIME types**: 
     - `image/jpeg`
     - `image/jpg`
     - `image/png`
     - `image/gif`
     - `image/webp`
5. Click **Create bucket**
6. After creating, run the SQL script (`supabase-storage-bucket.sql`) to set up RLS policies

## Step 2: Configure Storage Policies (Optional but Recommended)

For better security, you can set up Row Level Security (RLS) policies:

1. Go to **Storage** > **Policies** > **product-images**
2. Create policies as needed (or use the default public access if bucket is public)

**Note**: Since we're using the `service_role` key on the backend, policies are not strictly required, but they're good practice.

## Step 3: Verify Configuration

Make sure your `.env` file has:
```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

## Step 4: Clean Up Old Images (Optional)

Run the cleanup script to delete old product images from the server folder:

```bash
npm run cleanup-images
```

This will delete all old product images from the `uploads/images` folder on your server.

## How It Works

- **New Products**: When you create a new product with an image, it's uploaded to Supabase Storage
- **Image URLs**: Images are stored with public URLs like: `https://[project].supabase.co/storage/v1/object/public/product-images/products/[filename]`
- **Automatic Cleanup**: Local files are automatically deleted after successful Supabase upload
- **Fallback**: If Supabase upload fails, images fall back to local storage

## Benefits

- ✅ **Scalable**: No server storage limits
- ✅ **CDN**: Supabase provides fast image delivery
- ✅ **Reliable**: Images persist even if server restarts
- ✅ **Easy Management**: Manage images through Supabase Dashboard

## Troubleshooting

1. **Images not uploading**: Check Supabase credentials in `.env`
2. **403 Forbidden**: Verify bucket is set to public or check storage policies
3. **Bucket not found**: Make sure you created the bucket with exact name `product-images`
