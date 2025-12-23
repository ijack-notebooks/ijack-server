require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");
const Notebook = require("../models/Notebook");
const connectDB = require("../config/database");

const notebooks = [
  {
    name: "Classic Spiral Notebook",
    description:
      "A timeless spiral-bound notebook perfect for everyday use. Features college-ruled pages and a durable cover.",
    price: 1080,
    category: "Spiral",
    pages: 100,
    size: "8.5 x 11 inches",
    inStock: true,
    stockQuantity: 50,
  },
  {
    name: "Premium Leather Journal",
    description:
      "Elegant leather-bound journal with high-quality paper. Perfect for writing, journaling, or taking notes.",
    price: 2490,
    category: "Journal",
    pages: 200,
    size: "6 x 9 inches",
    inStock: true,
    stockQuantity: 30,
  },
  {
    name: "Composition Notebook",
    description:
      "Traditional composition notebook with marbled cover. Great for students and professionals.",
    price: 750,
    category: "Composition",
    pages: 100,
    size: "7.5 x 9.75 inches",
    inStock: true,
    stockQuantity: 75,
  },
  {
    name: "Grid Paper Notebook",
    description:
      "Graph paper notebook ideal for math, engineering, and technical drawings. Features precise grid lines.",
    price: 1330,
    category: "Grid",
    pages: 120,
    size: "8.5 x 11 inches",
    inStock: true,
    stockQuantity: 40,
  },
  {
    name: "Sketchbook Artist Pad",
    description:
      "Heavy-weight paper sketchbook perfect for artists. Acid-free pages suitable for various media.",
    price: 1660,
    category: "Sketchbook",
    pages: 80,
    size: "9 x 12 inches",
    inStock: true,
    stockQuantity: 25,
  },
  {
    name: "Bullet Journal Dotted",
    description:
      "Dotted grid bullet journal with numbered pages and index. Perfect for planning and organization.",
    price: 1580,
    category: "Bullet Journal",
    pages: 240,
    size: "5.5 x 8.5 inches",
    inStock: true,
    stockQuantity: 35,
  },
  {
    name: "Legal Pad Yellow",
    description:
      "Classic yellow legal pad with perforated pages. Ideal for quick notes and brainstorming.",
    price: 580,
    category: "Legal Pad",
    pages: 50,
    size: "8.5 x 11 inches",
    inStock: true,
    stockQuantity: 100,
  },
  {
    name: "Moleskine Classic",
    description:
      "Iconic Moleskine-style notebook with hard cover and elastic closure. Premium quality paper.",
    price: 2075,
    category: "Hardcover",
    pages: 240,
    size: "5 x 8.25 inches",
    inStock: true,
    stockQuantity: 20,
  },
];

const seedData = async () => {
  try {
    await connectDB();

    // Clear existing data
    await User.deleteMany({});
    await Notebook.deleteMany({});

    console.log("Cleared existing data");

    // Create dummy users
    const users = [];
    for (let i = 1; i <= 5; i++) {
      const user = new User({
        username: `user${i}`,
        email: `user${i}@example.com`,
        password: "1234",
      });
      await user.save();
      users.push(user);
      console.log(`Created user: user${i}`);
    }

    // Create notebooks
    for (const notebookData of notebooks) {
      const notebook = new Notebook(notebookData);
      await notebook.save();
      console.log(`Created notebook: ${notebook.name}`);
    }

    console.log("\n✅ Seed data created successfully!");
    console.log("\nDummy users created:");
    console.log("Username: user1, user2, user3, user4, user5");
    console.log("Password: 1234 (for all users)");

    process.exit(0);
  } catch (error) {
    console.error("Error seeding data:", error);
    process.exit(1);
  }
};

seedData();
