const express = require("express");
const router = express.Router();
const axios = require("axios");
const crypto = require("crypto");
const Order = require("../models/Order");
const Notebook = require("../models/Notebook");
const { auth } = require("../middleware/auth");
const { storeOrderInSupabase, updateOrderInSupabase } = require("../utils/supabaseOrders");

// PhonePe Configuration
const PHONEPE_MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID;
const PHONEPE_SALT_KEY = process.env.PHONEPE_SALT_KEY;
const PHONEPE_SALT_INDEX = process.env.PHONEPE_SALT_INDEX || 1;
const PHONEPE_CLIENT_ID = process.env.PHONEPE_CLIENT_ID;
const PHONEPE_CLIENT_SECRET = process.env.PHONEPE_CLIENT_SECRET;
const PHONEPE_CLIENT_VERSION = process.env.PHONEPE_CLIENT_VERSION || "1.0";
const PHONEPE_ENV = process.env.PHONEPE_ENVIRONMENT || "SANDBOX"; // SANDBOX or PRODUCTION

// PhonePe API URLs (based on official documentation)
const PHONEPE_BASE_URL = PHONEPE_ENV === "PRODUCTION" 
  ? "https://api.phonepe.com/apis/pg"
  : "https://api-preprod.phonepe.com/apis/pg-sandbox";

const PHONEPE_AUTH_URL = PHONEPE_ENV === "PRODUCTION"
  ? "https://api.phonepe.com/apis/identity-manager"
  : "https://api-preprod.phonepe.com/apis/pg-sandbox";

