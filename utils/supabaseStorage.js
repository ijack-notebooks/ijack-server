const supabase = require("../config/supabase");
const fs = require("fs");
const path = require("path");

const BUCKET_NAME = "product-images";

/**
 * Upload image to Supabase Storage
 * @param {Buffer|Stream} fileBuffer - File buffer or stream
 * @param {String} fileName - Name for the file in storage
 * @param {String} mimeType - MIME type of the file
 * @returns {Promise<Object>} - Public URL of uploaded file
 */
async function uploadImageToSupabase(fileBuffer, fileName, mimeType) {
  if (!supabase) {
    throw new Error("Supabase not configured");
  }

  try {
    // Skip listBuckets() check - it can return empty due to RLS even when bucket exists.
    // Just attempt upload; Supabase will return a clear error if bucket is missing.

    // Upload file to Supabase Storage
    const filePath = `products/${fileName}`;
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(filePath, fileBuffer, {
        contentType: mimeType,
        upsert: true, // Replace if file already exists
      });

    if (error) {
      console.error("Supabase upload error:", error);
      throw error;
    }

    // Get public URL (getPublicUrl is synchronous)
    const urlResponse = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(filePath);

    // Extract public URL from response (handles different SDK versions)
    let publicUrl;
    if (urlResponse && urlResponse.data && urlResponse.data.publicUrl) {
      publicUrl = urlResponse.data.publicUrl;
    } else if (urlResponse && urlResponse.publicUrl) {
      publicUrl = urlResponse.publicUrl;
    } else {
      // Fallback: construct URL manually
      const supabaseUrl = process.env.SUPABASE_URL;
      publicUrl = `${supabaseUrl}/storage/v1/object/public/${BUCKET_NAME}/${filePath}`;
    }

    return {
      path: filePath,
      publicUrl: publicUrl,
      fullPath: data.path,
    };
  } catch (error) {
    console.error("Error uploading to Supabase Storage:", error);
    throw error;
  }
}

/**
 * Delete image from Supabase Storage
 * @param {String} filePath - Path to the file in storage
 * @returns {Promise<Boolean>} - Success status
 */
async function deleteImageFromSupabase(filePath) {
  if (!supabase) {
    return false;
  }

  try {
    // Extract path from full URL if needed
    let storagePath = filePath;
    if (filePath.includes(BUCKET_NAME)) {
      // Extract path after bucket name
      const parts = filePath.split(`${BUCKET_NAME}/`);
      storagePath = parts[1] || filePath;
    }

    const { error } = await supabase.storage
      .from(BUCKET_NAME)
      .remove([storagePath]);

    if (error) {
      console.error("Error deleting from Supabase Storage:", error);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Error deleting image from Supabase:", error);
    return false;
  }
}

/**
 * Delete old images from server's uploads folder
 * @param {String} imagePath - Path to the image file
 */
async function deleteLocalImage(imagePath) {
  try {
    if (!imagePath || !imagePath.startsWith("/uploads")) {
      return;
    }

    const filePath = path.join(__dirname, "..", imagePath);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`✅ Deleted local image: ${imagePath}`);
    }
  } catch (error) {
    console.error(`Error deleting local image ${imagePath}:`, error);
  }
}

/**
 * Clean up all old product images from server folder
 */
async function cleanupOldImages() {
  try {
    const uploadsDir = path.join(__dirname, "../uploads/images");

    if (!fs.existsSync(uploadsDir)) {
      console.log("No uploads directory found");
      return;
    }

    const files = fs.readdirSync(uploadsDir);
    let deletedCount = 0;

    for (const file of files) {
      if (file.startsWith("product-")) {
        const filePath = path.join(uploadsDir, file);
        try {
          fs.unlinkSync(filePath);
          deletedCount++;
        } catch (err) {
          console.error(`Error deleting ${file}:`, err);
        }
      }
    }

    console.log(
      `✅ Cleaned up ${deletedCount} old product images from server folder`,
    );
    return deletedCount;
  } catch (error) {
    console.error("Error cleaning up old images:", error);
    throw error;
  }
}

module.exports = {
  uploadImageToSupabase,
  deleteImageFromSupabase,
  deleteLocalImage,
  cleanupOldImages,
  BUCKET_NAME,
};
