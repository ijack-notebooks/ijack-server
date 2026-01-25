const express = require("express");
const router = express.Router();
const supabase = require("../config/supabase");
const { adminAuth } = require("../middleware/adminAuth");

// Test endpoint to verify route is working (no auth for testing)
router.get("/test", (req, res) => {
  res.json({ 
    message: "Supabase routes are working",
    supabaseConfigured: supabase !== null,
    timestamp: new Date().toISOString()
  });
});

// Get all orders from Supabase
router.get("/orders", adminAuth, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ message: "Supabase not configured" });
    }

    const { data, error } = await supabase
      .from("orders")
      .select(`
        *,
        order_items (*)
      `)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Supabase error:", error);
      return res.status(500).json({ message: error.message });
    }

    // Transform Supabase data to match expected format
    const transformedOrders = data.map((order) => ({
      _id: order.mongodb_order_id,
      supabase_id: order.id,
      user: {
        _id: order.user_id,
        username: order.user_username,
        email: order.user_email,
      },
      items: order.order_items?.map((item) => ({
        notebook: {
          _id: item.notebook_id,
          name: item.notebook_name,
        },
        quantity: item.quantity,
        price: item.price,
      })) || [],
      totalAmount: parseFloat(order.total_amount),
      status: order.status,
      contactDetails: {
        name: order.contact_name,
        email: order.contact_email,
        phone: order.contact_phone,
      },
      address: {
        street: order.address_street,
        city: order.address_city,
        state: order.address_state,
        zipCode: order.address_zip_code,
        country: order.address_country,
      },
      payment: {
        merchantOrderId: order.payment_merchant_order_id,
        phonepeTransactionId: order.payment_transaction_id,
        paymentStatus: order.payment_status,
        paymentMethod: order.payment_method,
        amount: order.payment_amount ? parseFloat(order.payment_amount) : null,
      },
      createdAt: order.created_at,
      updatedAt: order.updated_at,
    }));

    res.json(transformedOrders);
  } catch (error) {
    console.error("Error fetching orders from Supabase:", error);
    res.status(500).json({ message: error.message });
  }
});

// Get order statistics from Supabase
router.get("/stats", adminAuth, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ message: "Supabase not configured" });
    }

    // Get total orders
    const { count: totalOrders } = await supabase
      .from("orders")
      .select("*", { count: "exact", head: true });

    // Get total revenue (only successful payments)
    const { data: revenueData } = await supabase
      .from("orders")
      .select("total_amount")
      .eq("payment_status", "SUCCESS");

    const totalRevenue = revenueData?.reduce((sum, order) => {
      return sum + parseFloat(order.total_amount || 0);
    }, 0) || 0;

    // Get orders by status
    const { data: statusData } = await supabase
      .from("orders")
      .select("status");

    const ordersByStatus = statusData?.reduce((acc, order) => {
      const status = order.status || "pending";
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {}) || {};

    // Get payment statistics
    const { data: paymentData } = await supabase
      .from("orders")
      .select("payment_status");

    const paymentStats = paymentData?.reduce((acc, order) => {
      const status = order.payment_status || "PENDING";
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {}) || {};

    // Transform to match expected format
    const ordersByStatusArray = Object.entries(ordersByStatus).map(([_id, count]) => ({
      _id,
      count,
    }));

    const paymentStatsArray = Object.entries(paymentStats).map(([_id, count]) => ({
      _id,
      count,
    }));

    res.json({
      totalOrders: totalOrders || 0,
      totalRevenue,
      ordersByStatus: ordersByStatusArray,
      paymentStats: paymentStatsArray,
    });
  } catch (error) {
    console.error("Error fetching stats from Supabase:", error);
    res.status(500).json({ message: error.message });
  }
});

// Get single order from Supabase
router.get("/orders/:mongodbOrderId", adminAuth, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ message: "Supabase not configured" });
    }

    const { mongodbOrderId } = req.params;

    const { data: orderData, error } = await supabase
      .from("orders")
      .select(`
        *,
        order_items (*)
      `)
      .eq("mongodb_order_id", mongodbOrderId)
      .single();

    if (error || !orderData) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Transform to match expected format
    const order = {
      _id: orderData.mongodb_order_id,
      supabase_id: orderData.id,
      user: {
        _id: orderData.user_id,
        username: orderData.user_username,
        email: orderData.user_email,
      },
      items: orderData.order_items?.map((item) => ({
        notebook: {
          _id: item.notebook_id,
          name: item.notebook_name,
        },
        quantity: item.quantity,
        price: item.price,
      })) || [],
      totalAmount: parseFloat(orderData.total_amount),
      status: orderData.status,
      contactDetails: {
        name: orderData.contact_name,
        email: orderData.contact_email,
        phone: orderData.contact_phone,
      },
      address: {
        street: orderData.address_street,
        city: orderData.address_city,
        state: orderData.address_state,
        zipCode: orderData.address_zip_code,
        country: orderData.address_country,
      },
      payment: {
        merchantOrderId: orderData.payment_merchant_order_id,
        phonepeTransactionId: orderData.payment_transaction_id,
        paymentStatus: orderData.payment_status,
        paymentMethod: orderData.payment_method,
        amount: orderData.payment_amount ? parseFloat(orderData.payment_amount) : null,
      },
      createdAt: orderData.created_at,
      updatedAt: orderData.updated_at,
    };

    res.json(order);
  } catch (error) {
    console.error("Error fetching order from Supabase:", error);
    res.status(500).json({ message: error.message });
  }
});

// Get financial summary from Supabase
router.get("/financial-summary", adminAuth, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ message: "Supabase not configured" });
    }

    // Use the financial_summary view
    const { data, error } = await supabase
      .from("financial_summary")
      .select("*")
      .order("order_date", { ascending: false })
      .limit(30); // Last 30 days

    if (error) {
      console.error("Supabase error:", error);
      return res.status(500).json({ message: error.message });
    }

    res.json(data || []);
  } catch (error) {
    console.error("Error fetching financial summary:", error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
