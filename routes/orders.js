const express = require("express");
const router = express.Router();
const Order = require("../models/Order");
const Notebook = require("../models/Notebook");
const { auth } = require("../middleware/auth");

// Create order
router.post("/", auth, async (req, res) => {
  try {
    const { items, contactDetails, address } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Order must contain at least one item" });
    }

    if (!contactDetails || !address) {
      return res.status(400).json({ message: "Contact details and address are required" });
    }

    // Calculate total and validate items
    let totalAmount = 0;
    const orderItems = [];

    for (const item of items) {
      const notebook = await Notebook.findById(item.notebookId);
      if (!notebook) {
        return res.status(404).json({ message: `Notebook ${item.notebookId} not found` });
      }

      if (notebook.stockQuantity < item.quantity) {
        return res.status(400).json({ message: `Insufficient stock for ${notebook.name}` });
      }

      const itemTotal = notebook.price * item.quantity;
      totalAmount += itemTotal;

      orderItems.push({
        notebook: notebook._id,
        quantity: item.quantity,
        price: notebook.price,
      });
    }

    const order = new Order({
      user: req.user._id,
      items: orderItems,
      totalAmount,
      contactDetails,
      address,
    });

    await order.save();

    // Update stock quantities
    for (const item of items) {
      await Notebook.findByIdAndUpdate(item.notebookId, {
        $inc: { stockQuantity: -item.quantity },
      });
    }

    res.status(201).json(order);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get user's orders
router.get("/my-orders", auth, async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user._id })
      .populate("items.notebook")
      .sort({ createdAt: -1 });
    res.json(orders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get single order
router.get("/:id", auth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate("items.notebook");

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Check if order belongs to user
    if (order.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }

    res.json(order);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;

