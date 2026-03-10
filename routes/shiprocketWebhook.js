const express = require("express");
const router = express.Router();
const Order = require("../models/Order");
const { SHIPROCKET_WEBHOOK_AUTH_ENABLED, SHIPROCKET_WEBHOOK_SECRET } = require("../config/shiprocket");
const { appendShiprocketHistory, ensureShiprocketState } = require("../utils/shiprocketHistory");
const { updateOrderInSupabase } = require("../utils/supabaseOrders");

function getByPath(obj, path) {
  return path.split(".").reduce((value, key) => {
    if (value == null) return undefined;
    return value[key];
  }, obj);
}

function firstNonEmptyValue(obj, paths) {
  for (const path of paths) {
    const value = getByPath(obj, path);
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

function normalizeNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function mapOrderStatusFromShipmentStatus(status) {
  const normalized = normalizeString(status).toLowerCase();
  if (!normalized) return null;

  if (normalized.includes("delivered")) {
    return "delivered";
  }

  if (normalized.includes("cancel")) {
    return "cancelled";
  }

  if (
    normalized.includes("awb") ||
    normalized.includes("pickup") ||
    normalized.includes("manifest") ||
    normalized.includes("ready to ship") ||
    normalized.includes("in transit") ||
    normalized.includes("shipped") ||
    normalized.includes("out for delivery")
  ) {
    return "shipped";
  }

  return null;
}

function extractWebhookFields(payload) {
  const shipmentId = normalizeNumber(
    firstNonEmptyValue(payload, [
      "shipment_id",
      "shipmentId",
      "data.shipment_id",
      "data.shipmentId",
      "response.data.shipment_id",
      "response.data.shipmentId",
    ]),
  );

  const shiprocketOrderId = normalizeNumber(
    firstNonEmptyValue(payload, [
      "order_id",
      "orderId",
      "sr_order_id",
      "data.order_id",
      "data.orderId",
      "data.sr_order_id",
      "response.data.order_id",
      "response.data.orderId",
    ]),
  );

  const awbCode = normalizeString(
    firstNonEmptyValue(payload, [
      "awb",
      "awb_code",
      "tracking_number",
      "data.awb",
      "data.awb_code",
      "data.tracking_number",
      "response.data.awb",
      "response.data.awb_code",
    ]),
  );

  const trackingStatus = normalizeString(
    firstNonEmptyValue(payload, [
      "current_status",
      "shipment_status",
      "status",
      "current_status_description",
      "shipment_status_label",
      "data.current_status",
      "data.shipment_status",
      "data.status",
      "data.current_status_description",
      "response.data.current_status",
      "response.data.shipment_status",
      "response.data.status",
    ]),
  );

  const trackingUrl = normalizeString(
    firstNonEmptyValue(payload, [
      "tracking_url",
      "track_url",
      "trackingLink",
      "data.tracking_url",
      "data.track_url",
      "response.data.tracking_url",
    ]),
  );

  const courierName = normalizeString(
    firstNonEmptyValue(payload, [
      "courier_name",
      "courier",
      "courier_company_name",
      "data.courier_name",
      "data.courier",
      "response.data.courier_name",
      "response.data.courier",
    ]),
  );

  return {
    shipmentId,
    shiprocketOrderId,
    awbCode,
    trackingStatus,
    trackingUrl,
    courierName,
  };
}

router.post("/webhook", async (req, res) => {
  try {
    if (SHIPROCKET_WEBHOOK_AUTH_ENABLED && SHIPROCKET_WEBHOOK_SECRET) {
      const providedSecret =
        req.get("token") ||
        req.get("Token") ||
        req.get("x-shiprocket-webhook-secret") ||
        req.get("X-Shiprocket-Webhook-Secret") ||
        req.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ||
        req.body?.token ||
        req.query?.token;

      if (providedSecret !== SHIPROCKET_WEBHOOK_SECRET) {
        console.warn("Webhook auth failed. Headers:", JSON.stringify(req.headers));
        return res.status(401).json({ message: "Invalid webhook secret" });
      }
    }

    const payload = req.body || {};
    const {
      shipmentId,
      shiprocketOrderId,
      awbCode,
      trackingStatus,
      trackingUrl,
      courierName,
    } = extractWebhookFields(payload);

    const matchConditions = [];
    if (shipmentId != null) matchConditions.push({ "shiprocket.shipmentId": shipmentId });
    if (shiprocketOrderId != null) matchConditions.push({ "shiprocket.orderId": shiprocketOrderId });
    if (awbCode) matchConditions.push({ "shiprocket.awbCode": awbCode });

    if (!matchConditions.length) {
      console.warn("Shiprocket webhook received without known identifiers:", payload);
      return res.json({ received: true, matched: false });
    }

    const order = await Order.findOne({ $or: matchConditions });
    if (!order) {
      console.warn("Shiprocket webhook did not match any order:", {
        shipmentId,
        shiprocketOrderId,
        awbCode,
      });
      return res.json({ received: true, matched: false });
    }

    const shiprocket = ensureShiprocketState(order);

    if (shipmentId != null) order.shiprocket.shipmentId = shipmentId;
    if (shiprocketOrderId != null) order.shiprocket.orderId = shiprocketOrderId;
    if (awbCode) order.shiprocket.awbCode = awbCode;
    if (courierName) order.shiprocket.courierName = courierName;
    if (trackingStatus) order.shiprocket.trackingStatus = trackingStatus;
    if (trackingUrl) order.shiprocket.trackingUrl = trackingUrl;
    order.shiprocket.lastWebhookAt = new Date();
    if (trackingStatus && trackingStatus.toLowerCase().includes("cancel")) {
      shiprocket.active = false;
      shiprocket.cancelledAt = new Date();
    }

    const nextOrderStatus = mapOrderStatusFromShipmentStatus(trackingStatus);
    if (nextOrderStatus === "delivered") {
      order.status = "delivered";
    } else if (nextOrderStatus === "cancelled" && order.status !== "delivered") {
      order.status = "cancelled";
    } else if (
      nextOrderStatus === "shipped" &&
      order.status !== "delivered" &&
      order.status !== "cancelled"
    ) {
      order.status = "shipped";
    }

    appendShiprocketHistory(order, {
      action: "tracking_update",
      status: trackingStatus || null,
      message: trackingStatus || "Tracking update received from webhook",
      data: {
        awbCode,
        courierName,
        trackingUrl,
        scans: payload.scans || payload.data?.scans || [],
      },
    });

    await order.save();
    updateOrderInSupabase(order._id.toString(), { status: order.status }).catch(() => {});

    res.json({
      received: true,
      matched: true,
      orderId: order._id.toString(),
      trackingStatus: order.shiprocket.trackingStatus || null,
    });
  } catch (error) {
    console.error("Shiprocket webhook error:", error);
    res.status(500).json({ message: "Failed to process Shiprocket webhook" });
  }
});

module.exports = router;