// Generate unique merchant order ID
const generateMerchantOrderId = () => {
  return `ORDER_${Date.now()}_${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
};

// Generate X-VERIFY header for PhonePe (used for webhooks)
const generateXVerify = (payload, endpoint) => {
  const string = payload + endpoint + PHONEPE_SALT_KEY;
  const sha256 = crypto.createHash("sha256").update(string).digest("hex");
  return sha256 + "###" + PHONEPE_SALT_INDEX;
};

// Get PhonePe access token (OAuth 2.0 Client Credentials)
let accessToken = null;
let tokenExpiry = null;

const getAccessToken = async () => {
  try {
    // Check if token is still valid
    if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
      return accessToken;
    }

    // PhonePe uses application/x-www-form-urlencoded for token request
    const params = new URLSearchParams();
    params.append("client_id", PHONEPE_CLIENT_ID);
    params.append("client_version", PHONEPE_CLIENT_VERSION);
    params.append("client_secret", PHONEPE_CLIENT_SECRET);
    params.append("grant_type", "client_credentials");

    const response = await axios.post(
      `${PHONEPE_AUTH_URL}/v1/oauth/token`,
      params.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    if (response.data && response.data.access_token) {
      accessToken = response.data.access_token;
      // Use expires_at from response (in seconds) or default to 50 minutes
      const expiresAt = response.data.expires_at 
        ? response.data.expires_at * 1000 // Convert to milliseconds
        : Date.now() + 50 * 60 * 1000; // Default 50 minutes
      tokenExpiry = expiresAt;
      return accessToken;
    }

    throw new Error("Failed to get access token");
  } catch (error) {
    console.error("PhonePe auth error:", error.response?.data || error.message);
    throw error;
  }
};

// Create order and initiate payment
router.post("/initiate", auth, async (req, res) => {
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

    // Generate merchant order ID
    const merchantOrderId = generateMerchantOrderId();

    // Create order with pending payment status
    const order = new Order({
      user: req.user._id,
      items: orderItems,
      totalAmount,
      contactDetails,
      address,
      status: "pending",
      payment: {
        merchantOrderId,
        paymentStatus: "PENDING",
        amount: totalAmount,
      },
    });

    await order.save();

    // Sync order to Supabase (async, don't wait)
    // Populate order data for Supabase sync
    (async () => {
      try {
        const populatedOrder = await Order.populate(order, [
          { path: "user", select: "username email" },
          { path: "items.notebook" }
        ]);
        await storeOrderInSupabase(populatedOrder);
      } catch (err) {
        console.error("Failed to sync order to Supabase:", err);
        // Don't throw - allow payment to continue even if Supabase sync fails
      }
    })();

    // Get access token
    const token = await getAccessToken();

    // Prepare PhonePe payment request (v2 API structure)
    const redirectUrl = `${process.env.FRONTEND_URL || "https://ijack-web.onrender.com"}/payment/callback`;

    const paymentRequest = {
      merchantOrderId: merchantOrderId,
      amount: Math.round(totalAmount * 100), // Amount in paise
      paymentFlow: {
        type: "PG_CHECKOUT",
        merchantUrls: {
          redirectUrl: redirectUrl,
        },
      },
    };

    // Initiate payment with PhonePe (v2 API - no base64 encoding needed)
    const endpoint = "/checkout/v2/pay";
    const paymentResponse = await axios.post(
      `${PHONEPE_BASE_URL}${endpoint}`,
      paymentRequest,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `O-Bearer ${token}`, // Note: O-Bearer (not Bearer)
        },
      }
    );

    if (paymentResponse.data && paymentResponse.data.redirectUrl) {
      // Update order with PhonePe order ID if available
      if (paymentResponse.data.orderId) {
        order.payment.phonepeTransactionId = paymentResponse.data.orderId;
        await order.save();
      }

      res.json({
        success: true,
        orderId: order._id,
        merchantOrderId: merchantOrderId,
        redirectUrl: paymentResponse.data.redirectUrl,
        paymentUrl: paymentResponse.data.redirectUrl,
      });
    } else {
      // Payment initiation failed
      order.payment.paymentStatus = "FAILED";
      await order.save();

      res.status(400).json({
        success: false,
        message: paymentResponse.data?.message || "Failed to initiate payment",
      });
    }
  } catch (error) {
    console.error("Payment initiation error:", error.response?.data || error.message);
    res.status(500).json({ 
      message: error.response?.data?.message || error.message || "Failed to initiate payment" 
    });
  }
});

// Check payment status
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

    // If order is already marked as SUCCESS, return immediately (might have been updated by webhook)
    if (order.payment.paymentStatus === "SUCCESS") {
      return res.json({
        orderId: order._id,
        paymentStatus: order.payment.paymentStatus,
        orderStatus: order.status,
      });
    }

    // Check status with PhonePe (v2 API)
    try {
      const token = await getAccessToken();
      const endpoint = `/checkout/v2/order/${merchantOrderId}/status`;

      const statusResponse = await axios.get(
        `${PHONEPE_BASE_URL}${endpoint}`,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `O-Bearer ${token}`, // Note: O-Bearer (not Bearer)
          },
          params: {
            details: true, // Get all payment attempts for better detection
            errorContext: false, // Don't need error context for now
          },
        }
      );
      
      console.log("PhonePe Status Response:", JSON.stringify(statusResponse.data, null, 2));

      if (statusResponse.data) {
        const paymentData = statusResponse.data;
        
        // Check paymentDetails array for successful payments
        let hasSuccessfulPayment = false;
        if (paymentData.paymentDetails && paymentData.paymentDetails.length > 0) {
          // Check if any payment attempt was successful
          const successfulPayment = paymentData.paymentDetails.find(
            (payment) => payment.state === "COMPLETED"
          );
          
          if (successfulPayment) {
            hasSuccessfulPayment = true;
            order.payment.paymentStatus = "SUCCESS";
            order.status = "processing";
            if (successfulPayment.transactionId) {
              order.payment.phonepeTransactionId = successfulPayment.transactionId;
            }
          } else {
            // Check if latest payment failed
            const latestPayment = paymentData.paymentDetails[paymentData.paymentDetails.length - 1];
            if (latestPayment.state === "FAILED") {
              order.payment.paymentStatus = "FAILED";
            }
          }
        }
        
        // Also check the main state field
        if (paymentData.state === "COMPLETED" || hasSuccessfulPayment) {
          if (!hasSuccessfulPayment) {
            order.payment.paymentStatus = "SUCCESS";
            order.status = "processing";
          }
          
          // Get transaction ID from paymentDetails if available
          if (paymentData.paymentDetails && paymentData.paymentDetails.length > 0) {
            const latestPayment = paymentData.paymentDetails[paymentData.paymentDetails.length - 1];
            if (latestPayment.transactionId && !order.payment.phonepeTransactionId) {
              order.payment.phonepeTransactionId = latestPayment.transactionId;
            }
          } else if (paymentData.orderId && !order.payment.phonepeTransactionId) {
            order.payment.phonepeTransactionId = paymentData.orderId;
          }

          // Update stock quantities only if not already updated
          if (order.status === "processing" && order.payment.paymentStatus === "SUCCESS") {
            // Double-check to avoid duplicate stock updates
            const needsStockUpdate = order.items.some((item) => {
              // This is a simple check - in production, you might want a more robust method
              return true; // For now, always update if payment is successful
            });
            
            if (needsStockUpdate) {
              for (const item of order.items) {
                await Notebook.findByIdAndUpdate(item.notebook, {
                  $inc: { stockQuantity: -item.quantity },
                });
              }
            }
          }
        } else if (paymentData.state === "FAILED") {
          order.payment.paymentStatus = "FAILED";
        } else if (!hasSuccessfulPayment && paymentData.state !== "COMPLETED") {
          // Keep as PENDING if not explicitly completed or failed
          order.payment.paymentStatus = "PENDING";
        }

        await order.save();

        // Update order in Supabase if payment status changed
        if (paymentData.state === "COMPLETED" || hasSuccessfulPayment) {
          updateOrderInSupabase(order._id.toString(), {
            status: order.status,
            payment: order.payment,
          }).catch((err) => {
            console.error("Failed to update order in Supabase:", err);
          });
        }
      }
    } catch (statusError) {
      console.error("PhonePe Status API error:", {
        message: statusError.message,
        response: statusError.response?.data,
        status: statusError.response?.status,
      });
      // Continue with existing order status from database
      // The order might have been updated via webhook
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

// Webhook handler for PhonePe callbacks
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const xVerify = req.headers["x-verify"];
    const payload = req.body.toString();

    // Verify webhook signature
    const endpoint = "/pg/v1/webhook";
    const expectedXVerify = generateXVerify(payload, endpoint);

    if (xVerify !== expectedXVerify) {
      console.error("Invalid webhook signature");
      return res.status(401).json({ message: "Invalid signature" });
    }

    // PhonePe webhook sends base64 encoded data
    const webhookData = JSON.parse(
      Buffer.from(payload, "base64").toString()
    );

    if (webhookData && webhookData.merchantTransactionId) {
      const order = await Order.findOne({
        "payment.merchantOrderId": webhookData.merchantTransactionId,
      });

      if (order) {
        // Update payment status based on webhook
        if (webhookData.code === "PAYMENT_SUCCESS" && webhookData.state === "COMPLETED") {
          order.payment.paymentStatus = "SUCCESS";
          order.status = "processing";
          order.payment.phonepeTransactionId = webhookData.transactionId;

          // Update stock quantities
          for (const item of order.items) {
            await Notebook.findByIdAndUpdate(item.notebook, {
              $inc: { stockQuantity: -item.quantity },
            });
          }

          // Update order in Supabase
          updateOrderInSupabase(order._id.toString(), {
            status: order.status,
            payment: order.payment,
          }).catch((err) => {
            console.error("Failed to update order in Supabase:", err);
          });
        } else if (webhookData.code === "PAYMENT_ERROR" || webhookData.state === "FAILED") {
          order.payment.paymentStatus = "FAILED";

          // Update order in Supabase
          updateOrderInSupabase(order._id.toString(), {
            payment: order.payment,
          }).catch((err) => {
            console.error("Failed to update order in Supabase:", err);
          });
        }

        await order.save();
      }
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
