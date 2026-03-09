const mongoose = require("mongoose");

const PromoCodeSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true,
  },
  /** "percent" or "fixed" */
  type: {
    type: String,
    required: true,
    enum: ["percent", "fixed"],
  },
  /** Discount value: percentage (0–100) or fixed amount in ₹ */
  value: {
    type: Number,
    required: true,
    min: 0,
  },
  /** Optional minimum order amount (in ₹) for the code to apply */
  minOrderAmount: {
    type: Number,
    default: 0,
    min: 0,
  },
  /** Optional start date – code valid from this date */
  validFrom: {
    type: Date,
    default: Date.now,
  },
  /** Optional end date – code invalid after this date */
  validUntil: {
    type: Date,
    default: null,
  },
  /** Optional max number of times the code can be used (null = unlimited) */
  maxUses: {
    type: Number,
    default: null,
    min: 1,
  },
  /** Number of times the code has been used */
  usedCount: {
    type: Number,
    default: 0,
    min: 0,
  },
  active: {
    type: Boolean,
    default: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("PromoCode", PromoCodeSchema);
