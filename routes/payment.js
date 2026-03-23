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
const {
  isConfigured: isShiprocketConfigured,
  shiprocketFetch,
} = require("../config/shiprocket");

// ZWITCH Configuration (Layer Payment Gateway)
// https://developers.zwitch.io/reference
const ZWITCH_PG_ACCESS_KEY = process.env.ZWITCH_PG_ACCESS_KEY;
const ZWITCH_PG_SECRET_KEY = process.env.ZWITCH_PG_SECRET_KEY;
const ZWITCH_ENV = (process.env.ZWITCH_ENVIRONMENT || "sandbox").toLowerCase(); // sandbox | production
const ZWITCH_WEBHOOK_SECRET = process.env.ZWITCH_WEBHOOK_SIGNING_SECRET;

const ZWITCH_BASE = "https://api.zwitch.io";
const ZWITCH_PG_PATH = ZWITCH_ENV === "production" ? "/v1/pg" : "/v1/pg/sandbox";
const DEFAULT_WEIGHT_KG = 0.5;
const DEFAULT_LENGTH_CM = 25;
const DEFAULT_BREADTH_CM = 20;
const DEFAULT_HEIGHT_CM = 0.8;
/** Fixed pickup pincode for Shiprocket serviceability / shipping quotes */
const PICKUP_PINCODE = "530007";

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

function normalizePincode(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 6);
}

function safePositiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function computeBuyXGetYDiscountFromOrderItems(items = [], buyQty, getQty) {
  const buy = Number(buyQty);
  const get = Number(getQty);
  if (!Number.isFinite(buy) || !Number.isFinite(get) || buy < 1 || get < 1) {
    return 0;
  }
  const units = [];
  for (const item of items) {
    const qty = Math.max(0, Number(item.quantity) || 0);
    const price = Math.max(0, Number(item.price) || 0);
    for (let i = 0; i < qty; i += 1) units.push(price);
  }
  const freeUnits = Math.floor(units.length / (buy + get)) * get;
  if (freeUnits <= 0) return 0;
  units.sort((a, b) => a - b);
  return Math.round(units.slice(0, freeUnits).reduce((sum, p) => sum + p, 0));
}

function getPickupPincodeForShipping() {
  return PICKUP_PINCODE;
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

// Get shipping courier options from Shiprocket for checkout.
router.post("/shipping-options", auth, async (req, res) => {
  try {
    const { items, deliveryPincode, shipmentValue } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "items are required" });
    }
    const normalizedDeliveryPincode = normalizePincode(deliveryPincode);
    if (!normalizedDeliveryPincode || normalizedDeliveryPincode.length !== 6) {
      return res.status(400).json({ message: "Valid 6-digit delivery pincode is required" });
    }

    let totalWeightGrams = 0;
    let maxLengthCm = 0;
    let maxBreadthCm = 0;
    let stackedHeightCm = 0;

    for (const item of items) {
      const qty = Math.max(1, Number(item.quantity) || 1);
      const notebook = await Notebook.findById(item.notebookId).select(
        "weight lengthCm breadthCm heightCm"
      );
      if (!notebook) {
        return res.status(404).json({ message: `Notebook ${item.notebookId} not found` });
      }
      totalWeightGrams += (Number(notebook.weight) || 0) * qty;
      const itemLength = safePositiveNumber(notebook.lengthCm, DEFAULT_LENGTH_CM);
      const itemBreadth = safePositiveNumber(notebook.breadthCm, DEFAULT_BREADTH_CM);
      const itemHeight = safePositiveNumber(notebook.heightCm, DEFAULT_HEIGHT_CM);
      maxLengthCm = Math.max(maxLengthCm, itemLength);
      maxBreadthCm = Math.max(maxBreadthCm, itemBreadth);
      stackedHeightCm += itemHeight * qty;
    }

    const packageData = {
      weightKg: Math.max(DEFAULT_WEIGHT_KG, Number((totalWeightGrams / 1000).toFixed(3))),
      lengthCm: Number(Math.max(0.5, maxLengthCm || DEFAULT_LENGTH_CM).toFixed(2)),
      breadthCm: Number(Math.max(0.5, maxBreadthCm || DEFAULT_BREADTH_CM).toFixed(2)),
      heightCm: Number(Math.max(0.5, stackedHeightCm || DEFAULT_HEIGHT_CM).toFixed(2)),
    };

    // If Shiprocket is not configured, return a deterministic fallback.
    if (!isShiprocketConfigured()) {
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
      });
    }

    const pickupPincode = getPickupPincodeForShipping();
    const options = await fetchShiprocketCourierOptions({
      pickupPincode,
      deliveryPincode: normalizedDeliveryPincode,
      weightKg: packageData.weightKg,
      lengthCm: packageData.lengthCm,
      breadthCm: packageData.breadthCm,
      heightCm: packageData.heightCm,
      cod: 0,
      shipmentValue: Number(shipmentValue) || 0,
    });
    return res.json({
      fallback: false,
      pickupPincode,
      deliveryPincode: normalizedDeliveryPincode,
      package: packageData,
      options,
    });
  } catch (error) {
    console.error("Shipping options error:", error?.response || error.message);
    return res.status(error.status || 500).json({
      message: error.message || "Failed to fetch shipping options",
    });
  }
});

