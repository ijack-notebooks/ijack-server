const express = require("express");
const router = express.Router();
const path = require("path");
const Order = require("../models/Order");
const User = require("../models/User");
const Notebook = require("../models/Notebook");
const Category = require("../models/Category");
const { adminAuth } = require("../middleware/adminAuth");
const upload = require("../middleware/upload");

// Get all orders (admin only)
router.get("/orders", adminAuth, async (req, res) => {
  try {
    const orders = await Order.find()
      .populate("user", "username email")
      .populate("items.notebook")
      .sort({ createdAt: -1 });
    res.json(orders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get order statistics
router.get("/stats", adminAuth, async (req, res) => {
  try {
    const totalOrders = await Order.countDocuments();
    
    // Only count revenue from successful payments
    const totalRevenue = await Order.aggregate([
      {
        $match: { "payment.paymentStatus": "SUCCESS" }
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$totalAmount" },
        },
      },
    ]);

    const ordersByStatus = await Order.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]);

    const paymentStats = await Order.aggregate([
      {
        $group: {
          _id: "$payment.paymentStatus",
          count: { $sum: 1 },
        },
      },
    ]);

    const recentOrders = await Order.find()
      .populate("user", "username")
      .sort({ createdAt: -1 })
      .limit(5);

    res.json({
      totalOrders,
      totalRevenue: totalRevenue[0]?.total || 0,
      ordersByStatus,
      paymentStats,
      recentOrders,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get all categories (must be before /orders/:id to avoid route conflict)
router.get("/categories", adminAuth, async (req, res) => {
  try {
    // Get categories from Category model
    const categories = await Category.find().sort({ name: 1 });
    const categoryNames = categories.map((cat) => cat.name);
    
    // Also get categories from existing products (for backward compatibility)
    const productCategories = await Notebook.distinct("category");
    
    // Merge and deduplicate
    const allCategories = [...new Set([...categoryNames, ...productCategories])];
    res.json(allCategories);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new category
router.post("/categories", adminAuth, async (req, res) => {
  try {
    const { name, description } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Category name is required" });
    }

    // Check if category already exists
    const existingCategory = await Category.findOne({ 
      name: name.trim() 
    });
    
    if (existingCategory) {
      return res.status(400).json({ message: "Category already exists" });
    }

    const category = new Category({
      name: name.trim(),
      description: description || "",
    });
    
    await category.save();
    res.status(201).json(category);
  } catch (error) {
    if (error.code === 11000) {
      // Duplicate key error
      res.status(400).json({ message: "Category already exists" });
    } else {
      res.status(500).json({ message: error.message });
    }
  }
});

// Delete category
router.delete("/categories/:id", adminAuth, async (req, res) => {
  try {
    const category = await Category.findByIdAndDelete(req.params.id);
    
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    res.json({ message: "Category deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get single order (admin)
router.get("/orders/:id", adminAuth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate("user", "username email")
      .populate("items.notebook");

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    res.json(order);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update order status
router.patch("/orders/:id/status", adminAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = [
      "pending",
      "processing",
      "shipped",
      "delivered",
      "cancelled",
    ];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    )
      .populate("user", "username email")
      .populate("items.notebook");

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    res.json(order);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new product with image upload
router.post("/products", adminAuth, (req, res) => {
  upload.single("image")(req, res, async (err) => {
    try {
      // Handle Multer errors gracefully
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res
            .status(400)
            .json({ message: "Image too large. Max 10MB allowed." });
        }
        return res.status(400).json({ message: err.message || "Upload error" });
      }

      const productData = {
        ...req.body,
        price: parseFloat(req.body.price),
        pages: parseInt(req.body.pages),
        stockQuantity: parseInt(req.body.stockQuantity),
        inStock: req.body.inStock === "true" || req.body.inStock === true,
      };

      // Add image path if file was uploaded
      if (req.file) {
        productData.image = `/uploads/images/${req.file.filename}`;
      }

      const notebook = new Notebook(productData);
      await notebook.save();
      res.status(201).json(notebook);
    } catch (error) {
      // Delete uploaded file if product creation fails
      if (req.file) {
        const fs = require("fs");
        const filePath = path.join(
          __dirname,
          "../uploads/images",
          req.file.filename
        );
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
      res.status(500).json({ message: error.message });
    }
  });
});

// Update product
router.put("/products/:id", adminAuth, async (req, res) => {
  try {
    const notebook = await Notebook.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!notebook) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.json(notebook);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Delete product
router.delete("/products/:id", adminAuth, async (req, res) => {
  try {
    const notebook = await Notebook.findById(req.params.id);

    if (!notebook) {
      return res.status(404).json({ message: "Product not found" });
    }

    // Delete associated image file if exists
    if (notebook.image) {
      const fs = require("fs");
      const filePath = path.join(__dirname, "../", notebook.image);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    await Notebook.findByIdAndDelete(req.params.id);
    res.json({ message: "Product deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Delete all products
router.delete("/products", adminAuth, async (req, res) => {
  try {
    // Get all products to delete their images
    const notebooks = await Notebook.find({});
    const fs = require("fs");
    
    // Delete all image files
    notebooks.forEach((notebook) => {
      if (notebook.image) {
        const filePath = path.join(__dirname, "../", notebook.image);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    });

    await Notebook.deleteMany({});
    res.json({ message: "All products deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
