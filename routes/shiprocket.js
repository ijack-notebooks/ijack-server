/**
 * Shiprocket integration routes (admin only)
 * Creates shipments from our orders and fetches labels/tracking
 */

const express = require("express");
const router = express.Router();
const Order = require("../models/Order");
const { adminAuth } = require("../middleware/adminAuth");
const { isConfigured, isTestMode, shiprocketFetch } = require("../config/shiprocket");
const { updateOrderInSupabase } = require("../utils/supabaseOrders");

// Default package weight in kg (notebooks; minimum chargeable is 0.5 kg)
const DEFAULT_WEIGHT_KG = 0.5;
const DEFAULT_LENGTH = 25;
const DEFAULT_BREADTH = 20;
const DEFAULT_HEIGHT = 2;

// Check if Shiprocket is configured (and whether test mode is on)
router.get("/config", adminAuth, (req, res) => {
  res.json({
    configured: isConfigured(),
    testMode: isTestMode(),
  });
});

// Create order in Shiprocket (adhoc) from our MongoDB order
router.post("/create-order", adminAuth, async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({
        message:
          "Shiprocket not configured. Set SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD in server .env (or SHIPROCKET_TEST_MODE=true for test mode).",
      });
    }

    const { orderId } = req.body; // our MongoDB order _id
    if (!orderId) {
      return res.status(400).json({ message: "orderId is required" });
    }

    const order = await Order.findById(orderId)
      .populate("user", "username email")
      .populate("items.notebook");

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (order.shiprocket?.orderId) {
      return res.status(400).json({
        message: "Order already created in Shiprocket",
        shiprocketOrderId: order.shiprocket.orderId,
        shipmentId: order.shiprocket.shipmentId,
      });
    }

    // Test mode: mock response, no real API call
    if (isTestMode()) {
      const mockOrderId = 90000000 + Math.floor(Math.random() * 999999);
      const mockShipmentId = 90000000 + Math.floor(Math.random() * 999999);
      order.shiprocket = {
        orderId: mockOrderId,
        shipmentId: mockShipmentId,
        awbCode: null,
        courierName: null,
        labelUrl: null,
        trackingStatus: null,
        trackingUrl: null,
        createdAt: new Date(),
      };
      await order.save();
      updateOrderInSupabase(order._id.toString(), {}).catch(() => {});
      return res.json({
        message: "[TEST MODE] Order created in Shiprocket (mock)",
        order_id: mockOrderId,
        shipment_id: mockShipmentId,
        order,
      });
    }

    const nameParts = (order.contactDetails?.name || "Customer").trim().split(" ");
    const firstName = nameParts[0] || "Customer";
    const lastName = nameParts.slice(1).join(" ") || "";

    const orderItems = order.items.map((item) => ({
      name: item.notebook?.name || "Notebook",
      sku: item.notebook?._id?.toString() || `item-${item._id}`,
      units: item.quantity,
      unit_price: Number(item.price),
    }));

    const payload = {
      order_id: order.payment?.merchantOrderId || order._id.toString(),
      order_date: new Date(order.createdAt).toISOString().split("T")[0],
      channel_id: "",
      billing_customer_name: firstName,
      billing_last_name: lastName,
      billing_address: order.address?.street || "Address",
      billing_address_2: "",
      billing_city: order.address?.city || "",
      billing_pincode: String(order.address?.zipCode || "").replace(/\s/g, ""),
      billing_state: order.address?.state || "",
      billing_country: order.address?.country || "India",
      billing_email: order.contactDetails?.email || order.user?.email || "",
      billing_phone: String(order.contactDetails?.phone || "").replace(/\D/g, "").slice(0, 10) || "9999999999",
      shipping_is_billing: 1,
      shipping_customer_name: firstName,
      shipping_last_name: lastName,
      shipping_address: order.address?.street || "Address",
      shipping_address_2: "",
      shipping_city: order.address?.city || "",
      shipping_pincode: String(order.address?.zipCode || "").replace(/\s/g, ""),
      shipping_state: order.address?.state || "",
      shipping_country: order.address?.country || "India",
      shipping_phone: String(order.contactDetails?.phone || "").replace(/\D/g, "").slice(0, 10) || "9999999999",
      shipping_email: order.contactDetails?.email || order.user?.email || "",
      order_items: orderItems,
      payment_method: order.payment?.paymentStatus === "SUCCESS" ? "Prepaid" : "COD",
      sub_total: order.totalAmount,
      length: DEFAULT_LENGTH,
      breadth: DEFAULT_BREADTH,
      height: DEFAULT_HEIGHT,
      weight: DEFAULT_WEIGHT_KG,
      lead_source: "Ijack Notebooks",
    };

    const data = await shiprocketFetch("/v1/external/orders/create/adhoc", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const srOrderId = data.order_id;
    const shipmentId = data.shipment_id ?? data.id;

    order.shiprocket = {
      orderId: srOrderId,
      shipmentId,
      awbCode: null,
      courierName: null,
      labelUrl: null,
      trackingStatus: null,
      trackingUrl: null,
      createdAt: new Date(),
    };
    await order.save();

    updateOrderInSupabase(order._id.toString(), {}).catch(() => {});

    res.json({
      message: "Order created in Shiprocket",
      order_id: srOrderId,
      shipment_id: shipmentId,
      order: order,
    });
  } catch (error) {
    console.error("Shiprocket create order error:", error);
    res.status(error.status || 500).json({
      message: error.message || "Failed to create order in Shiprocket",
      error: error.response || undefined,
    });
  }
});

