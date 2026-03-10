const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    const isProduction = process.env.NODE_ENV === "production";
    const uri =
      isProduction && process.env.MONGODB_URI_PRODUCTION
        ? process.env.MONGODB_URI_PRODUCTION
        : process.env.MONGODB_URI;

    if (!uri) {
      throw new Error(
        isProduction
          ? "MONGODB_URI_PRODUCTION is required in production"
          : "MONGODB_URI is required"
      );
    }

    const conn = await mongoose.connect(uri);
    console.log(`MongoDB Connected: ${conn.connection.host}${isProduction ? " (production)" : ""}`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};

// Handle connection events
mongoose.connection.on("connected", () => {
  console.log("Mongoose connected to MongoDB");
});

mongoose.connection.on("error", (err) => {
  console.error(`Mongoose connection error: ${err}`);
});

mongoose.connection.on("disconnected", () => {
  console.log("Mongoose disconnected");
});

// Graceful shutdown
process.on("SIGINT", async () => {
  await mongoose.connection.close();
  console.log("MongoDB connection closed through app termination");
  process.exit(0);
});

module.exports = connectDB;
