require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const connectDB = require("./config/database");

const app = express();
const PORT = process.env.PORT || 5002;

// Middleware
app.use(
  cors({
    origin: [
      "https://ijack-web.onrender.com",
      "https://ijack-web.vercel.app",
      "https://www.ijackstore.com",
      "https://ijackstore.com",
      "http://localhost:3000", // For local development
      process.env.FRONTEND_URL, // Allow custom frontend URL from env
    ].filter(Boolean), // Remove undefined values
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from uploads directory
const path = require("path");
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Connect to MongoDB
connectDB();

// Routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/notebooks", require("./routes/notebooks"));
app.use("/api/orders", require("./routes/orders"));
app.use("/api/payment", require("./routes/payment"));
app.use("/api/admin/auth", require("./routes/adminAuth"));
app.use("/api/admin", require("./routes/admin"));

// Basic route
app.get("/", (req, res) => {
  res.json({ message: "Ijack Notebooks Server is running!" });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    database:
      mongoose.connection.readyState === 1 ? "Connected" : "Disconnected",
    timestamp: new Date().toISOString(),
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
