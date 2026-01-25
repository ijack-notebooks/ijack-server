const supabase = require("../config/supabase");

/**
 * Store order in Supabase PostgreSQL database
 * @param {Object} orderData - Order data from MongoDB
 * @returns {Promise<Object>} - Supabase response
 */
async function storeOrderInSupabase(orderData) {
  if (!supabase) {
    console.warn("Supabase not configured. Skipping order storage.");
    return null;
  }

  try {
    // Ensure orderData has required fields
    if (!orderData || !orderData._id) {
      console.error("Invalid order data provided to Supabase sync");
      return null;
    }

    // Prepare order items for Supabase
    const orderItems = (orderData.items || []).map((item) => ({
      notebook_id: item.notebook?._id?.toString() || item.notebook?.toString() || null,
      notebook_name: item.notebook?.name || item.notebook?.name || "Unknown",
      quantity: item.quantity || 0,
      price: item.price || 0,
      subtotal: (item.price || 0) * (item.quantity || 0),
    }));

    // Insert main order record
    const { data: orderRecord, error: orderError } = await supabase
      .from("orders")
      .insert({
        mongodb_order_id: orderData._id.toString(),
        user_id: orderData.user?._id?.toString() || orderData.user?.toString() || null,
        user_username: orderData.user?.username || null,
        user_email: orderData.user?.email || null,
        total_amount: orderData.totalAmount,
        status: orderData.status,
        // Contact details
        contact_name: orderData.contactDetails?.name || null,
        contact_email: orderData.contactDetails?.email || null,
        contact_phone: orderData.contactDetails?.phone || null,
        // Address
        address_street: orderData.address?.street || null,
        address_city: orderData.address?.city || null,
        address_state: orderData.address?.state || null,
        address_zip_code: orderData.address?.zipCode || null,
        address_country: orderData.address?.country || null,
        // Payment details
        payment_merchant_order_id: orderData.payment?.merchantOrderId || null,
        payment_transaction_id: orderData.payment?.phonepeTransactionId || null,
        payment_status: orderData.payment?.paymentStatus || "PENDING",
        payment_method: orderData.payment?.paymentMethod || "ONLINE",
        payment_amount: orderData.payment?.amount || orderData.totalAmount,
        created_at: orderData.createdAt || new Date().toISOString(),
      })
      .select()
      .single();

    if (orderError) {
      console.error("Error inserting order into Supabase:", orderError);
      throw orderError;
    }

    // Insert order items
    if (orderItems.length > 0 && orderRecord) {
      const itemsWithOrderId = orderItems.map((item) => ({
        ...item,
        order_id: orderRecord.id,
      }));

      const { error: itemsError } = await supabase
        .from("order_items")
        .insert(itemsWithOrderId);

      if (itemsError) {
        console.error("Error inserting order items into Supabase:", itemsError);
        // Don't throw - order is already created, just log the error
      }
    }

    console.log(`✅ Order ${orderData._id} synced to Supabase (ID: ${orderRecord.id})`);
    return orderRecord;
  } catch (error) {
    console.error("Error storing order in Supabase:", error);
    // Don't throw - allow MongoDB to continue working even if Supabase fails
    return null;
  }
}

/**
 * Update order payment status in Supabase
 * @param {String} mongodbOrderId - MongoDB order ID
 * @param {Object} updateData - Data to update
 * @returns {Promise<Object>} - Supabase response
 */
async function updateOrderInSupabase(mongodbOrderId, updateData) {
  if (!supabase) {
    return null;
  }

  try {
    const updatePayload = {};

    if (updateData.status) {
      updatePayload.status = updateData.status;
    }

    if (updateData.payment) {
      if (updateData.payment.paymentStatus) {
        updatePayload.payment_status = updateData.payment.paymentStatus;
      }
      if (updateData.payment.phonepeTransactionId) {
        updatePayload.payment_transaction_id = updateData.payment.phonepeTransactionId;
      }
      if (updateData.payment.paymentMethod) {
        updatePayload.payment_method = updateData.payment.paymentMethod;
      }
      if (updateData.payment.amount) {
        updatePayload.payment_amount = updateData.payment.amount;
      }
    }

    const { data, error } = await supabase
      .from("orders")
      .update(updatePayload)
      .eq("mongodb_order_id", mongodbOrderId.toString())
      .select()
      .single();

    if (error) {
      console.error("Error updating order in Supabase:", error);
      return null;
    }

    console.log(`✅ Order ${mongodbOrderId} updated in Supabase`);
    return data;
  } catch (error) {
    console.error("Error updating order in Supabase:", error);
    return null;
  }
}

module.exports = {
  storeOrderInSupabase,
  updateOrderInSupabase,
};
