const express = require("express");
const router = express.Router();
const Admin = require("../models/Admin");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const { JWT_SECRET } = require("../middleware/auth");

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const ALLOWED_ADMIN_EMAIL = "notebookijack@gmail.com";

// Generate JWT token for admin
const generateToken = (adminId) => {
  return jwt.sign({ adminId, type: "admin" }, JWT_SECRET, { expiresIn: "24h" });
};

// Admin Login
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res
        .status(400)
        .json({ message: "Please provide username and password" });
    }

    const admin = await Admin.findOne({ username });

    if (!admin) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const isMatch = await admin.comparePassword(password);

    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = generateToken(admin._id);

    res.json({
      token,
      admin: {
        id: admin._id,
        username: admin.username,
        email: admin.email,
        role: admin.role || "secondary-admin",
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Admin Google login – only notebookijack@gmail.com is allowed
router.post("/google", async (req, res) => {
  try {
    const { id_token } = req.body;

    if (!id_token) {
      return res.status(400).json({ message: "Google ID token is required" });
    }

    if (!GOOGLE_CLIENT_ID) {
      return res.status(503).json({
        message: "Google sign-in is not configured. Set GOOGLE_CLIENT_ID in server .env",
      });
    }

    const client = new OAuth2Client(GOOGLE_CLIENT_ID);
    const ticket = await client.verifyIdToken({
      idToken: id_token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(401).json({ message: "Invalid or expired Google sign-in" });
    }

    const email = payload.email.toLowerCase().trim();
    const isSuperAdmin = email === ALLOWED_ADMIN_EMAIL;

    // Allow: super-admin email OR any admin that was invited by email (has this email in Admin collection)
    let admin = await Admin.findOne({ email });
    if (!admin && !isSuperAdmin) {
      return res.status(403).json({
        message: "Only authorized admins can sign in. This Google account is not allowed.",
      });
    }

    if (!admin) {
      const username = email.replace(/@.*$/, "").replace(/[^a-z0-9]/gi, "_").toLowerCase() || "admin";
      let uniqueUsername = username;
      let suffix = 0;
      while (await Admin.findOne({ username: uniqueUsername })) {
        uniqueUsername = `${username}${++suffix}`;
      }
      admin = new Admin({
        username: uniqueUsername,
        email,
        password: require("crypto").randomBytes(32).toString("hex"),
        role: isSuperAdmin ? "super-admin" : "secondary-admin",
      });
      await admin.save();
    } else if (isSuperAdmin && admin.role !== "super-admin") {
      admin.role = "super-admin";
      await admin.save();
    }

    const token = generateToken(admin._id);

    res.json({
      token,
      admin: {
        id: admin._id,
        username: admin.username,
        email: admin.email,
        role: admin.role || "secondary-admin",
      },
    });
  } catch (error) {
    console.error("Admin Google auth error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Get current admin
router.get(
  "/me",
  require("../middleware/adminAuth").adminAuth,
  async (req, res) => {
    res.json({
      admin: {
        id: req.admin._id,
        username: req.admin.username,
        email: req.admin.email,
        role: req.admin.role || "secondary-admin",
      },
    });
  }
);

module.exports = router;
