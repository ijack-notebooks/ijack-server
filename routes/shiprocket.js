/**
 * Shiprocket integration routes (admin only)
 * Creates shipments from our orders and fetches labels/tracking
 */

const express = require("express");
const router = express.Router();
const Order = require("../models/Order");
const Notebook = require("../models/Notebook");
const { adminAuth } = require("../middleware/adminAuth");
const {
  getPickupLocation,
  isConfigured,
  isTestMode,
  shiprocketFetch,
} = require("../config/shiprocket");
const { appendShiprocketHistory, ensureShiprocketState } = require("../utils/shiprocketHistory");
const { updateOrderInSupabase } = require("../utils/supabaseOrders");
const { cancelShiprocketShipment } = require("../utils/orderOperations");

// Default package weight in kg (notebooks; minimum chargeable is 0.5 kg)
const DEFAULT_WEIGHT_KG = 0.5;
const DEFAULT_LENGTH = 25;
const DEFAULT_BREADTH = 20;
const DEFAULT_HEIGHT = 2;
const PICKUP_PINCODE = "530007";

function normalizePincode(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 6);
}

function safePositiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function fetchShiprocketCourierOptions({
  pickupPincode,
  deliveryPincode,
  weightKg,
  lengthCm,
  breadthCm,
  heightCm,
  cod = 0,
  shipmentValue = 0,
}) {
  const params = new URLSearchParams({
    pickup_postcode: String(pickupPincode),
    delivery_postcode: String(deliveryPincode),
    weight: String(weightKg),
    cod: String(cod ? 1 : 0),
    length: String(lengthCm),
    breadth: String(breadthCm),
    height: String(heightCm),
    declared_value: String(Math.max(0, Number(shipmentValue) || 0)),
  });

  const data = await shiprocketFetch(`/v1/external/courier/serviceability/?${params.toString()}`, {
    method: "GET",
  });
  const rows = data?.data?.available_courier_companies || data?.available_courier_companies || [];

  return rows
    .map((row) => {
      const courierCompanyId = Number(row?.courier_company_id ?? row?.id ?? 0);
      const courierName =
        row?.courier_name || row?.courier_company_name || row?.name || "Courier";
      const rate = Number(
        row?.freight_charge ??
          row?.rate ??
          row?.courier_charge ??
          row?.total_charge ??
          row?.cod_charges,
      );
      const etdDays = row?.estimated_delivery_days || row?.etd || row?.eta || null;
      return {
        courierCompanyId,
        courierName,
        rate: Number.isFinite(rate) && rate > 0 ? rate : null,
        etdDays: etdDays != null ? String(etdDays) : null,
      };
    })
    .filter((x) => x.rate != null)
    .sort((a, b) => a.rate - b.rate);
}

// Check if Shiprocket is configured (and whether test mode is on)
router.get("/config", adminAuth, (req, res) => {
  res.json({
    configured: isConfigured(),
    testMode: isTestMode(),
  });
});

