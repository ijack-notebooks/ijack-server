const PDFDocument = require("pdfkit");
const { Resend } = require("resend");
const Order = require("../models/Order");
const Category = require("../models/Category");
const InvoiceCounter = require("../models/InvoiceCounter");
const Invoice = require("../models/Invoice");
const supabase = require("../config/supabase");

const INVOICES_BUCKET = "Invoices";

// GST-compliant supplier details (I Jack Paper Products)
const SUPPLIER = {
  name: "I Jack Paper Products",
  address: ["39-22-45-1/2, Kalinganagar, Madhavadhara", "Near East Park, Visakhapatnam", "Andhra Pradesh – 530007, India"],
  phone: "7036732010",
  email: "notebookijack@gmail.com",
  gstin: "37ANUPA3588N1Z5",
  stateCode: "37",
  stateName: "Andhra Pradesh",
};

const HSN_DEFAULT = "4820"; // Notebooks, exercise books, registers

/**
 * Convert amount (number) to Indian Rupees and Paise in words
 */
function amountToWords(amount) {
  const whole = Math.floor(amount);
  const paise = Math.round((amount - whole) * 100);
  const words = numberToWords(whole);
  const rupees = whole === 1 ? "Rupee" : "Rupees";
  if (paise > 0) {
    const paiseWords = numberToWords(paise);
    const p = paise === 1 ? "Paise" : "Paise";
    return `${words} ${rupees} and ${paiseWords} ${p} Only.`;
  }
  return `${words} ${rupees} Only.`;
}

