const express = require("express");
const router = express.Router();
const Notebook = require("../models/Notebook");
const Category = require("../models/Category");

// Public: get category names and GST % for checkout
router.get("/categories", async (req, res) => {
  try {
    const categories = await Category.find({}).select("name gstPercentage").lean();
    res.json(categories);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get all notebooks
router.get("/", async (req, res) => {
  try {
    const notebooks = await Notebook.find().sort({ createdAt: -1 });
    res.json(notebooks);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get single notebook
router.get("/:id", async (req, res) => {
  try {
    const notebook = await Notebook.findById(req.params.id);
    if (!notebook) {
      return res.status(404).json({ message: "Notebook not found" });
    }
    res.json(notebook);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create notebook (admin only - for seeding)
router.post("/", async (req, res) => {
  try {
    const notebook = new Notebook(req.body);
    await notebook.save();
    res.status(201).json(notebook);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;

