require("dotenv").config();
const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const connectDB = require("../config/database");

const seedAdmin = async () => {
  try {
    await connectDB();

    // Check if admin already exists
    const existingAdmin = await Admin.findOne({ username: "suraj" });

    if (existingAdmin) {
      console.log("Admin user 'suraj' already exists. Updating password...");
      existingAdmin.password = "ijack-newton";
      await existingAdmin.save();
      console.log("✅ Admin password updated successfully!");
    } else {
      // Create admin user
      const admin = new Admin({
        username: "suraj",
        password: "ijack-newton",
      });
      await admin.save();
      console.log("✅ Admin user created successfully!");
    }

    console.log("\nAdmin credentials:");
    console.log("Username: suraj");
    console.log("Password: ijack-newton");

    process.exit(0);
  } catch (error) {
    console.error("Error seeding admin:", error);
    process.exit(1);
  }
};

seedAdmin();
