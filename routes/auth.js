const express = require("express");
const router = express.Router();
const User = require("../models/User");
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../middleware/auth");
const { OAuth2Client } = require("google-auth-library");

// Generate JWT token
const generateToken = (userId) => {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "7d" });
};

// Register
router.post("/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ message: "Please provide all fields" });
    }

    // Check if user exists
    const existingUser = await User.findOne({
      $or: [{ email }, { username }],
    });

    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    const user = new User({ username, email, password });
    await user.save();

    const token = generateToken(user._id);

    res.status(201).json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Login
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: "Please provide username and password" });
    }

    const user = await User.findOne({ username });

    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = generateToken(user._id);

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Google OAuth (direct): verify Google ID token and issue our JWT
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

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
    const name = payload.name || payload.given_name || email.split("@")[0];

    let user = await User.findOne({ email });

    if (!user) {
      const username = email.replace(/@.*$/, "").replace(/[^a-z0-9]/gi, "_").toLowerCase() || "user";
      let uniqueUsername = username;
      let suffix = 0;
      while (await User.findOne({ username: uniqueUsername })) {
        uniqueUsername = `${username}${++suffix}`;
      }
      user = new User({
        username: uniqueUsername,
        email,
        password: null,
      });
      await user.save();
    }

    const token = generateToken(user._id);

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
      },
    });
  } catch (error) {
    console.error("Google auth error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Get current user
router.get("/me", require("../middleware/auth").auth, async (req, res) => {
  res.json({
    user: {
      id: req.user._id,
      username: req.user.username,
      email: req.user.email,
    },
  });
});

module.exports = router;

