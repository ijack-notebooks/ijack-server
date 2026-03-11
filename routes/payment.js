const express = require("express");
const router = express.Router();
const axios = require("axios");
const crypto = require("crypto");
const Order = require("../models/Order");
const Notebook = require("../models/Notebook");
const Category = require("../models/Category");
const PromoCode = require("../models/PromoCode");
const { auth } = require("../middleware/auth");
const { storeOrderInSupabase, updateOrderInSupabase } = require("../utils/supabaseOrders");
const { generateAndSendInvoice } = require("../utils/invoice");
const { appendPaymentHistory } = require("../utils/paymentHistory");

// ZWITCH Configuration (Layer Payment Gateway)
// https://developers.zwitch.io/reference
const ZWITCH_PG_ACCESS_KEY = process.env.ZWITCH_PG_ACCESS_KEY;
const ZWITCH_PG_SECRET_KEY = process.env.ZWITCH_PG_SECRET_KEY;
const ZWITCH_ENV = (process.env.ZWITCH_ENVIRONMENT || "sandbox").toLowerCase(); // sandbox | production
const ZWITCH_WEBHOOK_SECRET = process.env.ZWITCH_WEBHOOK_SIGNING_SECRET;

const ZWITCH_BASE = "https://api.zwitch.io";
const ZWITCH_PG_PATH = ZWITCH_ENV === "production" ? "/v1/pg" : "/v1/pg/sandbox";