// Create order and get ZWITCH payment token for Layer.js
router.post("/initiate", auth, async (req, res) => {
  try {
    if (!ZWITCH_PG_ACCESS_KEY || !ZWITCH_PG_SECRET_KEY) {
      return res.status(503).json({
        success: false,
        message: "Payment gateway is not configured. Please set ZWITCH_PG_ACCESS_KEY and ZWITCH_PG_SECRET_KEY.",
      });
    }

    const { items, contactDetails, address, shippingOption } = req.body;

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
    let maxLengthCm = 0;
    let maxBreadthCm = 0;
    let stackedHeightCm = 0;
    let gstOnOriginalSubtotal = 0;
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
      const itemLength = safePositiveNumber(notebook.lengthCm, DEFAULT_LENGTH_CM);
      const itemBreadth = safePositiveNumber(notebook.breadthCm, DEFAULT_BREADTH_CM);
      const itemHeight = safePositiveNumber(notebook.heightCm, DEFAULT_HEIGHT_CM);
      maxLengthCm = Math.max(maxLengthCm, itemLength);
      maxBreadthCm = Math.max(maxBreadthCm, itemBreadth);
      stackedHeightCm += itemHeight * item.quantity;
      const gstPct = gstByCategory[notebook.category] ?? 0;
      gstOnOriginalSubtotal += (itemTotal * gstPct) / 100;

      orderItems.push({
        notebook: notebook._id,
        quantity: item.quantity,
        price: notebook.price,
      });
    }

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
        // Discount should apply before GST and shipping, so check min order on subtotal.
        const minOrderOk = !promo.minOrderAmount || subtotal >= promo.minOrderAmount;
        const usesOk = promo.maxUses == null || (promo.usedCount || 0) < promo.maxUses;
        if (validFromOk && validUntilOk && minOrderOk && usesOk) {
          if (promo.type === "percent") {
            discountAmount = Math.round((subtotal * Math.min(100, Math.max(0, promo.value))) / 100);
            promoCodeId = promo._id;
          } else if (promo.type === "fixed") {
            discountAmount = Math.min(Number(promo.value) || 0, subtotal);
            promoCodeId = promo._id;
          } else if (promo.type === "buy_x_get_y") {
            discountAmount = Math.min(
              subtotal,
              computeBuyXGetYDiscountFromOrderItems(orderItems, promo.buyQty, promo.getQty)
            );
            if (discountAmount > 0) {
              promoCodeId = promo._id;
            }
          }
        }
      }
    }

    const discountedSubtotal = Math.max(0, subtotal - discountAmount);
    const gstDiscountRatio = subtotal > 0 ? discountedSubtotal / subtotal : 1;
    const gstAmount = gstOnOriginalSubtotal * gstDiscountRatio;

    const packageData = {
      weightKg: Math.max(DEFAULT_WEIGHT_KG, Number((totalWeightGrams / 1000).toFixed(3))),
      lengthCm: Number(Math.max(0.5, maxLengthCm || DEFAULT_LENGTH_CM).toFixed(2)),
      breadthCm: Number(Math.max(0.5, maxBreadthCm || DEFAULT_BREADTH_CM).toFixed(2)),
      heightCm: Number(Math.max(0.5, stackedHeightCm || DEFAULT_HEIGHT_CM).toFixed(2)),
    };

    const normalizedDeliveryPincode = normalizePincode(address?.zipCode);
    let selectedShipping = null;
    let shippingCharge = Math.ceil(totalWeightGrams / 500) * 26;

    if (isShiprocketConfigured() && normalizedDeliveryPincode.length === 6) {
      try {
        const pickupPincode = getPickupPincodeForShipping();
        const options = await fetchShiprocketCourierOptions({
          pickupPincode,
          deliveryPincode: normalizedDeliveryPincode,
          weightKg: packageData.weightKg,
          lengthCm: packageData.lengthCm,
          breadthCm: packageData.breadthCm,
          heightCm: packageData.heightCm,
          cod: 0,
          // Shipment value should be after promo discount.
          shipmentValue: Math.round(discountedSubtotal),
        });

        if (options.length > 0) {
          const requestedCourierId = Number(shippingOption?.courierCompanyId || 0);
          selectedShipping =
            options.find((opt) => requestedCourierId && opt.courierCompanyId === requestedCourierId) ||
            options[0];
          shippingCharge = Math.round(selectedShipping.rate);
          selectedShipping = {
            ...selectedShipping,
            pickupPincode,
            deliveryPincode: normalizedDeliveryPincode,
          };
        }
      } catch (shippingError) {
        console.warn("Shiprocket shipping quote failed, using fallback shipping:", shippingError.message);
      }
    }

    const totalAmount = Math.round(discountedSubtotal + shippingCharge + gstAmount);

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
      shipping: {
        charge: shippingCharge,
        courierCompanyId: selectedShipping?.courierCompanyId || null,
        courierName: selectedShipping?.courierName || null,
        etdDays: selectedShipping?.etdDays || null,
        pickupPincode: selectedShipping?.pickupPincode || null,
        deliveryPincode: selectedShipping?.deliveryPincode || normalizedDeliveryPincode || null,
        weightKg: packageData.weightKg,
        lengthCm: packageData.lengthCm,
        breadthCm: packageData.breadthCm,
        heightCm: packageData.heightCm,
      },
    });

    appendPaymentHistory(order, {
      action: "payment_initiated",
      status: "PENDING",
      message: "Order created and payment initiated via ZWITCH",
      data: {
        amount: totalAmount,
        merchantOrderId,
        subtotal,
        discountedSubtotal,
        gstAmount: Math.round(gstAmount),
        shippingCharge,
        courier: selectedShipping?.courierName || "Fallback",
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
