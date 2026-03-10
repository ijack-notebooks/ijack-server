const axios = require("axios");
const {
  isConfigured,
  isTestMode,
  shiprocketFetch,
} = require("../config/shiprocket");
const { appendShiprocketHistory, ensureShiprocketState } = require("./shiprocketHistory");
const { appendPaymentHistory, ensurePaymentState } = require("./paymentHistory");

function createError(message, status = 500, details) {
  const error = new Error(message);
  error.status = status;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

function buildZwitchRefundAuthHeader() {
  const accessKey = process.env.ZWITCH_ACCESS_KEY;
  const secretKey = process.env.ZWITCH_SECRET_KEY;

  if (!accessKey || !secretKey) {
    throw createError(
      "ZWITCH regular API keys (ZWITCH_ACCESS_KEY / ZWITCH_SECRET_KEY) are not configured. " +
      "UPI Refund requires keys from Dashboard → Developers → API Keys (not PG API Keys).",
      503,
    );
  }

  return { Authorization: `Bearer ${accessKey}:${secretKey}` };
}

function getRefundPaymentId(order) {
  return order?.payment?.paymentTransactionId || order?.payment?.phonepeTransactionId || null;
}

function getRefundEligibility(order) {
  if (!order?.payment) {
    return { eligible: false, reason: "No payment information found for this order" };
  }
  if (order.payment.paymentStatus !== "SUCCESS") {
    return { eligible: false, reason: "Only successfully paid orders can be refunded" };
  }
  if (order.payment.refundedAt) {
    return { eligible: false, reason: "This order has already been refunded" };
  }
  if (!getRefundPaymentId(order)) {
    return { eligible: false, reason: "No payment transaction ID found for this order" };
  }
  return { eligible: true };
}

async function cancelShiprocketShipment(order, options = {}) {
  const {
    source = "admin",
    reason = "Shipment cancelled",
    strict = false,
  } = options;

  if (!order) {
    throw createError("Order is required", 500);
  }

  const srOrderId = order.shiprocket?.orderId;
  const shipmentId = order.shiprocket?.shipmentId;

  if (!srOrderId) {
    if (strict) {
      throw createError("No Shiprocket shipment found for this order", 400);
    }
    return { skipped: true, reason: "No Shiprocket shipment found for this order" };
  }

  if (order.shiprocket?.active === false) {
    return { skipped: true, reason: "Shipment is already cancelled" };
  }

  if (!isConfigured()) {
    throw createError("Shiprocket is not configured", 503);
  }

  if (isTestMode()) {
    const shiprocket = ensureShiprocketState(order);
    shiprocket.active = false;
    shiprocket.cancelledAt = new Date();
    appendShiprocketHistory(order, {
      action: "shipment_cancelled",
      status: "Cancelled",
      message: `[TEST MODE] ${reason}`,
      data: { source },
    });
    return { cancelled: true, testMode: true };
  }

  let pickupCancelData = null;

  if (shipmentId) {
    try {
      pickupCancelData = await shiprocketFetch("/v1/external/courier/cancel/pickup", {
        method: "POST",
        body: JSON.stringify({ shipment_id: [Number(shipmentId)] }),
      });
      appendShiprocketHistory(order, {
        action: "pickup_cancelled",
        status: order.shiprocket?.trackingStatus || "Pickup cancelled",
        message: `Scheduled pickup cancelled in Shiprocket (${source})`,
        data: pickupCancelData,
      });
    } catch (pickupErr) {
      appendShiprocketHistory(order, {
        action: "pickup_cancel_failed",
        status: order.shiprocket?.trackingStatus || null,
        message: `Pickup cancellation skipped: ${pickupErr.message}`,
        data: pickupErr.response || null,
      });
    }
  }

  const data = await shiprocketFetch("/v1/external/orders/cancel", {
    method: "POST",
    body: JSON.stringify({ ids: [Number(srOrderId)] }),
  });

  const shiprocket = ensureShiprocketState(order);
  shiprocket.active = false;
  shiprocket.cancelledAt = new Date();
  appendShiprocketHistory(order, {
    action: "shipment_cancelled",
    status: "Cancelled",
    message: `${reason} (${source})`,
    data,
  });

  return {
    cancelled: true,
    data,
    pickupCancelData,
  };
}

async function initiateZwitchRefund(order, options = {}) {
  const {
    source = "admin",
    reason = "Refund initiated",
    strict = false,
  } = options;

  if (!order) {
    throw createError("Order is required", 500);
  }

  const eligibility = getRefundEligibility(order);
  if (!eligibility.eligible) {
    if (strict) {
      throw createError(eligibility.reason, 400);
    }
    return { skipped: true, reason: eligibility.reason };
  }

  const paymentId = getRefundPaymentId(order);
  const merchantReferenceId = `refund_${String(order._id).replace(/[^a-zA-Z0-9]/g, "").slice(0, 20)}_${Date.now()}`;
  let refundRes;

  try {
    refundRes = await axios.post(
      "https://api.zwitch.io/payments/upi/refund",
      { id: paymentId, merchant_reference_id: merchantReferenceId },
      {
        headers: {
          "Content-Type": "application/json",
          ...buildZwitchRefundAuthHeader(),
        },
      },
    );
  } catch (error) {
    const externalStatus = error.response?.status;
    const externalData = error.response?.data;
    const externalMessage =
      externalData?.error?.message ||
      externalData?.message ||
      error.message ||
      "ZWITCH refund failed";

    console.error(
      "ZWITCH refund API error:",
      externalStatus,
      JSON.stringify(externalData, null, 2),
    );

    const mappedStatus = externalStatus === 400 ? 400 : 502;

    throw createError(
      `ZWITCH refund request failed: ${externalMessage}`,
      mappedStatus,
      externalData,
    );
  }

  const payment = ensurePaymentState(order);
  payment.refundedAt = new Date();
  order.status = "cancelled";
  appendPaymentHistory(order, {
    action: "refund_initiated",
    status: "REFUNDED",
    message: `${reason} (${source})`,
    data: {
      source,
      paymentId,
      merchantReferenceId,
      response: refundRes.data,
    },
  });

  return {
    initiated: true,
    paymentId,
    merchantReferenceId,
    data: refundRes.data,
  };
}

module.exports = {
  cancelShiprocketShipment,
  createError,
  getRefundEligibility,
  initiateZwitchRefund,
};