// Generate unique merchant order ID (used as mtx in ZWITCH)
const generateMerchantOrderId = () => {
  return `ORDER_${Date.now()}_${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
};

const getZwitchAuthHeader = () => {
  const credentials = `${ZWITCH_PG_ACCESS_KEY}:${ZWITCH_PG_SECRET_KEY}`;
  return { Authorization: `Bearer ${credentials}` };
};

// ZWITCH expects contact_number as 10-digit Indian mobile (e.g. "9876543210"). Normalize user input.
function normalizeContactNumberForZwitch(phone) {
  if (phone == null || typeof phone !== "string") return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return null;
}

// Normalize ZWITCH payment mode to stored payment method (upi | netbanking | card).
// Ref: https://developers.zwitch.io/reference/response-parameters
function normalizePaymentMethod(rawTypeName) {
  if (!rawTypeName || typeof rawTypeName !== "string") return null;
  const t = rawTypeName.toLowerCase().trim().replace(/[-\s]+/g, "_");

  if (t.includes("net") && t.includes("bank")) return "netbanking";
  if (t.includes("credit") && t.includes("card")) return "card";
  if (t.includes("debit") && t.includes("card")) return "card";
  if (t.includes("card")) return "card";
  if (t.includes("upi")) return "upi";

  return rawTypeName;
}

function extractPaymentMethodFromPayload(payload = {}) {
  const explicit = normalizePaymentMethod(
    payload?.type_name ||
      payload?.payment?.type_name ||
      payload?.payment_instrument?.type_name ||
      payload?.payment_instrument?.type ||
      payload?.payment_method ||
      payload?.paid_mode,
  );
  if (explicit) return explicit;

  // Fallback: if vpa (UPI handle) is a non-empty string, the customer paid via UPI
  if (typeof payload?.vpa === "string" && payload.vpa.trim()) return "upi";

  return null;
}

// Verify ZWITCH webhook signature (x-zwitch-signature); payload = normalized JSON string
const verifyZwitchWebhookSignature = (normalizedPayload, signature) => {
  if (!ZWITCH_WEBHOOK_SECRET || !signature) return false;
  try {
    const expected = crypto.createHmac("sha256", ZWITCH_WEBHOOK_SECRET).update(normalizedPayload).digest("hex");
    return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch (e) {
    return false;
  }
};

// Create order and get ZWITCH payment token for Layer.js
router.post("/initiate", auth, async (req, res) => {
  try {
    if (!ZWITCH_PG_ACCESS_KEY || !ZWITCH_PG_SECRET_KEY) {
      return res.status(503).json({
        success: false,
        message: "Payment gateway is not configured. Please set ZWITCH_PG_ACCESS_KEY and ZWITCH_PG_SECRET_KEY.",
      });
    }

    const { items, contactDetails, address } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Order must contain at least one item" });
    }

    if (!contactDetails || !address) {
      return res.status(400).json({ message: "Contact details and address are required" });
    }

    const contactNumberForZwitch = normalizeContactNumberForZwitch(contactDetails.phone);
    if (!contactNumberForZwitch) {
      return res.status(400).json({
        message: "Please enter a valid 10-digit Indian mobile number (e.g. 9876543210).",
      });
    }

    const categoryDocs = await Category.find({}).select("name gstPercentage").lean();
    const gstByCategory = Object.fromEntries(
      categoryDocs.map((c) => [c.name, Number(c.gstPercentage) || 0])
    );

    let subtotal = 0;
    let totalWeightGrams = 0;
    let gstAmount = 0;
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
      subtotal += itemTotal;
      totalWeightGrams += (Number(notebook.weight) || 0) * item.quantity;
      const gstPct = gstByCategory[notebook.category] ?? 0;
      gstAmount += (itemTotal * gstPct) / 100;

      orderItems.push({
        notebook: notebook._id,
        quantity: item.quantity,
        price: notebook.price,
      });
    }

    const shippingCharge = Math.ceil(totalWeightGrams / 500) * 26;
    const preDiscountTotal = Math.round(subtotal + shippingCharge + gstAmount);
    let totalAmount = preDiscountTotal;
    let discountAmount = 0;
    let promoCodeId = null;

    const rawPromoCode = req.body.promoCode;
    if (rawPromoCode && String(rawPromoCode).trim()) {
      const promo = await PromoCode.findOne({
        code: String(rawPromoCode).trim().toUpperCase(),
        active: true,
      });
      if (promo) {
        const now = new Date();
        const validFromOk = !promo.validFrom || new Date(promo.validFrom) <= now;
        const validUntilOk = !promo.validUntil || new Date(promo.validUntil) >= now;
        const minOrderOk = !promo.minOrderAmount || preDiscountTotal >= promo.minOrderAmount;
        const usesOk = promo.maxUses == null || (promo.usedCount || 0) < promo.maxUses;
        if (validFromOk && validUntilOk && minOrderOk && usesOk) {
          if (promo.type === "percent") {
            discountAmount = Math.round((preDiscountTotal * Math.min(100, Math.max(0, promo.value))) / 100);
          } else {
            discountAmount = Math.min(Number(promo.value) || 0, preDiscountTotal);
          }
          totalAmount = Math.max(0, preDiscountTotal - discountAmount);
          promoCodeId = promo._id;
        }
      }
    }

    const merchantOrderId = generateMerchantOrderId();

    const order = new Order({
      user: req.user._id,
      items: orderItems,
      totalAmount,
      discountAmount,
      promoCode: promoCodeId,
      contactDetails,
      address,
      status: "pending",
      payment: {
        merchantOrderId,
        paymentStatus: "PENDING",
        amount: totalAmount,
      },
    });

    appendPaymentHistory(order, {
      action: "payment_initiated",
      status: "PENDING",
      message: "Order created and payment initiated via ZWITCH",
      data: {
        amount: totalAmount,
        merchantOrderId,
      },
    });

    await order.save();

    (async () => {
      try {
        const populatedOrder = await Order.populate(order, [
          { path: "user", select: "username email" },
          { path: "items.notebook" },
        ]);
        await storeOrderInSupabase(populatedOrder);
      } catch (err) {
        console.error("Failed to sync order to Supabase:", err);
      }
    })();

    // Create ZWITCH payment token for Layer.js (contact_number must be 10-digit Indian mobile)
    const tokenPayload = {
      amount: totalAmount,
      contact_number: contactNumberForZwitch,
      email_id: (contactDetails.email || "").trim(),
      currency: "INR",
      mtx: merchantOrderId,
    };

    const tokenResponse = await axios.post(
      `${ZWITCH_BASE}${ZWITCH_PG_PATH}/payment_token`,
      tokenPayload,
      {
        headers: {
          "Content-Type": "application/json",
          ...getZwitchAuthHeader(),
        },
      }
    );

    const paymentTokenId = tokenResponse.data?.id;
    if (!paymentTokenId) {
      order.payment.paymentStatus = "FAILED";
      appendPaymentHistory(order, {
        action: "payment_session_failed",
        status: "FAILED",
        message: "ZWITCH did not return a payment token",
      });
      await order.save();
      return res.status(400).json({
        success: false,
        message: "Failed to create payment session",
      });
    }

    order.payment.zwitchPaymentTokenId = paymentTokenId;
    appendPaymentHistory(order, {
      action: "payment_session_created",
      status: "PENDING",
      message: "ZWITCH payment token created",
      data: { paymentTokenId },
    });
    await order.save();

    // Frontend will use paymentToken + accessKey to open Layer.checkout()
    res.json({
      success: true,
      orderId: order._id,
      merchantOrderId,
      paymentToken: paymentTokenId,
      accessKey: ZWITCH_PG_ACCESS_KEY,
      layerScriptUrl: ZWITCH_ENV === "production"
        ? "https://payments.open.money/layer"
        : "https://sandbox-payments.open.money/layer",
    });
  } catch (error) {
    console.error("Payment initiation error:", error.response?.data || error.message);
    res.status(500).json({
      message: error.response?.data?.message || error.message || "Failed to initiate payment",
    });
  }
});

// Persist payment method from Layer callback as a fallback source.
router.post("/method", auth, async (req, res) => {
  try {
    const { merchantOrderId, paymentMethod } = req.body || {};
    if (!merchantOrderId || !paymentMethod) {
      return res.status(400).json({ message: "merchantOrderId and paymentMethod are required" });
    }

    const normalized = normalizePaymentMethod(paymentMethod);
    if (!normalized) {
      return res.status(400).json({ message: "Invalid payment method" });
    }

    const order = await Order.findOne({
      "payment.merchantOrderId": merchantOrderId,
      user: req.user._id,
    });
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (order.payment?.paymentMethod !== normalized) {
      order.payment.paymentMethod = normalized;
      await order.save();
      updateOrderInSupabase(order._id.toString(), { payment: order.payment }).catch(() => {});
    }

    res.json({ success: true, paymentMethod: order.payment?.paymentMethod || normalized });
  } catch (error) {
    res.status(500).json({ message: error.message || "Failed to save payment method" });
  }
});

// Check payment status (by merchantOrderId; server polls ZWITCH by payment token id)
router.get("/status/:merchantOrderId", auth, async (req, res) => {
  try {
    const { merchantOrderId } = req.params;

    const order = await Order.findOne({
      "payment.merchantOrderId": merchantOrderId,
      user: req.user._id,
    }).populate("items.notebook");

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const tokenId = order.payment.zwitchPaymentTokenId;
    const shouldBackfillMethod = order.payment.paymentStatus === "SUCCESS" && !order.payment.paymentMethod;
    if (tokenId && (order.payment.paymentStatus !== "SUCCESS" || shouldBackfillMethod)) {
      try {
        const statusResponse = await axios.get(
          `${ZWITCH_BASE}${ZWITCH_PG_PATH}/payment_token/${tokenId}/payment`,
          {
            headers: getZwitchAuthHeader(),
          }
        );

        const data = statusResponse.data;
        const paymentStatus = data?.status;
        const tokenStatus = data?.payment_token?.status;
        const method = extractPaymentMethodFromPayload(data);
        if (method) order.payment.paymentMethod = method;

        if (paymentStatus === "captured" || tokenStatus === "paid") {
          const shouldRecordSuccess =
            order.payment.paymentStatus !== "SUCCESS" || !order.payment.paymentTransactionId;
          order.payment.paymentStatus = "SUCCESS";
          order.status = "processing";
          if (data?.id) {
            order.payment.paymentTransactionId = data.id;
          }
          if (shouldRecordSuccess) {
            appendPaymentHistory(order, {
              action: "payment_captured",
              status: "SUCCESS",
              message: "Payment captured after status check",
              data: {
                paymentId: data?.id || null,
                tokenId,
              },
            });
          }

          const needsStockUpdate = order.items?.length > 0;
          if (needsStockUpdate) {
            for (const item of order.items) {
              await Notebook.findByIdAndUpdate(item.notebook, {
                $inc: { stockQuantity: -item.quantity },
              });
            }
          }

          await order.save();
          if (order.promoCode) {
            await PromoCode.findByIdAndUpdate(order.promoCode, { $inc: { usedCount: 1 } });
          }
          updateOrderInSupabase(order._id.toString(), {
            status: order.status,
            payment: order.payment,
          }).catch((err) => console.error("Failed to update order in Supabase:", err));
          generateAndSendInvoice(order._id).catch((err) =>
            console.error("Failed to generate/send invoice:", err)
          );
        } else if (paymentStatus === "failed") {
          if (order.payment.paymentStatus !== "FAILED") {
            appendPaymentHistory(order, {
              action: "payment_failed",
              status: "FAILED",
              message: "Payment failed during status check",
              data: { tokenId },
            });
          }
          order.payment.paymentStatus = "FAILED";
          await order.save();
        } else if (shouldBackfillMethod && method) {
          await order.save();
          updateOrderInSupabase(order._id.toString(), { payment: order.payment }).catch(() => {});
        }
      } catch (statusError) {
        console.error("ZWITCH status API error:", {
          message: statusError.message,
          response: statusError.response?.data,
        });
      }
    }

    res.json({
      orderId: order._id,
      paymentStatus: order.payment.paymentStatus,
      orderStatus: order.status,
    });
  } catch (error) {
    console.error("Payment status check error:", error);
    res.status(500).json({ message: error.message });
  }
});

// ZWITCH webhook (payment_token_paid, payment_captured, etc.)
// Note: Body is parsed by express.json(); we verify using canonical JSON string
router.post("/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-zwitch-signature"];
    const normalizedPayload = typeof req.body === "string"
      ? JSON.stringify(JSON.parse(req.body))
      : JSON.stringify(req.body);

    if (!verifyZwitchWebhookSignature(normalizedPayload, signature)) {
      console.error("Invalid ZWITCH webhook signature");
      return res.status(401).json({ message: "Invalid signature" });
    }

    const payload = req.body;
    const event = payload.event;
    const mtx = payload.mtx || payload.payment_token?.mtx;
    const paymentTokenId = payload.id || payload.payment_token?.id;

    if (!mtx && !paymentTokenId) {
      return res.status(200).json({ received: true });
    }

    const order = await Order.findOne({
      $or: [
        { "payment.merchantOrderId": mtx },
        { "payment.zwitchPaymentTokenId": paymentTokenId },
      ],
    });

    if (!order) {
      return res.status(200).json({ received: true });
    }

    const isPaid =
      event === "payment_token_paid" ||
      event === "payment_captured" ||
      payload.status === "paid";

    if (isPaid) {
      const shouldRecordSuccess =
        order.payment.paymentStatus !== "SUCCESS" || !order.payment.paymentTransactionId;
      order.payment.paymentStatus = "SUCCESS";
      order.status = "processing";
      if (payload.payment?.id) {
        order.payment.paymentTransactionId = payload.payment.id;
      }
      const method = extractPaymentMethodFromPayload(payload);
      if (method) order.payment.paymentMethod = method;
      if (shouldRecordSuccess) {
        appendPaymentHistory(order, {
          action: "payment_captured",
          status: "SUCCESS",
          message: `Payment captured via webhook (${event || "zwitch"})`,
          data: {
            paymentId: payload.payment?.id || null,
            paymentTokenId,
            event,
          },
        });
      }

      for (const item of order.items) {
        await Notebook.findByIdAndUpdate(item.notebook, {
          $inc: { stockQuantity: -item.quantity },
        });
      }

      await order.save();
      if (order.promoCode) {
        await PromoCode.findByIdAndUpdate(order.promoCode, { $inc: { usedCount: 1 } });
      }
      updateOrderInSupabase(order._id.toString(), {
        status: order.status,
        payment: order.payment,
      }).catch((err) => console.error("Failed to update order in Supabase:", err));
      generateAndSendInvoice(order._id).catch((err) =>
        console.error("Failed to generate/send invoice:", err)
      );
    } else if (event === "payment_failed" || event === "payment_cancelled") {
      if (order.payment.paymentStatus !== "FAILED") {
        appendPaymentHistory(order, {
          action: event === "payment_cancelled" ? "payment_cancelled" : "payment_failed",
          status: "FAILED",
          message: `Payment ${event === "payment_cancelled" ? "cancelled" : "failed"} via webhook`,
          data: { event, paymentTokenId },
        });
      }
      order.payment.paymentStatus = "FAILED";
      await order.save();
      updateOrderInSupabase(order._id.toString(), { payment: order.payment }).catch(() => {});
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