// Get live courier options for an existing order (admin use; pricing mirrors checkout).
router.get("/courier-options/:orderId", adminAuth, async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!orderId) {
      return res.status(400).json({ message: "orderId is required" });
    }

    const order = await Order.findById(orderId).populate("items.notebook", "weight lengthCm breadthCm heightCm");
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const normalizedDeliveryPincode = normalizePincode(order.address?.zipCode);
    if (!normalizedDeliveryPincode || normalizedDeliveryPincode.length !== 6) {
      return res.status(400).json({ message: "Order must have a valid 6-digit delivery pincode" });
    }

    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) {
      return res.status(400).json({ message: "Order has no items" });
    }

    let totalWeightGrams = 0;
    let maxLengthCm = 0;
    let maxBreadthCm = 0;
    let stackedHeightCm = 0;

    for (const item of items) {
      const qty = Math.max(1, Number(item.quantity) || 1);
      let notebook = item.notebook;

      if (!notebook || typeof notebook !== "object" || !("weight" in notebook)) {
        notebook = await Notebook.findById(item.notebook).select("weight lengthCm breadthCm heightCm");
      }
      if (!notebook) continue;

      totalWeightGrams += (Number(notebook.weight) || 0) * qty;
      const itemLength = safePositiveNumber(notebook.lengthCm, DEFAULT_LENGTH);
      const itemBreadth = safePositiveNumber(notebook.breadthCm, DEFAULT_BREADTH);
      const itemHeight = safePositiveNumber(notebook.heightCm, DEFAULT_HEIGHT);
      maxLengthCm = Math.max(maxLengthCm, itemLength);
      maxBreadthCm = Math.max(maxBreadthCm, itemBreadth);
      stackedHeightCm += itemHeight * qty;
    }

    const packageData = {
      weightKg: Math.max(DEFAULT_WEIGHT_KG, Number((totalWeightGrams / 1000).toFixed(3))),
      lengthCm: Number(Math.max(0.5, maxLengthCm || DEFAULT_LENGTH).toFixed(2)),
      breadthCm: Number(Math.max(0.5, maxBreadthCm || DEFAULT_BREADTH).toFixed(2)),
      heightCm: Number(Math.max(0.5, stackedHeightCm || DEFAULT_HEIGHT).toFixed(2)),
    };

    if (!isConfigured()) {
      const fallbackRate = Math.ceil(totalWeightGrams / 500) * 26;
      return res.json({
        fallback: true,
        pickupPincode: PICKUP_PINCODE,
        deliveryPincode: normalizedDeliveryPincode,
        package: packageData,
        options: [
          {
            courierCompanyId: 0,
            courierName: "Standard Shipping",
            rate: fallbackRate,
            etdDays: "3-7",
          },
        ],
        customerChoice: {
          courierCompanyId: Number(order.shipping?.courierCompanyId || 0) || null,
          courierName: order.shipping?.courierName || null,
        },
      });
    }

    const options = await fetchShiprocketCourierOptions({
      pickupPincode: PICKUP_PINCODE,
      deliveryPincode: normalizedDeliveryPincode,
      weightKg: packageData.weightKg,
      lengthCm: packageData.lengthCm,
      breadthCm: packageData.breadthCm,
      heightCm: packageData.heightCm,
      cod: 0,
      shipmentValue: Number(order.totalAmount) || 0,
    });

    return res.json({
      fallback: false,
      pickupPincode: PICKUP_PINCODE,
      deliveryPincode: normalizedDeliveryPincode,
      package: packageData,
      options,
      customerChoice: {
        courierCompanyId: Number(order.shipping?.courierCompanyId || 0) || null,
        courierName: order.shipping?.courierName || null,
      },
    });
  } catch (error) {
    console.error("Shiprocket courier options error:", error);
    return res.status(error.status || 500).json({
      message: error.message || "Failed to fetch courier options",
      error: error.response || undefined,
    });
  }
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

    if (order.shiprocket?.orderId && order.shiprocket?.active !== false) {
      return res.status(400).json({
        message: "Order already created in Shiprocket",
        shiprocketOrderId: order.shiprocket.orderId,
        shipmentId: order.shiprocket.shipmentId,
      });
    }

    if (order.status === "cancelled" || order.payment?.refundedAt) {
      return res.status(400).json({
        message: "Cannot create shipment for a cancelled or refunded order.",
      });
    }

    // Test mode: mock response, no real API call
    if (isTestMode()) {
      const mockOrderId = 90000000 + Math.floor(Math.random() * 999999);
      const mockShipmentId = 90000000 + Math.floor(Math.random() * 999999);
      const existingHistory = Array.isArray(order.shiprocket?.history)
        ? order.shiprocket.history
        : [];
      order.shiprocket = {
        orderId: mockOrderId,
        shipmentId: mockShipmentId,
        awbCode: null,
        courierName: null,
        labelUrl: null,
        active: true,
        lastAction: null,
        trackingStatus: null,
        trackingUrl: null,
        cancelledAt: null,
        history: existingHistory,
        createdAt: new Date(),
      };
      appendShiprocketHistory(order, {
        action: "shipment_created",
        status: "Created",
        message: "[TEST MODE] Shipment created in Shiprocket",
        data: { shiprocketOrderId: mockOrderId, shipmentId: mockShipmentId },
      });
      if (order.status === "pending") {
        order.status = "processing";
      }
      await order.save();
      updateOrderInSupabase(order._id.toString(), { status: order.status }).catch(() => {});
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
    const pickupLocation = await getPickupLocation();
    const billingPhone =
      String(order.contactDetails?.phone || "")
        .replace(/\D/g, "")
        .slice(-10) || "9999999999";
    const billingPincode = String(order.address?.zipCode || "").replace(/\D/g, "").slice(0, 6);

    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) {
      return res.status(400).json({ message: "Cannot create shipment for an order with no items." });
    }

    if (!billingPincode || billingPincode.length !== 6) {
      return res.status(400).json({
        message: "Order address must include a valid 6-digit pincode before creating shipment.",
      });
    }

    if (!billingPhone || billingPhone.length !== 10) {
      return res.status(400).json({
        message: "Order contact must include a valid 10-digit phone number before creating shipment.",
      });
    }

    const orderItems = items.map((item) => ({
      name: item.notebook?.name || "Notebook",
      sku: item.notebook?._id?.toString() || `item-${item._id}`,
      units: Number(item.quantity) || 1,
      unit_price: Number(item.price) || 0,
      selling_price: Number(item.price) || 0,
    }));

    const orderDate = order.createdAt
      ? new Date(order.createdAt).toISOString().split("T")[0]
      : new Date().toISOString().split("T")[0];
    const baseExternalOrderId = String(order.payment?.merchantOrderId || order._id.toString());
    const shipmentCreateAttempts = (Array.isArray(order.shiprocket?.history) ? order.shiprocket.history : [])
      .filter((entry) => entry?.action === "shipment_created")
      .length;
    // Keep Shiprocket order_id unique per shipment attempt so cancelled shipments
    // do not get tied to stale AWB state on re-creation.
    const externalOrderId =
      shipmentCreateAttempts > 0
        ? `${baseExternalOrderId}-R${shipmentCreateAttempts + 1}`
        : baseExternalOrderId;
    const payload = {
      order_id: externalOrderId,
      order_date: orderDate,
      pickup_location: pickupLocation,
      channel_id: "",
      billing_customer_name: firstName,
      billing_last_name: lastName,
      billing_address: order.address?.street || "Address",
      billing_address_2: "",
      billing_city: order.address?.city || "",
      billing_pincode: billingPincode,
      billing_state: order.address?.state || "",
      billing_country: order.address?.country || "India",
      billing_email: order.contactDetails?.email || order.user?.email || "",
      billing_phone: billingPhone,
      shipping_is_billing: 1,
      shipping_customer_name: firstName,
      shipping_last_name: lastName,
      shipping_address: order.address?.street || "Address",
      shipping_address_2: "",
      shipping_city: order.address?.city || "",
      shipping_pincode: billingPincode,
      shipping_state: order.address?.state || "",
      shipping_country: order.address?.country || "India",
      shipping_phone: billingPhone,
      shipping_email: order.contactDetails?.email || order.user?.email || "",
      order_items: orderItems,
      // Store is prepaid-only; always send Prepaid to Shiprocket (never COD).
      payment_method: "Prepaid",
      sub_total: Number(order.totalAmount) || 0,
      length: Number(order.shipping?.lengthCm) > 0 ? Number(order.shipping.lengthCm) : DEFAULT_LENGTH,
      breadth: Number(order.shipping?.breadthCm) > 0 ? Number(order.shipping.breadthCm) : DEFAULT_BREADTH,
      height: Number(order.shipping?.heightCm) > 0 ? Number(order.shipping.heightCm) : DEFAULT_HEIGHT,
      weight: Number(order.shipping?.weightKg) > 0 ? Number(order.shipping.weightKg) : DEFAULT_WEIGHT_KG,
      lead_source: "Ijack Notebooks",
    };

    const data = await shiprocketFetch("/v1/external/orders/create/adhoc", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const srOrderId = data?.order_id;
    const shipmentId = data?.shipment_id ?? data?.id;
    if (srOrderId == null) {
      throw new Error(data?.message || data?.error || "Shiprocket did not return order_id");
    }

    const existingHistory = Array.isArray(order.shiprocket?.history)
      ? order.shiprocket.history
      : [];
    order.shiprocket = {
      orderId: srOrderId,
      shipmentId,
      awbCode: null,
      courierName: null,
      labelUrl: null,
      active: true,
      lastAction: null,
      trackingStatus: null,
      trackingUrl: null,
      cancelledAt: null,
      history: existingHistory,
      createdAt: new Date(),
    };
    appendShiprocketHistory(order, {
      action: "shipment_created",
      status: "Created",
      message: "Shipment created in Shiprocket",
      data: { shiprocketOrderId: srOrderId, shipmentId, externalOrderId },
    });
    if (order.status === "pending") {
      order.status = "processing";
    }
    await order.save();

    updateOrderInSupabase(order._id.toString(), { status: order.status }).catch(() => {});

    res.json({
      message: "Order created in Shiprocket",
      order_id: srOrderId,
      shipment_id: shipmentId,
      order: order,
    });
  } catch (error) {
    console.error("Shiprocket create order error:", error?.message || error);
    if (error?.stack) console.error(error.stack);
    const status = error.status || 500;
    const message = error?.message ? String(error.message) : "Failed to create order in Shiprocket";
    const body = { message };
    if (error?.response && typeof error.response === "object" && !Array.isArray(error.response)) {
      try {
        body.details = JSON.parse(JSON.stringify(error.response));
      } catch (_) {
        body.details = String(error.response?.message || error.response?.error || "Unknown API error");
      }
    }
    res.status(status).json(body);
  }
});

