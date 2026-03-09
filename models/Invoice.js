const mongoose = require("mongoose");

const InvoiceSchema = new mongoose.Schema({
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Order",
    required: true,
  },
  invoiceNumber: {
    type: String,
    required: true,
    unique: true,
  },
  customerEmail: {
    type: String,
    required: true,
  },
  customerName: {
    type: String,
    required: true,
  },
  /** Path in Supabase bucket "Invoices" (e.g. INV-202603-0001.pdf) */
  pdfPath: {
    type: String,
    default: null,
  },
  /**
   * Snapshot to regenerate PDF: { orderSnapshot: { contactDetails, address, createdAt, _id }, invoiceData: { lines, subtotal, ... } }
   */
  invoiceSnapshot: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  /** Set when invoice email was last sent successfully */
  lastEmailSentAt: { type: Date },
  /** Set when last send attempt failed */
  lastEmailError: { type: String },
  /** Set when invoice PDF could not be uploaded to Supabase */
  lastStorageError: { type: String },
});

module.exports = mongoose.model("Invoice", InvoiceSchema);
