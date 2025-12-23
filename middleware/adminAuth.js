const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");

const JWT_SECRET =
  process.env.JWT_SECRET || "your-secret-key-change-in-production";

const adminAuth = async (req, res, next) => {
  try {
    const token = req.header("Authorization")?.replace("Bearer ", "");

    if (!token) {
      return res
        .status(401)
        .json({ message: "No token, authorization denied" });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    // Check if token is for admin
    if (decoded.type !== "admin") {
      return res.status(401).json({ message: "Invalid token type" });
    }

    const admin = await Admin.findById(decoded.adminId).select("-password");

    if (!admin) {
      return res.status(401).json({ message: "Token is not valid" });
    }

    req.admin = admin;
    next();
  } catch (error) {
    res.status(401).json({ message: "Token is not valid" });
  }
};

module.exports = { adminAuth, JWT_SECRET };