// Assign AWB to shipment
router.post("/assign-awb", adminAuth, async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ message: "Shiprocket not configured" });
    }

    const { orderId } = req.body; // our MongoDB order _id
    if (!orderId) {
      return res.status(400).json({ message: "orderId is required" });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const shipmentId = order.shiprocket?.shipmentId;
    if (!shipmentId) {
      return res.status(400).json({
        message: "Create Shiprocket order first (use Create Shipment)",
      });
    }

    if (isTestMode()) {
      const mockAwb = "TEST" + String(1000000000 + Math.floor(Math.random() * 999999999)).slice(0, 10);
      const mockCourier = "Test Courier (Test Mode)";
      if (!order.shiprocket) order.shiprocket = {};
      order.shiprocket.awbCode = mockAwb;
      order.shiprocket.courierName = mockCourier;
      await order.save();
      updateOrderInSupabase(order._id.toString(), {}).catch(() => {});
      return res.json({
        message: "[TEST MODE] AWB assigned (mock)",
        awb_code: mockAwb,
        courier_name: mockCourier,
        order,
      });
    }

    const data = await shiprocketFetch("/v1/external/courier/assign/awb", {
      method: "POST",
      body: JSON.stringify({
        shipment_id: shipmentId,
      }),
    });

    const awbCode = data.awb_code ?? data.awb;
    const courierName = data.courier_name ?? data.courier ?? "";

    if (!order.shiprocket) order.shiprocket = {};
    order.shiprocket.awbCode = awbCode;
    order.shiprocket.courierName = courierName;
    await order.save();

    updateOrderInSupabase(order._id.toString(), {}).catch(() => {});

    res.json({
      message: "AWB assigned",
      awb_code: awbCode,
      courier_name: courierName,
      order: order,
    });
  } catch (error) {
    console.error("Shiprocket assign AWB error:", error);
    res.status(error.status || 500).json({
      message: error.message || "Failed to assign AWB",
      error: error.response || undefined,
    });
  }
});

// Generate shipping label PDF
router.post("/generate-label", adminAuth, async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ message: "Shiprocket not configured" });
    }

    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ message: "orderId is required" });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const shipmentIds = order.shiprocket?.shipmentId
      ? [order.shiprocket.shipmentId]
      : [];
    if (shipmentIds.length === 0) {
      return res.status(400).json({
        message: "Create Shiprocket order and assign AWB first",
      });
    }

    if (isTestMode()) {
      const labelUrl = "https://via.placeholder.com/400x600?text=Test+Label+(Test+Mode)";
      if (order.shiprocket) {
        order.shiprocket.labelUrl = labelUrl;
        await order.save();
      }
      return res.json({
        message: "[TEST MODE] Label generated (mock)",
        label_url: labelUrl,
        order,
      });
    }

    const data = await shiprocketFetch("/v1/external/courier/generate/label", {
      method: "POST",
      body: JSON.stringify({ shipment_id: shipmentIds }),
    });

    const labelUrl = data.label_url ?? data.url ?? data.pdf_url;
    if (labelUrl && order.shiprocket) {
      order.shiprocket.labelUrl = labelUrl;
      await order.save();
    }

    res.json({
      message: "Label generated",
      label_url: labelUrl,
      order: order,
    });
  } catch (error) {
    console.error("Shiprocket generate label error:", error);
    res.status(error.status || 500).json({
      message: error.message || "Failed to generate label",
      error: error.response || undefined,
    });
  }
});