const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const teens = ["Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];

function numberToWords(n) {
  if (n === 0) return "Zero";
  if (n < 0) return "Minus " + numberToWords(-n);

  let s = "";
  if (n >= 10000000) {
    s += numberToWords(Math.floor(n / 10000000)) + " Crore ";
    n %= 10000000;
  }
  if (n >= 100000) {
    s += numberToWords(Math.floor(n / 100000)) + " Lakh ";
    n %= 100000;
  }
  if (n >= 1000) {
    s += numberToWords(Math.floor(n / 1000)) + " Thousand ";
    n %= 1000;
  }
  if (n >= 100) {
    s += ones[Math.floor(n / 100)] + " Hundred ";
    n %= 100;
  }
  if (n >= 20) {
    s += tens[Math.floor(n / 10)] + " ";
    n %= 10;
  } else if (n >= 10) {
    s += teens[n - 10] + " ";
    return s.trim();
  }
  if (n > 0) s += ones[n] + " ";
  return s.trim();
}

/**
 * Get next invoice number for the given date (INV-YYYYMM-NNNN), atomically
 */
async function getNextInvoiceNumber(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const monthId = `${y}${m}`;
  const doc = await InvoiceCounter.findByIdAndUpdate(
    monthId,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  const seq = String(doc.seq).padStart(4, "0");
  return `INV-${monthId}-${seq}`;
}

/**
 * Get category GST% and HSN by category name
 */
async function getCategoryTax(categoryName) {
  const cat = await Category.findOne({ name: categoryName }).lean();
  return {
    gstPercentage: cat ? Number(cat.gstPercentage) || 0 : 0,
    hsn: (cat && cat.hsn) ? String(cat.hsn) : HSN_DEFAULT,
  };
}

/**
 * Build invoice data (line items, totals, CGST/SGST/IGST) from order
 */
async function buildInvoiceData(order) {
  const categories = await Category.find({}).select("name gstPercentage hsn").lean();
  const taxByCategory = Object.fromEntries(
    categories.map((c) => [
      c.name,
      { gstPercentage: Number(c.gstPercentage) || 0, hsn: (c.hsn && String(c.hsn).trim()) || HSN_DEFAULT },
    ])
  );

  let subtotal = 0;
  let totalGst = 0;
  let totalWeightGrams = 0;
  const lines = [];

  for (let i = 0; i < order.items.length; i++) {
    const item = order.items[i];
    const notebook = item.notebook;
    const taxableValue = item.price * item.quantity;
    const taxInfo = taxByCategory[notebook.category] || { gstPercentage: 0, hsn: HSN_DEFAULT };
    const gstPct = taxInfo.gstPercentage;
    const gstAmount = (taxableValue * gstPct) / 100;
    const total = taxableValue + gstAmount;

    subtotal += taxableValue;
    totalGst += gstAmount;
    totalWeightGrams += (Number(notebook.weight) || 0) * item.quantity;

    lines.push({
      sno: i + 1,
      description: notebook.name,
      hsn: taxInfo.hsn,
      qty: item.quantity,
      rate: item.price,
      taxableValue,
      gstPct,
      gstAmount,
      total,
    });
  }

  const shippingCharge = Math.ceil(totalWeightGrams / 500) * 26;
  const grandTotal = Math.round(subtotal + totalGst + shippingCharge);

  const placeOfSupply = order.address.state || "";
  const isIntrastate = placeOfSupply.toLowerCase().includes("andhra");
  const cgst = isIntrastate ? totalGst / 2 : 0;
  const sgst = isIntrastate ? totalGst / 2 : 0;
  const igst = isIntrastate ? 0 : totalGst;

  return {
    lines,
    subtotal,
    totalGst,
    shippingCharge,
    grandTotal,
    cgst,
    sgst,
    igst,
    placeOfSupply: placeOfSupply || "—",
  };
}

/**
 * Generate GST-compliant invoice PDF and return buffer
 */
async function buildInvoicePdf(order, invoiceNumber, invoiceData) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const dateStr = order.createdAt
      ? new Date(order.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" })
      : "—";

    doc.fontSize(18).font("Helvetica-Bold").text("TAX INVOICE", { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(10).font("Helvetica");
    doc.font("Helvetica-Bold").text("Supplier Details", { continued: false });
    doc.font("Helvetica").text(SUPPLIER.name);
    SUPPLIER.address.forEach((line) => doc.text(line));
    doc.text(`Phone: ${SUPPLIER.phone}`);
    doc.text(`Email: ${SUPPLIER.email}`);
    doc.text(`GSTIN: ${SUPPLIER.gstin}`);
    doc.text(`State Code: ${SUPPLIER.stateCode}`);
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").text("Invoice Details", { continued: false });
    doc.font("Helvetica");
    doc.text(`Invoice No: ${invoiceNumber}`);
    doc.text(`Invoice Date: ${dateStr}`);
    doc.text(`Order ID: ${order._id}`);
    doc.text(`Place of Supply: ${invoiceData.placeOfSupply}`);
    doc.text("Payment Mode: Prepaid");
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").text("Bill To (Customer)", { continued: false });
    doc.font("Helvetica");
    doc.text(order.contactDetails.name);
    doc.text(order.address.street);
    doc.text(`${order.address.city}, ${order.address.state} – ${order.address.zipCode}`);
    doc.text(order.contactDetails.phone);
    doc.text(order.contactDetails.email);
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").text("Product Details", { continued: false });
    const tableTop = doc.y;
    const colWidths = { sno: 28, desc: 120, hsn: 38, qty: 28, rate: 42, taxable: 52, gstPct: 36, gstAmt: 42, total: 48 };
    const headers = ["S.No", "Product Description", "HSN", "Qty", "Rate (₹)", "Taxable (₹)", "GST %", "GST Amt", "Total (₹)"];
    doc.font("Helvetica-Bold").fontSize(8);
    let x = 50;
    doc.text(headers[0], x, tableTop); x += colWidths.sno;
    doc.text(headers[1], x, tableTop); x += colWidths.desc;
    doc.text(headers[2], x, tableTop); x += colWidths.hsn;
    doc.text(headers[3], x, tableTop); x += colWidths.qty;
    doc.text(headers[4], x, tableTop); x += colWidths.rate;
    doc.text(headers[5], x, tableTop); x += colWidths.taxable;
    doc.text(headers[6], x, tableTop); x += colWidths.gstPct;
    doc.text(headers[7], x, tableTop); x += colWidths.gstAmt;
    doc.text(headers[8], x, tableTop);
    doc.moveDown(0.3);
    let rowY = doc.y;
    doc.font("Helvetica").fontSize(8);
    invoiceData.lines.forEach((row) => {
      x = 50;
      doc.text(String(row.sno), x, rowY); x += colWidths.sno;
      doc.text(row.description.substring(0, 22), x, rowY); x += colWidths.desc;
      doc.text(row.hsn, x, rowY); x += colWidths.hsn;
      doc.text(String(row.qty), x, rowY); x += colWidths.qty;
      doc.text(row.rate.toFixed(2), x, rowY); x += colWidths.rate;
      doc.text(row.taxableValue.toFixed(2), x, rowY); x += colWidths.taxable;
      doc.text(row.gstPct + "%", x, rowY); x += colWidths.gstPct;
      doc.text(row.gstAmount.toFixed(2), x, rowY); x += colWidths.gstAmt;
      doc.text(row.total.toFixed(2), x, rowY);
      rowY += 18;
    });
    doc.y = rowY + 10;

    doc.font("Helvetica-Bold").text("Tax Summary", { continued: false });
    doc.font("Helvetica");
    doc.text(`CGST: ₹${invoiceData.cgst.toFixed(2)}`);
    doc.text(`SGST: ₹${invoiceData.sgst.toFixed(2)}`);
    doc.text(`IGST: ₹${invoiceData.igst.toFixed(2)}`);
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").text("Invoice Total", { continued: false });
    doc.font("Helvetica");
    doc.text(`Taxable Amount: ₹${invoiceData.subtotal.toFixed(2)}`);
    doc.text(`Total GST: ₹${invoiceData.totalGst.toFixed(2)}`);
    doc.text(`Shipping Charges: ₹${invoiceData.shippingCharge.toFixed(2)}`);
    doc.font("Helvetica-Bold").text(`Grand Total: ₹${invoiceData.grandTotal.toFixed(2)}`);
    doc.moveDown(0.5);

    doc.font("Helvetica").text("Amount in Words:", { continued: false });
    doc.font("Helvetica-Oblique").text(amountToWords(invoiceData.grandTotal), { width: 450 });
    doc.moveDown(0.5);

    doc.font("Helvetica").text(
      "We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.",
      { width: 500 }
    );
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").text("Authorized Signatory");
    doc.font("Helvetica").text("For I Jack Paper Products");

    doc.end();
  });
}

/**
 * Send invoice PDF to customer email via Resend
 */
async function sendInvoiceEmail(toEmail, customerName, invoiceNumber, pdfBuffer) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.INVOICE_FROM_EMAIL || "I Jack Paper Products <notebookijack@gmail.com>";

  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not set");
  }

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: fromEmail,
    to: [toEmail],
    subject: `Your Tax Invoice ${invoiceNumber} – I Jack Paper Products`,
    html: `
      <p>Dear ${customerName},</p>
      <p>Thank you for your order. Please find your GST Tax Invoice attached.</p>
      <p>Invoice No: <strong>${invoiceNumber}</strong></p>
      <p>If you have any questions, contact us at ${SUPPLIER.email} or ${SUPPLIER.phone}.</p>
      <p>— I Jack Paper Products</p>
    `,
    attachments: [
      {
        filename: `Invoice-${invoiceNumber}.pdf`,
        content: pdfBuffer,
      },
    ],
  });

  if (error) throw new Error(error.message);
}

