const HISTORY_LIMIT = 100;

function ensureShiprocketState(order) {
  if (!order.shiprocket || typeof order.shiprocket !== "object") {
    order.shiprocket = {};
  }
  if (!Array.isArray(order.shiprocket.history)) {
    order.shiprocket.history = [];
  }
  return order.shiprocket;
}

function appendShiprocketHistory(order, entry = {}) {
  const shiprocket = ensureShiprocketState(order);
  const historyEntry = {
    action: entry.action || "updated",
    status: entry.status || null,
    message: entry.message || "",
    data: entry.data || null,
    at: entry.at || new Date(),
  };

  shiprocket.history.push(historyEntry);
  if (shiprocket.history.length > HISTORY_LIMIT) {
    shiprocket.history = shiprocket.history.slice(-HISTORY_LIMIT);
  }

  if (entry.status) {
    shiprocket.trackingStatus = entry.status;
  }
  if (entry.action) {
    shiprocket.lastAction = entry.action;
  }

  return historyEntry;
}

module.exports = {
  appendShiprocketHistory,
  ensureShiprocketState,
};
