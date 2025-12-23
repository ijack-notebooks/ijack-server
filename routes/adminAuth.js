const express = require("express");
const router = express.Router();
const Admin = require("../models/Admin");
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../middleware/auth");

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
      },
    });
  } catch (error) {
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
      },
    });
  }
);

module.exports = router;
