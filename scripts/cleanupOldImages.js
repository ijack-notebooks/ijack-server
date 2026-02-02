require("dotenv").config();
const { cleanupOldImages } = require("../utils/supabaseStorage");

async function main() {
  try {
    console.log("🧹 Starting cleanup of old product images from server folder...");
    const deletedCount = await cleanupOldImages();
    console.log(`✅ Cleanup complete! Deleted ${deletedCount} old images.`);
    process.exit(0);
  } catch (error) {
    console.error("❌ Cleanup failed:", error);
    process.exit(1);
  }
}

main();