/**
 * Upload PDF buffer to Supabase bucket "Invoices". Returns storage path.
 */
async function uploadInvoiceToSupabase(pdfBuffer, fileName) {
  if (!supabase) throw new Error("Supabase not configured");
  const path = fileName;
  const { error } = await supabase.storage
    .from(INVOICES_BUCKET)
    .upload(path, pdfBuffer, {
      contentType: "application/pdf",
      upsert: true,
    });
  if (error) throw error;
  return path;
}

/**
 * Build PDF from stored snapshot (for resend). Snapshot has orderSnapshot + invoiceData.
 */
async function buildInvoicePdfFromSnapshot(orderSnapshot, invoiceNumber, invoiceData) {
  const orderLike = {
    _id: orderSnapshot._id,
    contactDetails: orderSnapshot.contactDetails,
    address: orderSnapshot.address,
    createdAt: orderSnapshot.createdAt,
  };
  return buildInvoicePdf(orderLike, invoiceNumber, invoiceData);
}

/**
 * Generate invoice number, PDF, upload to Supabase, save Invoice in MongoDB, send email.
 */
async function generateAndSendInvoice(orderId) {
  const order = await Order.findById(orderId)
    .populate("items.notebook")
    .lean();

  if (!order) {
    console.error("Invoice: Order not found", orderId);
    return;
  }
  if (order.invoiceNumber) {
    return;
  }
  if (order.payment.paymentStatus !== "SUCCESS") {
    return;
  }

  const invoiceNumber = await getNextInvoiceNumber(order.createdAt);
  const invoiceData = await buildInvoiceData(order);
  const pdfBuffer = await buildInvoicePdf(order, invoiceNumber, invoiceData);

  const fileName = `${invoiceNumber}.pdf`;
  let pdfPath = fileName;
  if (supabase) {
    try {
      pdfPath = await uploadInvoiceToSupabase(pdfBuffer, fileName);
    } catch (err) {
      console.error("Invoice: Supabase upload failed", err);
    }
  }

  const orderSnapshot = {
    _id: order._id,
    contactDetails: order.contactDetails,
    address: order.address,
    createdAt: order.createdAt,
  };
  await Invoice.create({
    orderId: order._id,
    invoiceNumber,
    customerEmail: order.contactDetails.email,
    customerName: order.contactDetails.name,
    pdfPath,
    invoiceSnapshot: { orderSnapshot, invoiceData },
  });

  await Order.findByIdAndUpdate(orderId, { invoiceNumber });
  await sendInvoiceEmail(
    order.contactDetails.email,
    order.contactDetails.name,
    invoiceNumber,
    pdfBuffer
  );
}

/**
 * Get signed URL for invoice PDF (for admin view). Expires in 1 hour.
 */
async function getInvoiceSignedUrl(pdfPath) {
  if (!supabase) throw new Error("Supabase not configured");
  const { data, error } = await supabase.storage
    .from(INVOICES_BUCKET)
    .createSignedUrl(pdfPath, 3600);
  if (error) throw error;
  return data.signedUrl;
}

module.exports = {
  amountToWords,
  getNextInvoiceNumber,
  buildInvoiceData,
  buildInvoicePdf,
  buildInvoicePdfFromSnapshot,
  sendInvoiceEmail,
  generateAndSendInvoice,
  uploadInvoiceToSupabase,
  getInvoiceSignedUrl,
};