// Assign AWB to shipment
router.post("/assign-awb", adminAuth, async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ message: "Shiprocket not configured" });
    }

    const { orderId, courierCompanyId: requestedCourierCompanyId, courierName: requestedCourierName } = req.body; // our MongoDB order _id
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

    const requestedCourierId = Number(requestedCourierCompanyId || 0);
    const preferredCourierCompanyId = requestedCourierId > 0
      ? requestedCourierId
      : Number(order.shipping?.courierCompanyId || 0);

    if (isTestMode()) {
      const mockAwb = "TEST" + String(1000000000 + Math.floor(Math.random() * 999999999)).slice(0, 10);
      const mockCourier =
        String(requestedCourierName || "").trim() ||
        (preferredCourierCompanyId > 0
          ? `Preferred Courier #${preferredCourierCompanyId} (Test Mode)`
          : "Test Courier (Test Mode)");
      const shiprocket = ensureShiprocketState(order);
      shiprocket.active = true;
      order.shiprocket.awbCode = mockAwb;
      order.shiprocket.courierName = mockCourier;
      appendShiprocketHistory(order, {
        action: "awb_assigned",
        status: "AWB assigned",
        message: "[TEST MODE] AWB assigned",
        data: {
          awbCode: mockAwb,
          courierName: mockCourier,
          preferredCourierCompanyId: preferredCourierCompanyId > 0 ? preferredCourierCompanyId : null,
          requestedCourierName: String(requestedCourierName || "").trim() || null,
        },
      });
      await order.save();
      updateOrderInSupabase(order._id.toString(), {}).catch(() => {});
      return res.json({
        message: "[TEST MODE] AWB assigned (mock)",
        awb_code: mockAwb,
        courier_name: mockCourier,
        order,
      });
    }

    const buildAssignPayload = (sid) => ({
      shipment_id: sid,
      ...(preferredCourierCompanyId > 0 ? { courier_id: preferredCourierCompanyId } : {}),
    });

    const parseAssignResponse = (data) => {
      const responseData = data?.response?.data || {};
      const directAwbCode = data?.awb_code ?? data?.awb;
      const nestedAwbCode = responseData?.awb_code ?? responseData?.awb;
      const assignError = responseData?.awb_assign_error || data?.message || data?.error || "";
      const alreadyAssignedMatch =
        typeof assignError === "string"
          ? assignError.match(/awb\s*-\s*([A-Z0-9]+)/i)
          : null;
      const awbCode = directAwbCode || nestedAwbCode || alreadyAssignedMatch?.[1] || null;
      const cName =
        data?.courier_name ??
        data?.courier ??
        responseData?.courier_name ??
        responseData?.courier ??
        (responseData?.courier_id ? `Courier #${responseData.courier_id}` : "");
      const isCancelledAwb =
        typeof assignError === "string" &&
        /awb.*already.*assigned/i.test(assignError) &&
        /status\s*-\s*cancelled/i.test(assignError);
      return { awbCode, courierName: cName, assignError, isCancelledAwb };
    };

    let data = await shiprocketFetch("/v1/external/courier/assign/awb", {
      method: "POST",
      body: JSON.stringify(buildAssignPayload(shipmentId)),
    });

    let parsed = parseAssignResponse(data);

    // Shiprocket ties the old cancelled AWB to this shipment_id.
    // Auto-recover: cancel old SR order, create fresh one, retry AWB.
    if (parsed.isCancelledAwb || (!parsed.awbCode && parsed.assignError)) {
      const errStr = String(parsed.assignError || "");
      if (/awb.*already.*assigned/i.test(errStr) && /cancel/i.test(errStr)) {
        console.log("assign-awb: stale cancelled AWB detected, auto-recovering...");
        const srOrderId = order.shiprocket?.orderId;
        if (srOrderId) {
          try {
            await shiprocketFetch("/v1/external/orders/cancel", {
              method: "POST",
              body: JSON.stringify({ ids: [Number(srOrderId)] }),
            });
          } catch (cancelErr) {
            console.warn("assign-awb: old SR order cancel failed (may already be cancelled):", cancelErr.message);
          }

          appendShiprocketHistory(order, {
            action: "shipment_cancelled",
            status: "Cancelled",
            message: "Auto-cancelled stale Shiprocket order before AWB retry",
            data: { source: "awb_auto_retry", oldSrOrderId: srOrderId, oldShipmentId: shipmentId },
          });

          const reOrder = await Order.findById(orderId)
            .populate("user", "username email")
            .populate("items.notebook");
          if (!reOrder) {
            return res.status(404).json({ message: "Order not found during auto-retry" });
          }

          const nameParts = (reOrder.contactDetails?.name || "Customer").trim().split(" ");
          const rFirstName = nameParts[0] || "Customer";
          const rLastName = nameParts.slice(1).join(" ") || "";
          const rPickupLocation = await getPickupLocation();
          const rBillingPhone =
            String(reOrder.contactDetails?.phone || "").replace(/\D/g, "").slice(-10) || "9999999999";
          const rBillingPincode = String(reOrder.address?.zipCode || "").replace(/\D/g, "").slice(0, 6);
          const rItems = Array.isArray(reOrder.items) ? reOrder.items : [];
          const rOrderItems = rItems.map((item) => ({
            name: item.notebook?.name || "Notebook",
            sku: item.notebook?._id?.toString() || `item-${item._id}`,
            units: Number(item.quantity) || 1,
            unit_price: Number(item.price) || 0,
            selling_price: Number(item.price) || 0,
          }));
          const rOrderDate = reOrder.createdAt
            ? new Date(reOrder.createdAt).toISOString().split("T")[0]
            : new Date().toISOString().split("T")[0];
          const baseId = String(reOrder.payment?.merchantOrderId || reOrder._id.toString());
          const prevAttempts = (Array.isArray(order.shiprocket?.history) ? order.shiprocket.history : [])
            .filter((e) => e?.action === "shipment_created").length;
          const newExternalOrderId = `${baseId}-R${prevAttempts + 1}`;
          const newPayload = {
            order_id: newExternalOrderId,
            order_date: rOrderDate,
            pickup_location: rPickupLocation,
            channel_id: "",
            billing_customer_name: rFirstName,
            billing_last_name: rLastName,
            billing_address: reOrder.address?.street || "Address",
            billing_address_2: "",
            billing_city: reOrder.address?.city || "",
            billing_pincode: rBillingPincode,
            billing_state: reOrder.address?.state || "",
            billing_country: reOrder.address?.country || "India",
            billing_email: reOrder.contactDetails?.email || reOrder.user?.email || "",
            billing_phone: rBillingPhone,
            shipping_is_billing: 1,
            shipping_customer_name: rFirstName,
            shipping_last_name: rLastName,
            shipping_address: reOrder.address?.street || "Address",
            shipping_address_2: "",
            shipping_city: reOrder.address?.city || "",
            shipping_pincode: rBillingPincode,
            shipping_state: reOrder.address?.state || "",
            shipping_country: reOrder.address?.country || "India",
            shipping_phone: rBillingPhone,
            shipping_email: reOrder.contactDetails?.email || reOrder.user?.email || "",
            order_items: rOrderItems,
            payment_method: "Prepaid",
            sub_total: Number(reOrder.totalAmount) || 0,
            length: Number(reOrder.shipping?.lengthCm) > 0 ? Number(reOrder.shipping.lengthCm) : DEFAULT_LENGTH,
            breadth: Number(reOrder.shipping?.breadthCm) > 0 ? Number(reOrder.shipping.breadthCm) : DEFAULT_BREADTH,
            height: Number(reOrder.shipping?.heightCm) > 0 ? Number(reOrder.shipping.heightCm) : DEFAULT_HEIGHT,
            weight: Number(reOrder.shipping?.weightKg) > 0 ? Number(reOrder.shipping.weightKg) : DEFAULT_WEIGHT_KG,
            lead_source: "Ijack Notebooks",
          };

          const newData = await shiprocketFetch("/v1/external/orders/create/adhoc", {
            method: "POST",
            body: JSON.stringify(newPayload),
          });

          const newSrOrderId = newData?.order_id;
          const newShipmentId = newData?.shipment_id ?? newData?.id;
          if (newSrOrderId == null) {
            throw new Error(newData?.message || "Shiprocket did not return order_id on auto-retry");
          }

          const existingHistory = Array.isArray(order.shiprocket?.history) ? order.shiprocket.history : [];
          order.shiprocket = {
            orderId: newSrOrderId,
            shipmentId: newShipmentId,
            awbCode: null,
            courierName: null,
            labelUrl: null,
            active: true,
            lastAction: null,
            trackingStatus: null,
            trackingUrl: null,
            cancelledAt: null,
            history: existingHistory,
            createdAt: new Date(),
          };
          appendShiprocketHistory(order, {
            action: "shipment_created",
            status: "Created",
            message: "Auto-created new Shiprocket order after stale AWB (retry)",
            data: { shiprocketOrderId: newSrOrderId, shipmentId: newShipmentId, externalOrderId: newExternalOrderId },
          });
          await order.save();

          data = await shiprocketFetch("/v1/external/courier/assign/awb", {
            method: "POST",
            body: JSON.stringify(buildAssignPayload(newShipmentId)),
          });
          parsed = parseAssignResponse(data);
        }
      }
    }

    if (!parsed.awbCode) {
      const message =
        typeof parsed.assignError === "string" && parsed.assignError
          ? parsed.assignError
          : "Shiprocket did not return an AWB number";
      return res.status(422).json({ message });
    }

    const shiprocket = ensureShiprocketState(order);
    shiprocket.active = true;
    order.shiprocket.awbCode = parsed.awbCode;
    order.shiprocket.courierName = parsed.courierName;
    appendShiprocketHistory(order, {
      action: "awb_assigned",
      status: "AWB assigned",
      message: "AWB assigned in Shiprocket",
      data: {
        awbCode: parsed.awbCode,
        courierName: parsed.courierName,
        preferredCourierCompanyId: preferredCourierCompanyId > 0 ? preferredCourierCompanyId : null,
        requestedCourierName: String(requestedCourierName || "").trim() || null,
      },
    });
    await order.save();

    updateOrderInSupabase(order._id.toString(), {}).catch(() => {});

    res.json({
      message: "AWB assigned",
      awb_code: parsed.awbCode,
      courier_name: parsed.courierName,
      order: order,
    });
  } catch (error) {
    console.error("Shiprocket assign AWB error:", error?.message || error);
    if (error?.stack) console.error(error.stack);
    const status = error.status || 500;
    const message = error?.message ? String(error.message) : "Failed to assign AWB";
    const body = { message };
    if (error?.response && typeof error.response === "object" && !Array.isArray(error.response)) {
      try {
        body.details = JSON.parse(JSON.stringify(error.response));
      } catch (_) {
        body.details = String(error.response?.message || error.response?.error || "Unknown API error");
      }
    }
    res.status(status).json(body);
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
      const shiprocket = ensureShiprocketState(order);
      shiprocket.labelUrl = labelUrl;
      appendShiprocketHistory(order, {
        action: "label_generated",
        message: "[TEST MODE] Shipping label generated",
        data: { labelUrl },
      });
      await order.save();
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
    if (labelUrl) {
      const shiprocket = ensureShiprocketState(order);
      shiprocket.labelUrl = labelUrl;
      appendShiprocketHistory(order, {
        action: "label_generated",
        message: "Shipping label generated",
        data: { labelUrl },
      });
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
      appendShiprocketHistory(order, {
        action: "pickup_requested",
        status: "Pickup requested",
        message: "[TEST MODE] Pickup request submitted",
      });
      await order.save();
      return res.json({
        message: "[TEST MODE] Pickup request submitted (mock)",
        data: { status: "success", testMode: true },
        order,
      });
    }

    let data = null;
    try {
      data = await shiprocketFetch("/v1/external/courier/generate/pickup", {
        method: "POST",
        body: JSON.stringify({
          shipment_id: [order.shiprocket.shipmentId],
        }),
      });

      appendShiprocketHistory(order, {
        action: "pickup_requested",
        status: "Pickup requested",
        message: "Pickup scheduling requested in Shiprocket",
        data,
      });
    } catch (pickupErr) {
      const errMsg = String(pickupErr?.message || "").toLowerCase();
      const alreadyQueued = errMsg.includes("already in pickup queue");
      if (!alreadyQueued) {
        throw pickupErr;
      }

      // Treat idempotent "already queued" response as success so admins can re-request safely.
      appendShiprocketHistory(order, {
        action: "pickup_requested",
        status: "Pickup requested",
        message: "Pickup already in queue in Shiprocket",
        data: pickupErr.response || null,
      });
      data = pickupErr.response || { message: pickupErr.message };
    }
    await order.save();

    res.json({ message: "Pickup generated", data, order });
  } catch (error) {
    console.error("Shiprocket generate pickup error:", error);
    res.status(error.status || 500).json({
      message: error.message || "Failed to generate pickup",
      error: error.response || undefined,
    });
  }
});

