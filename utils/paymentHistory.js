const HISTORY_LIMIT = 100;

function ensurePaymentState(order) {
  if (!order.payment || typeof order.payment !== "object") {
    order.payment = {};
  }
  if (!Array.isArray(order.payment.history)) {
    order.payment.history = [];
  }
  return order.payment;
}

function appendPaymentHistory(order, entry = {}) {
  const payment = ensurePaymentState(order);
  const historyEntry = {
    action: entry.action || "updated",
    status: entry.status || null,
    message: entry.message || "",
    data: entry.data || null,
    at: entry.at || new Date(),
  };

  payment.history.push(historyEntry);
  if (payment.history.length > HISTORY_LIMIT) {
    payment.history = payment.history.slice(-HISTORY_LIMIT);
  }

  return historyEntry;
}

module.exports = {
  appendPaymentHistory,
  ensurePaymentState,
};
