const express = require("express");
const router = express.Router();
const PromoCode = require("../models/PromoCode");

// Date-only comparison in UTC: "valid until Y" includes the whole day Y.
function startOfDayUTC(d) {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}
function endOfDayUTC(d) {
  const s = startOfDayUTC(d);
  return new Date(s.getTime() + 24 * 60 * 60 * 1000 - 1);
}

/**
 * List currently valid promo codes (for display on checkout).
 * Public route; returns only active codes within valid date range.
 * Uses date-only UTC comparison so "valid until Dec 31" includes all of Dec 31.
 */
router.get("/available", async (req, res) => {
  try {
    const now = new Date();
    const startTodayUTC = startOfDayUTC(now);
    const endTodayUTC = endOfDayUTC(now);

    const codes = await PromoCode.find({ active: true })
      .select("code type value minOrderAmount validFrom validUntil maxUses usedCount")
      .lean();

    const valid = codes.filter((p) => {
      if (p.maxUses != null && (p.usedCount || 0) >= p.maxUses) return false;
      const from = p.validFrom ? new Date(p.validFrom) : null;
      const until = p.validUntil ? new Date(p.validUntil) : null;
      if (from && from > endTodayUTC) return false; // not yet valid (validFrom is in the future)
      if (until && endOfDayUTC(until) < startTodayUTC) return false; // expired (validUntil day is before today)
      return true;
    });

    res.json(
      valid.map((p) => ({
        code: p.code,
        type: p.type,
        value: p.value,
        minOrderAmount: p.minOrderAmount || 0,
        validUntil: p.validUntil || null,
        validFrom: p.validFrom || null,
        maxUses: p.maxUses,
        usesLeft: p.maxUses != null ? Math.max(0, p.maxUses - (p.usedCount || 0)) : null,
      }))
    );
  } catch (err) {
    console.error("Promo available error:", err);
    res.status(500).json([]);
  }
});

/**
 * Validate a promo code and return discount for a given order amount.
 * Public route (no auth) so checkout can validate before placing order.
 * POST body: { code: string, amount: number } — amount = subtotal + shipping + gst (before discount)
 */
router.post("/validate", async (req, res) => {
  try {
    const { code, amount } = req.body;
    const orderTotal = Number(amount);
    if (!code || typeof code !== "string" || !code.trim()) {
      return res.json({ valid: false, message: "Please enter a promo code", discountAmount: 0 });
    }
    if (orderTotal < 0 || isNaN(orderTotal)) {
      return res.json({ valid: false, message: "Invalid order amount", discountAmount: 0 });
    }

    const promo = await PromoCode.findOne({
      code: String(code).trim().toUpperCase(),
      active: true,
    });
    if (!promo) {
      return res.json({ valid: false, message: "Invalid or inactive promo code", discountAmount: 0 });
    }

    const now = new Date();
    if (promo.validFrom && new Date(promo.validFrom) > now) {
      return res.json({ valid: false, message: "This code is not yet valid", discountAmount: 0 });
    }
    if (promo.validUntil && new Date(promo.validUntil) < now) {
      return res.json({ valid: false, message: "This code has expired", discountAmount: 0 });
    }
    if (promo.minOrderAmount && orderTotal < promo.minOrderAmount) {
      return res.json({
        valid: false,
        message: `Minimum order amount is ₹${Number(promo.minOrderAmount).toFixed(2)}`,
        discountAmount: 0,
      });
    }
    if (promo.maxUses != null && (promo.usedCount || 0) >= promo.maxUses) {
      return res.json({ valid: false, message: "This code has reached its usage limit", discountAmount: 0 });
    }

    let discountAmount = 0;
    if (promo.type === "percent") {
      discountAmount = (orderTotal * Math.min(100, Math.max(0, promo.value))) / 100;
    } else {
      discountAmount = Math.min(Number(promo.value) || 0, orderTotal);
    }
    discountAmount = Math.round(discountAmount);

    return res.json({
      valid: true,
      code: promo.code,
      discountAmount,
      message: promo.type === "percent"
        ? `${promo.value}% off applied`
        : `₹${discountAmount} off applied`,
    });
  } catch (err) {
    console.error("Promo validate error:", err);
    res.status(500).json({ valid: false, message: "Could not validate code", discountAmount: 0 });
  }
});

module.exports = router;