// Request pickup (optional – call after assigning AWB)
router.post("/generate-pickup", adminAuth, async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ message: "Shiprocket not configured" });
    }

    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ message: "orderId is required" });
    }

    const order = await Order.findById(orderId);
    if (!order?.shiprocket?.shipmentId) {
      return res.status(400).json({ message: "Create Shiprocket order and assign AWB first" });
    }

    if (isTestMode()) {
      return res.json({
        message: "[TEST MODE] Pickup request submitted (mock)",
        data: { status: "success", testMode: true },
      });
    }

    const data = await shiprocketFetch("/v1/external/courier/generate/pickup", {
      method: "POST",
      body: JSON.stringify({
        shipment_id: [order.shiprocket.shipmentId],
      }),
    });

    res.json({ message: "Pickup generated", data });
  } catch (error) {
    console.error("Shiprocket generate pickup error:", error);
    res.status(error.status || 500).json({
      message: error.message || "Failed to generate pickup",
      error: error.response || undefined,
    });
  }
});

// Track by AWB
router.get("/track/:awb", adminAuth, async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ message: "Shiprocket not configured" });
    }

    const { awb } = req.params;
    if (!awb) {
      return res.status(400).json({ message: "awb is required" });
    }

    if (isTestMode()) {
      return res.json({
        testMode: true,
        awb_code: awb,
        tracking_data: {
          status: "In Transit (Test Mode)",
          shipment_status: 2,
          edd: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
          scan: [
            { date: new Date().toISOString(), activity: "Dispatched (mock)", location: "Test Warehouse" },
            { date: new Date().toISOString(), activity: "Picked up (mock)", location: "Origin" },
          ],
        },
      });
    }

    const data = await shiprocketFetch(`/v1/external/courier/track/awb/${awb}`, {
      method: "GET",
    });

    res.json(data);
  } catch (error) {
    console.error("Shiprocket track error:", error);
    res.status(error.status || 500).json({
      message: error.message || "Failed to track",
      error: error.response || undefined,
    });
  }
});

// Cancel Shiprocket order (removes from Shiprocket; clears shiprocket data on our order)
router.post("/cancel", adminAuth, async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ message: "Shiprocket not configured" });
    }

    const { orderId } = req.body; // our MongoDB order _id
    if (!orderId) {
      return res.status(400).json({ message: "orderId is required" });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const srOrderId = order.shiprocket?.orderId;
    if (!srOrderId) {
      return res.status(400).json({ message: "No Shiprocket shipment found for this order" });
    }

    if (isTestMode()) {
      const updated = await Order.findByIdAndUpdate(orderId, { $unset: { shiprocket: "" } }, { new: true });
      updateOrderInSupabase(orderId.toString(), {}).catch(() => {});
      return res.json({
        message: "[TEST MODE] Shipment cancelled (mock)",
        order: updated,
      });
    }

    const data = await shiprocketFetch("/v1/external/orders/cancel", {
      method: "POST",
      body: JSON.stringify({ ids: [Number(srOrderId)] }),
    });

    const updated = await Order.findByIdAndUpdate(orderId, { $unset: { shiprocket: "" } }, { new: true });
    updateOrderInSupabase(orderId.toString(), {}).catch(() => {});

    res.json({
      message: "Shipment cancelled",
      data,
      order: updated,
    });
  } catch (error) {
    console.error("Shiprocket cancel error:", error);
    res.status(error.status || 500).json({
      message: error.message || "Failed to cancel shipment",
      error: error.response || undefined,
    });
  }
});

// Check pincode serviceability (optional)
router.get("/serviceability", adminAuth, async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ message: "Shiprocket not configured" });
    }

    const { pincode } = req.query;
    if (!pincode) {
      return res.status(400).json({ message: "pincode query is required" });
    }

    const data = await shiprocketFetch(
      `/v1/external/courier/serviceability/?pickup_postcode=${pincode}&delivery_postcode=${pincode}&weight=0.5&cod=0`,
      { method: "GET" }
    );

    res.json(data);
  } catch (error) {
    console.error("Shiprocket serviceability error:", error);
    res.status(error.status || 500).json({
      message: error.message || "Failed to check serviceability",
      error: error.response || undefined,
    });
  }
});

module.exports = router;
