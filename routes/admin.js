const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const Order = require("../models/Order");
const User = require("../models/User");
const Notebook = require("../models/Notebook");
const Category = require("../models/Category");
const { adminAuth } = require("../middleware/adminAuth");
const upload = require("../middleware/upload");
const { updateOrderInSupabase } = require("../utils/supabaseOrders");
const {
  uploadImageToSupabase,
  deleteImageFromSupabase,
  deleteLocalImage,
} = require("../utils/supabaseStorage");

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
        $match: { "payment.paymentStatus": "SUCCESS" },
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
    const categoryDocs = await Category.find().sort({ name: 1 });
    const productCategories = await Notebook.distinct("category");
    const allNames = [
      ...new Set([...categoryDocs.map((c) => c.name), ...productCategories]),
    ];
    const byName = Object.fromEntries(categoryDocs.map((c) => [c.name, c]));

    const categories = allNames.map((name) => {
      const doc = byName[name];
      return doc
        ? {
            _id: doc._id,
            name: doc.name,
            description: doc.description,
            hsn: doc.hsn ?? "",
            gstPercentage: doc.gstPercentage ?? 0,
          }
        : { name, _id: null, description: "", hsn: "", gstPercentage: 0 };
    });
    res.json(categories);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new category
router.post("/categories", adminAuth, async (req, res) => {
  try {
    const { name, description, hsn, gstPercentage } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Category name is required" });
    }

    const existingCategory = await Category.findOne({
      name: name.trim(),
    });

    if (existingCategory) {
      return res.status(400).json({ message: "Category already exists" });
    }

    const gst = gstPercentage != null ? Number(gstPercentage) : 0;
    const category = new Category({
      name: name.trim(),
      description: description || "",
      hsn: hsn != null ? String(hsn).trim() : "",
      gstPercentage: Math.min(100, Math.max(0, isNaN(gst) ? 0 : gst)),
    });

    await category.save();
    res.status(201).json(category);
  } catch (error) {
    if (error.code === 11000) {
      res.status(400).json({ message: "Category already exists" });
    } else {
      res.status(500).json({ message: error.message });
    }
  }
});

