require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET_NAME = "Invoices";

async function createBucket() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("❌ Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env file");
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    console.log(`🪣 Creating storage bucket: ${BUCKET_NAME}...`);

    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    if (listError) {
      console.error("❌ Error listing buckets:", listError);
      process.exit(1);
    }
    const bucketExists = buckets?.some((b) => b.name === BUCKET_NAME);
    if (bucketExists) {
      console.log(`✅ Bucket "${BUCKET_NAME}" already exists!`);
      process.exit(0);
    }

    const { error } = await supabase.storage.createBucket(BUCKET_NAME, {
      public: false,
      fileSizeLimit: 5242880, // 5MB
      allowedMimeTypes: ["application/pdf"],
    });

    if (error) {
      if (error.message === "Bucket already exists") {
        console.log(`✅ Bucket "${BUCKET_NAME}" already exists!`);
      } else {
        console.error("❌ Error creating bucket:", error);
        process.exit(1);
      }
    } else {
      console.log(`✅ Successfully created bucket: ${BUCKET_NAME} (private, PDF only)`);
    }
    process.exit(0);
  } catch (error) {
    console.error("❌ Unexpected error:", error);
    process.exit(1);
  }
}

createBucket();
