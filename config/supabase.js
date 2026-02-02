const { createClient } = require("@supabase/supabase-js");

// Supabase Configuration
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    "⚠️  Supabase credentials not found. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env for orders DB and product image storage.",
  );
} else {
  console.log("✅ Supabase configured (orders + product images)");
}

// Create Supabase client with service role key (for server-side operations)
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

module.exports = supabase;
