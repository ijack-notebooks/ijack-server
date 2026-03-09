const mongoose = require("mongoose");

// Atomic counter for invoice numbers per month (INV-YYYYMM-NNNN)
const InvoiceCounterSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // "YYYYMM"
  seq: { type: Number, required: true, default: 0 },
});

module.exports = mongoose.model("InvoiceCounter", InvoiceCounterSchema);