// Update category
router.patch("/categories/:id", adminAuth, async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    const { name, description, hsn, gstPercentage } = req.body;
    const oldName = category.name;
    const newName = name != null ? String(name).trim() : oldName;

    if (!newName) {
      return res.status(400).json({ message: "Category name cannot be empty" });
    }

    if (newName !== oldName) {
      const existing = await Category.findOne({ name: newName });
      if (existing) {
        return res
          .status(400)
          .json({ message: "A category with that name already exists" });
      }
      await Notebook.updateMany(
        { category: oldName },
        { $set: { category: newName } }
      );
    }

    if (description !== undefined) category.description = description;
    if (name !== undefined) category.name = newName;
    if (hsn !== undefined) category.hsn = String(hsn ?? "").trim();
    if (gstPercentage !== undefined) {
      const gst = Number(gstPercentage);
      category.gstPercentage = Math.min(100, Math.max(0, isNaN(gst) ? 0 : gst));
    }

    await category.save();
    res.json(category);
  } catch (error) {
    if (error.code === 11000) {
      res
        .status(400)
        .json({ message: "A category with that name already exists" });
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

    // Update order in Supabase
    updateOrderInSupabase(order._id.toString(), {
      status: order.status,
    }).catch((err) => {
      console.error("Failed to update order in Supabase:", err);
    });

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
        weight: req.body.weight != null && req.body.weight !== "" ? Math.max(0, Number(req.body.weight)) : 0,
      };

      // Upload image to Supabase Storage if file was uploaded (no local fallback)
      if (req.file) {
        const supabase = require("../config/supabase");
        if (!supabase) {
          // Clean up multer's local file before returning error
          try {
            if (req.file.path && fs.existsSync(req.file.path)) {
              fs.unlinkSync(req.file.path);
            }
          } catch (e) {
            /* ignore */
          }
          return res.status(503).json({
            message:
              "Image storage is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to the server .env file and ensure the product-images bucket exists in Supabase.",
          });
        }

        try {
          const fileBuffer = fs.readFileSync(req.file.path);

          const uploadResult = await uploadImageToSupabase(
            fileBuffer,
            req.file.filename,
            req.file.mimetype
          );

          productData.image = uploadResult.publicUrl;

          try {
            fs.unlinkSync(req.file.path);
            console.log(
              "✅ Image uploaded to Supabase:",
              uploadResult.publicUrl
            );
          } catch (deleteError) {
            console.warn(
              "Failed to delete local file after Supabase upload:",
              deleteError
            );
          }
        } catch (supabaseError) {
          try {
            if (req.file.path && fs.existsSync(req.file.path)) {
              fs.unlinkSync(req.file.path);
            }
          } catch (e) {
            /* ignore */
          }
          console.error("Supabase upload error:", supabaseError);
          const message =
            supabaseError.message ||
            (supabaseError.error && supabaseError.error.message) ||
            "Failed to upload image to storage.";
          return res.status(502).json({
            message: "Image upload failed: " + message,
          });
        }
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

// Update product (JSON only, no image)
router.put("/products/:id", adminAuth, async (req, res) => {
  try {
    const notebook = await Notebook.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!notebook) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.json(notebook);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update product with optional image upload (multipart)
router.patch("/products/:id", adminAuth, (req, res) => {
  upload.single("image")(req, res, async (err) => {
    try {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res
            .status(400)
            .json({ message: "Image too large. Max 10MB allowed." });
        }
        return res.status(400).json({ message: err.message || "Upload error" });
      }

      const existing = await Notebook.findById(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: "Product not found" });
      }

      const update = {
        name: req.body.name != null ? String(req.body.name).trim() : existing.name,
        description: req.body.description != null ? String(req.body.description).trim() : existing.description,
        price: req.body.price != null ? parseFloat(req.body.price) : existing.price,
        category: req.body.category != null ? String(req.body.category).trim() : existing.category,
        pages: req.body.pages != null ? parseInt(req.body.pages, 10) : existing.pages,
        size: req.body.size != null ? String(req.body.size).trim() : existing.size,
        stockQuantity: req.body.stockQuantity != null ? parseInt(req.body.stockQuantity, 10) : existing.stockQuantity,
        weight: req.body.weight != null && req.body.weight !== "" ? Math.max(0, Number(req.body.weight)) : (existing.weight ?? 0),
        inStock: req.body.inStock !== undefined ? (req.body.inStock === "true" || req.body.inStock === true) : existing.inStock,
      };

      if (req.file) {
        const supabase = require("../config/supabase");
        if (!supabase) {
          try {
            if (req.file.path && fs.existsSync(req.file.path)) {
              fs.unlinkSync(req.file.path);
            }
          } catch (e) {
            /* ignore */
          }
          return res.status(503).json({
            message:
              "Image storage is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to the server .env file and ensure the product-images bucket exists in Supabase.",
          });
        }

        try {
          const fileBuffer = fs.readFileSync(req.file.path);
          const uploadResult = await uploadImageToSupabase(
            fileBuffer,
            req.file.filename,
            req.file.mimetype
          );
          update.image = uploadResult.publicUrl;

          try {
            fs.unlinkSync(req.file.path);
          } catch (deleteError) {
            /* ignore */
          }

          // Delete old image from Supabase if it was stored there
          if (existing.image && (existing.image.includes("supabase.co") || existing.image.includes("storage"))) {
            await deleteImageFromSupabase(existing.image).catch((e) =>
              console.warn("Failed to delete old Supabase image:", e)
            );
          }
        } catch (supabaseError) {
          try {
            if (req.file.path && fs.existsSync(req.file.path)) {
              fs.unlinkSync(req.file.path);
            }
          } catch (e) {
            /* ignore */
          }
          console.error("Supabase upload error:", supabaseError);
          const message =
            supabaseError.message ||
            (supabaseError.error && supabaseError.error.message) ||
            "Failed to upload image to storage.";
          return res.status(502).json({
            message: "Image upload failed: " + message,
          });
        }
      }

      const notebook = await Notebook.findByIdAndUpdate(req.params.id, update, {
        new: true,
        runValidators: true,
      });

      res.json(notebook);
    } catch (error) {
      if (req.file && req.file.path && fs.existsSync(req.file.path)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (e) {
          /* ignore */
        }
      }
      res.status(500).json({ message: error.message });
    }
  });
});

// Delete product
router.delete("/products/:id", adminAuth, async (req, res) => {
  try {
    const notebook = await Notebook.findById(req.params.id);

    if (!notebook) {
      return res.status(404).json({ message: "Product not found" });
    }

    // Delete image from Supabase Storage or local storage
    if (notebook.image) {
      if (
        notebook.image.includes("supabase.co") ||
        notebook.image.includes("storage")
      ) {
        // Supabase storage URL
        await deleteImageFromSupabase(notebook.image);
      } else {
        // Local storage
        await deleteLocalImage(notebook.image);
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

    // Delete all image files (both Supabase and local)
    for (const notebook of notebooks) {
      if (notebook.image) {
        if (
          notebook.image.includes("supabase.co") ||
          notebook.image.includes("storage")
        ) {
          // Supabase storage URL
          await deleteImageFromSupabase(notebook.image);
        } else {
          // Local storage
          await deleteLocalImage(notebook.image);
        }
      }
    }

    await Notebook.deleteMany({});
    res.json({ message: "All products deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Cleanup old product images from server folder
router.post("/cleanup-images", adminAuth, async (req, res) => {
  try {
    const { cleanupOldImages } = require("../utils/supabaseStorage");
    const deletedCount = await cleanupOldImages();
    res.json({
      message: "Cleanup completed successfully",
      deletedCount,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Shiprocket shipping integration (admin only)
const shiprocketRouter = require("./shiprocket");
router.use("/shiprocket", shiprocketRouter);

module.exports = router;
