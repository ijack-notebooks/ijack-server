const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const Order = require("../models/Order");
const User = require("../models/User");
const Notebook = require("../models/Notebook");
const Category = require("../models/Category");
const Invoice = require("../models/Invoice");
const PromoCode = require("../models/PromoCode");
const Admin = require("../models/Admin");
const { adminAuth, superAdminOnly } = require("../middleware/adminAuth");
const {
  getInvoiceSignedUrl,
  buildInvoicePdfFromSnapshot,
  sendInvoiceEmail,
  ensureInvoiceStored,
  ensureInvoiceRecordForOrder,
} = require("../utils/invoice");
const upload = require("../middleware/upload");
const { updateOrderInSupabase } = require("../utils/supabaseOrders");
const {
  uploadImageToSupabase,
  deleteImageFromSupabase,
  deleteLocalImage,
} = require("../utils/supabaseStorage");
const {
  cancelShiprocketShipment,
  initiateZwitchRefund,
} = require("../utils/orderOperations");

// ——— Admin users (super-admin only) ———
router.get("/admins", adminAuth, superAdminOnly, async (req, res) => {
  try {
    const admins = await Admin.find().select("-password").sort({ createdAt: -1 });
    res.json(admins.map((a) => ({
      id: a._id,
      username: a.username,
      email: a.email,
      role: a.role || "secondary-admin",
      createdAt: a.createdAt,
    })));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post("/admins", adminAuth, superAdminOnly, async (req, res) => {
  try {
    const { username, password, email } = req.body;

    // Option 1: Add by email only (user will sign in with Google later)
    if (email) {
      const normalizedEmail = String(email).toLowerCase().trim();
      if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({ message: "Valid email is required" });
      }
      const existingByEmail = await Admin.findOne({ email: normalizedEmail });
      if (existingByEmail) {
        return res.status(400).json({ message: "An admin with this email already exists" });
      }
      const usernameFromEmail = normalizedEmail.replace(/@.*$/, "").replace(/[^a-z0-9]/gi, "_").toLowerCase() || "admin";
      let uniqueUsername = usernameFromEmail;
      let suffix = 0;
      while (await Admin.findOne({ username: uniqueUsername })) {
        uniqueUsername = `${usernameFromEmail}${++suffix}`;
      }
      const admin = new Admin({
        username: uniqueUsername,
        email: normalizedEmail,
        password: require("crypto").randomBytes(32).toString("hex"),
        role: "secondary-admin",
      });
      await admin.save();
      return res.status(201).json({
        admin: {
          id: admin._id,
          username: admin.username,
          email: admin.email,
          role: admin.role,
          createdAt: admin.createdAt,
        },
      });
    }

    // Option 2: Add by username and password
    if (!username || !password) {
      return res.status(400).json({ message: "Username and password are required, or provide email for Google login" });
    }
    const existing = await Admin.findOne({ username: username.trim() });
    if (existing) {
      return res.status(400).json({ message: "Username already exists" });
    }
    const admin = new Admin({
      username: username.trim(),
      password,
      role: "secondary-admin",
    });
    await admin.save();
    res.status(201).json({
      admin: {
        id: admin._id,
        username: admin.username,
        email: admin.email,
        role: admin.role,
        createdAt: admin.createdAt,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete("/admins/:id", adminAuth, superAdminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    if (req.admin._id.toString() === id) {
      return res.status(400).json({ message: "You cannot remove yourself" });
    }
    const target = await Admin.findById(id);
    if (!target) {
      return res.status(404).json({ message: "Admin not found" });
    }
    if (target.role === "super-admin") {
      return res.status(403).json({ message: "Cannot remove a super-admin" });
    }
    await Admin.findByIdAndDelete(id);
    res.json({ message: "Admin removed" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

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

// Cancel order (set status to cancelled; optionally cancel Shiprocket shipment)
router.post("/orders/:id/cancel", adminAuth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate("user", "username email")
      .populate("items.notebook");
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    if (order.status === "cancelled") {
      return res.status(400).json({ message: "Order is already cancelled" });
    }
    order.status = "cancelled";
    if (order.shiprocket?.orderId && order.shiprocket?.active !== false) {
      try {
        await cancelShiprocketShipment(order, {
          source: "order_cancel",
          reason: "Shipment cancelled during order cancellation",
        });
      } catch (srErr) {
        console.error("Shiprocket cancel failed:", srErr.message);
      }
    }
    await order.save();
    updateOrderInSupabase(order._id.toString(), { status: "cancelled" }).catch((err) =>
      console.error("Failed to update order in Supabase:", err)
    );
    const updated = await Order.findById(req.params.id)
      .populate("user", "username email")
      .populate("items.notebook");
    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Refund order via ZWITCH (https://developers.zwitch.io/reference/create-upi-refund)
router.post("/orders/:id/refund", adminAuth, async (req, res) => {
  let order = null;
  let hadActiveShipment = false;
  try {
    order = await Order.findById(req.params.id)
      .populate("user", "username email")
      .populate("items.notebook");
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    hadActiveShipment = Boolean(order.shiprocket?.orderId && order.shiprocket?.active !== false);
    if (hadActiveShipment) {
      await cancelShiprocketShipment(order, {
        source: "refund",
        reason: "Shipment cancelled before refund",
        strict: true,
      });
    }

    const refundRes = await initiateZwitchRefund(order, {
      source: "admin_refund",
      reason: "Refund initiated from admin orders",
      strict: true,
    });

    await order.save();
    updateOrderInSupabase(order._id.toString(), {
      status: "cancelled",
      payment: order.payment,
    }).catch(() => {});

    res.json({
      message: hadActiveShipment
        ? "Shipment cancelled and refund initiated successfully"
        : "Refund initiated successfully",
      refund: refundRes.data,
      order,
    });
  } catch (error) {
    if (order && order.shiprocket?.active === false) {
      await order.save().catch(() => {});
      updateOrderInSupabase(order._id.toString(), {
        status: order.status,
        payment: order.payment,
      }).catch(() => {});
    }
    const msg =
      error.response?.data?.error?.message ||
      error.response?.data?.message ||
      error.message;
    res.status(error.status || error.response?.status || 500).json({ message: msg || "Refund failed" });
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
        lengthCm:
          req.body.lengthCm != null && req.body.lengthCm !== ""
            ? Math.max(0.5, Number(req.body.lengthCm))
            : 25,
        breadthCm:
          req.body.breadthCm != null && req.body.breadthCm !== ""
            ? Math.max(0.5, Number(req.body.breadthCm))
            : 20,
        heightCm:
          req.body.heightCm != null && req.body.heightCm !== ""
            ? Math.max(0.5, Number(req.body.heightCm))
            : 0.8,
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
    const updateBody = {
      ...req.body,
      lengthCm:
        req.body.lengthCm != null && req.body.lengthCm !== ""
          ? Math.max(0.5, Number(req.body.lengthCm))
          : req.body.lengthCm,
      breadthCm:
        req.body.breadthCm != null && req.body.breadthCm !== ""
          ? Math.max(0.5, Number(req.body.breadthCm))
          : req.body.breadthCm,
      heightCm:
        req.body.heightCm != null && req.body.heightCm !== ""
          ? Math.max(0.5, Number(req.body.heightCm))
          : req.body.heightCm,
    };
    const notebook = await Notebook.findByIdAndUpdate(req.params.id, updateBody, {
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
        lengthCm:
          req.body.lengthCm != null && req.body.lengthCm !== ""
            ? Math.max(0.5, Number(req.body.lengthCm))
            : (existing.lengthCm ?? 25),
        breadthCm:
          req.body.breadthCm != null && req.body.breadthCm !== ""
            ? Math.max(0.5, Number(req.body.breadthCm))
            : (existing.breadthCm ?? 20),
        heightCm:
          req.body.heightCm != null && req.body.heightCm !== ""
            ? Math.max(0.5, Number(req.body.heightCm))
            : (existing.heightCm ?? 0.8),
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

          // Delete old image when replacing with new one (Supabase or local)
          if (existing.image) {
            if (existing.image.includes("supabase.co") || existing.image.includes("storage")) {
              await deleteImageFromSupabase(existing.image).catch((e) =>
                console.warn("Failed to delete old Supabase image:", e)
              );
            } else {
              await deleteLocalImage(existing.image).catch((e) =>
                console.warn("Failed to delete old local image:", e)
              );
            }
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

// List all invoices (admin) – exclude heavy invoiceSnapshot
router.get("/invoices", adminAuth, async (req, res) => {
  try {
    const successfulOrders = await Order.find({
      "payment.paymentStatus": "SUCCESS",
    }).select("_id");
    const existingInvoices = await Invoice.find().select("orderId").lean();
    const existingOrderIds = new Set(
      existingInvoices.map((inv) => String(inv.orderId))
    );

    for (const order of successfulOrders) {
      if (!existingOrderIds.has(String(order._id))) {
        await ensureInvoiceRecordForOrder(order._id).catch((err) =>
          console.error("Invoice backfill failed:", err)
        );
      }
    }

    const invoices = await Invoice.find()
      .select("-invoiceSnapshot")
      .sort({ createdAt: -1 })
      .lean();
    res.json(invoices);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get signed URL to view invoice PDF (admin)
router.get("/invoices/:id/view", adminAuth, async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    const pdfPath = await ensureInvoiceStored(invoice);
    const url = await getInvoiceSignedUrl(pdfPath);
    res.json({ url });
  } catch (error) {
    const message =
      error.message && error.message.includes("row-level security policy")
        ? "Invoice PDF is not stored in Supabase yet because Storage access is blocked. Fix the Invoices bucket policy or use a real Supabase service-role key, then try View again."
        : error.message;
    res.status(500).json({ message });
  }
});

// Resend invoice email to customer (admin)
router.post("/invoices/:id/send", adminAuth, async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    const { orderSnapshot, invoiceData } = invoice.invoiceSnapshot;
    const pdfBuffer = await buildInvoicePdfFromSnapshot(
      orderSnapshot,
      invoice.invoiceNumber,
      invoiceData
    );
    await sendInvoiceEmail(
      invoice.customerEmail,
      invoice.customerName,
      invoice.invoiceNumber,
      pdfBuffer
    );
    await Invoice.findByIdAndUpdate(invoice._id, {
      lastEmailSentAt: new Date(),
      lastEmailError: null,
    });
    res.json({ success: true, message: "Invoice sent to " + invoice.customerEmail });
  } catch (error) {
    await Invoice.findByIdAndUpdate(req.params.id, {
      lastEmailError: error.message || "Send failed",
    }).catch(() => {});
    res.status(500).json({ message: error.message });
  }
});

// ——— Promo codes (admin) ———
router.get("/promo-codes", adminAuth, async (req, res) => {
  try {
    const codes = await PromoCode.find().sort({ createdAt: -1 }).lean();
    res.json(codes);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post("/promo-codes", adminAuth, async (req, res) => {
  try {
    const {
      code,
      type,
      value,
      minOrderAmount,
      validFrom,
      validUntil,
      maxUses,
    } = req.body;
    if (!code || !type || value == null) {
      return res.status(400).json({
        message: "code, type (percent|fixed), and value are required",
      });
    }
    if (!["percent", "fixed"].includes(type)) {
      return res.status(400).json({ message: "type must be percent or fixed" });
    }
    if (type === "percent" && (value < 0 || value > 100)) {
      return res.status(400).json({ message: "percent value must be 0–100" });
    }
    const doc = await PromoCode.create({
      code: String(code).trim().toUpperCase(),
      type,
      value: Number(value),
      minOrderAmount: minOrderAmount != null ? Number(minOrderAmount) : 0,
      validFrom: validFrom ? new Date(validFrom) : undefined,
      validUntil: validUntil ? new Date(validUntil) : null,
      maxUses: maxUses != null && maxUses !== "" ? Number(maxUses) : null,
    });
    res.status(201).json(doc);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "A promo code with this code already exists" });
    }
    res.status(500).json({ message: error.message });
  }
});

router.patch("/promo-codes/:id", adminAuth, async (req, res) => {
  try {
    const { active, maxUses, validUntil } = req.body;
    const update = {};
    if (typeof active === "boolean") update.active = active;
    if (maxUses !== undefined) update.maxUses = maxUses === "" ? null : Number(maxUses);
    if (validUntil !== undefined) update.validUntil = validUntil ? new Date(validUntil) : null;
    const doc = await PromoCode.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true }
    );
    if (!doc) return res.status(404).json({ message: "Promo code not found" });
    res.json(doc);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete("/promo-codes/:id", adminAuth, async (req, res) => {
  try {
    const doc = await PromoCode.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ message: "Promo code not found" });
    res.json({ message: "Promo code deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Shiprocket shipping integration (admin only)
const shiprocketRouter = require("./shiprocket");
router.use("/shiprocket", shiprocketRouter);

module.exports = router;
