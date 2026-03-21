const mongoose = require("mongoose");

const OrderItemSchema = new mongoose.Schema({
  notebook: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Notebook",
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
    min: 1,
  },
  price: {
    type: Number,
    required: true,
  },
});

const ShiprocketHistorySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      default: null,
    },
    message: {
      type: String,
      default: "",
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    at: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false },
);

const PaymentHistorySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      default: null,
    },
    message: {
      type: String,
      default: "",
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    at: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false },
);

const OrderSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  items: [OrderItemSchema],
  totalAmount: {
    type: Number,
    required: true,
  },
  contactDetails: {
    name: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
    },
    phone: {
      type: String,
      required: true,
    },
  },
  address: {
    street: {
      type: String,
      required: true,
    },
    city: {
      type: String,
      required: true,
    },
    state: {
      type: String,
      required: true,
    },
    zipCode: {
      type: String,
      required: true,
    },
    country: {
      type: String,
      required: true,
    },
  },
  status: {
    type: String,
    enum: ["pending", "processing", "shipped", "delivered", "cancelled"],
    default: "pending",
  },
  payment: {
    merchantOrderId: {
      type: String,
      unique: true,
    },
    zwitchPaymentTokenId: {
      type: String,
    },
    paymentTransactionId: {
      type: String,
    },
    phonepeTransactionId: {
      type: String,
    },
    paymentStatus: {
      type: String,
      enum: ["PENDING", "SUCCESS", "FAILED", "CANCELLED"],
      default: "PENDING",
    },
    paymentMethod: {
      type: String,
    },
    amount: {
      type: Number,
    },
    refundedAt: {
      type: Date,
      default: null,
    },
    history: {
      type: [PaymentHistorySchema],
      default: [],
    },
  },
  invoiceNumber: {
    type: String,
    default: null,
  },
  promoCode: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "PromoCode",
    default: null,
  },
  discountAmount: {
    type: Number,
    default: 0,
  },
  shipping: {
    charge: { type: Number, default: 0 },
    courierCompanyId: { type: Number, default: null },
    courierName: { type: String, default: null },
    etdDays: { type: String, default: null },
    pickupPincode: { type: String, default: null },
    deliveryPincode: { type: String, default: null },
    weightKg: { type: Number, default: null },
    lengthCm: { type: Number, default: null },
    breadthCm: { type: Number, default: null },
    heightCm: { type: Number, default: null },
  },
  shiprocket: {
    orderId: { type: Number },
    shipmentId: { type: Number },
    awbCode: { type: String },
    courierName: { type: String },
    labelUrl: { type: String },
    active: { type: Boolean, default: true },
    lastAction: { type: String },
    trackingStatus: { type: String },
    trackingUrl: { type: String },
    lastWebhookAt: { type: Date },
    cancelledAt: { type: Date },
    history: {
      type: [ShiprocketHistorySchema],
      default: [],
    },
    createdAt: { type: Date, default: Date.now },
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Order", OrderSchema);