// Cancel pickup only (keeps shipment active; does not cancel the Shiprocket order)
router.post("/cancel-pickup", adminAuth, async (req, res) => {
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

    const shipmentId = order.shiprocket.shipmentId;

    if (isTestMode()) {
      appendShiprocketHistory(order, {
        action: "pickup_cancelled",
        status: order.shiprocket?.trackingStatus || "Pickup cancelled",
        message: "[TEST MODE] Pickup cancelled (shipment remains active)",
      });
      await order.save();
      return res.json({
        message: "[TEST MODE] Pickup cancelled (mock)",
        order,
      });
    }

    try {
      const pickupCancelData = await shiprocketFetch("/v1/external/courier/cancel/pickup", {
        method: "POST",
        body: JSON.stringify({ shipment_id: [Number(shipmentId)] }),
      });
      appendShiprocketHistory(order, {
        action: "pickup_cancelled",
        status: order.shiprocket?.trackingStatus || "Pickup cancelled",
        message: "Pickup cancelled; shipment remains active",
        data: pickupCancelData,
      });
    } catch (pickupErr) {
      const status = pickupErr.status || (pickupErr.response && pickupErr.response.status);
      const isNotFoundOrAlreadyCancelled = status === 404 || status === 400 || status === 422;
      if (isNotFoundOrAlreadyCancelled) {
        appendShiprocketHistory(order, {
          action: "pickup_cancelled",
          status: order.shiprocket?.trackingStatus || "Pickup cancelled",
          message: "Pickup was already cancelled or not found; no action needed",
          data: pickupErr.response || null,
        });
      } else {
        console.warn("Shiprocket cancel pickup:", pickupErr.message);
        appendShiprocketHistory(order, {
          action: "pickup_cancel_failed",
          status: order.shiprocket?.trackingStatus || null,
          message: `Pickup cancellation failed: ${pickupErr.message}`,
          data: pickupErr.response || null,
        });
        await order.save();
        return res.status(status || 502).json({
          message: pickupErr.message || "Failed to cancel pickup",
          order,
        });
      }
    }

    await order.save();
    res.json({ message: "Pickup cancelled", order });
  } catch (error) {
    console.error("Shiprocket cancel pickup error:", error);
    res.status(error.status || 500).json({
      message: error.message || "Failed to cancel pickup",
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

// Cancel Shiprocket order and preserve shipment history on our order.
// If a pickup was scheduled, cancel it first (Shiprocket does not auto-cancel pickup when order is cancelled).
router.post("/cancel", adminAuth, async (req, res) => {
  try {
    const { orderId, cancellationReason } = req.body; // our MongoDB order _id
    if (!orderId) {
      return res.status(400).json({ message: "orderId is required" });
    }

    const normalizedReason = String(cancellationReason || "").trim();
    if (!normalizedReason) {
      return res.status(400).json({ message: "Shipment cancellation reason is required" });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const shipmentResult = await cancelShiprocketShipment(order, {
      source: "shipment_page",
      reason: `Shipment cancelled in Shiprocket — ${normalizedReason}`,
      cancellationReason: normalizedReason,
      strict: true,
    });

    // Shipment cancellation should not cancel/refund the order.
    // Keep fulfilment open so admin can create a fresh shipment.
    if (order.status !== "cancelled" && order.status !== "delivered" && !order.payment?.refundedAt) {
      order.status = "processing";
    }

    await order.save();
    updateOrderInSupabase(orderId.toString(), {
      status: order.status,
      payment: order.payment,
    }).catch(() => {});

    res.json({
      message: "Shipment cancelled. Order remains active for re-creating shipment.",
      data: shipmentResult.data,
      cancelled: shipmentResult.cancelled === true,
      order,
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
