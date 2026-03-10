/**
 * Migration script: copy admins, categories, and notebooks from source DB to production DB.
 *
 * Usage:
 *   node scripts/migrate-to-production.js
 *
 * Requires in .env:
 *   MONGODB_URI              - source (development) MongoDB connection string
 *   MONGODB_URI_PRODUCTION   - destination (production) MongoDB connection string
 *
 * The script reads all documents from each collection in the source database,
 * replaces the same collections in the production database, and inserts the documents.
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const COLLECTIONS = ["admins", "categories", "notebooks"];

async function run() {
  const sourceUri = process.env.MONGODB_URI;
  const destUri = process.env.MONGODB_URI_PRODUCTION;

  if (!sourceUri) {
    console.error("Missing MONGODB_URI in .env");
    process.exit(1);
  }
  if (!destUri || destUri.includes("YOUR_PROD_CLUSTER")) {
    console.error("Missing or placeholder MONGODB_URI_PRODUCTION in .env. Set your production connection string.");
    process.exit(1);
  }

  console.log("Connecting to source database...");
  await mongoose.connect(sourceUri);
  const sourceConn = mongoose.connection;

  console.log("Connecting to production database...");
  const destConn = mongoose.createConnection(destUri);
  await new Promise((resolve, reject) => {
    destConn.once("open", resolve);
    destConn.once("error", reject);
  });

  try {
    for (const colName of COLLECTIONS) {
      const docs = await sourceConn.collection(colName).find({}).toArray();
      const count = docs.length;

      if (count === 0) {
        console.log(`  ${colName}: 0 documents (skipping)`);
        continue;
      }

      await destConn.collection(colName).deleteMany({});
      await destConn.collection(colName).insertMany(docs);
      console.log(`  ${colName}: ${count} documents copied`);
    }
    console.log("Migration completed successfully.");
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exit(1);
  } finally {
    await sourceConn.close();
    await destConn.close();
    console.log("Connections closed.");
    process.exit(0);
  }
}

run();
