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
    const notebook = item.notebook || {};
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
      description: notebook.name || `Product ${i + 1}`,
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
function formatMoney(value) {
  return `₹${Number(value || 0).toFixed(2)}`;
}

async function buildInvoicePdf(order, invoiceNumber, invoiceData) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;
    const rightColX = left + 330;
    const cardGap = 14;
    const labelColor = "#64748b";
    const dark = "#0f172a";
    const border = "#cbd5e1";
    const headerBg = "#eff6ff";
    const accent = "#1d4ed8";
    const soft = "#f8fafc";
    const dateStr = order.createdAt
      ? new Date(order.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" })
      : "—";

    doc.roundedRect(left, 42, pageWidth, 92, 14).fill(headerBg);
    doc.fillColor(accent).font("Helvetica-Bold").fontSize(12).text("I JACK PAPER PRODUCTS", left + 18, 58);
    doc.fillColor(dark).font("Helvetica-Bold").fontSize(24).text("TAX INVOICE", left + 18, 76);
    doc.fillColor(labelColor).font("Helvetica").fontSize(10).text("GST-compliant invoice under CGST Act, 2017", left + 18, 106);
    doc.fillColor(dark).font("Helvetica-Bold").fontSize(12).text(invoiceNumber, left + pageWidth - 160, 62, {
      width: 142,
      align: "right",
    });
    doc.fillColor(labelColor).font("Helvetica").fontSize(10).text(`Invoice Date: ${dateStr}`, left + pageWidth - 160, 84, {
      width: 142,
      align: "right",
    });
    doc.text(`Order ID: ${order._id}`, left + pageWidth - 160, 100, {
      width: 142,
      align: "right",
    });

    const sectionTop = 156;
    const cardWidth = (pageWidth - cardGap) / 2;
    const cardHeight = 126;
    const supplierContentWidth = cardWidth - 32;
    doc.roundedRect(left, sectionTop, cardWidth, cardHeight, 10).fillAndStroke("#ffffff", border);
    doc.roundedRect(left + cardWidth + cardGap, sectionTop, cardWidth, cardHeight, 10).fillAndStroke("#ffffff", border);

    doc.fillColor(accent).font("Helvetica-Bold").fontSize(11).text("Supplier Details", left + 16, sectionTop + 14);
    doc.fillColor(dark).font("Helvetica-Bold").fontSize(10).text(SUPPLIER.name, left + 16, sectionTop + 32, {
      width: supplierContentWidth,
    });
    doc.fillColor("#334155").font("Helvetica").fontSize(9);
    SUPPLIER.address.forEach((line, index) => {
      doc.text(line, left + 16, sectionTop + 48 + index * 12, { width: supplierContentWidth });
    });
    doc.text(`Phone: ${SUPPLIER.phone}`, left + 16, sectionTop + 88, { width: supplierContentWidth });
    doc.text(`Email: ${SUPPLIER.email}`, left + 16, sectionTop + 100, { width: supplierContentWidth });
    doc.text(`GSTIN: ${SUPPLIER.gstin}`, left + 16, sectionTop + 112, { width: supplierContentWidth });

    doc.fillColor(accent).font("Helvetica-Bold").fontSize(11).text("Invoice Details", left + cardWidth + cardGap + 16, sectionTop + 14);
    const detailX = left + cardWidth + cardGap + 16;
    const valueX = detailX + 98;
    const valueWidth = cardWidth - 98 - 16;
    const orderIdStr = String(order._id);
    const orderIdDisplay = orderIdStr.length > 20 ? orderIdStr.slice(0, 20) + "…" : orderIdStr;
    const detailRows = [
      ["Invoice No", invoiceNumber],
      ["Invoice Date", dateStr],
      ["Order ID", orderIdDisplay],
      ["Place of Supply", String(invoiceData.placeOfSupply || "—").slice(0, 28)],
      ["Payment Mode", "Prepaid"],
    ];
    detailRows.forEach(([label, value], index) => {
      const y = sectionTop + 40 + index * 17;
      doc.fillColor(labelColor).font("Helvetica").fontSize(9).text(label, detailX, y, { width: 90 });
      doc.fillColor(dark).font("Helvetica-Bold").fontSize(9).text(value, valueX, y, {
        width: valueWidth,
      });
    });

    const billTop = sectionTop + cardHeight + 18;
    doc.roundedRect(left, billTop, pageWidth, 88, 10).fillAndStroke("#ffffff", border);
    doc.fillColor(accent).font("Helvetica-Bold").fontSize(11).text("Bill To", left + 16, billTop + 14);
    doc.fillColor(dark).font("Helvetica-Bold").fontSize(11).text(order.contactDetails.name, left + 16, billTop + 34);
    doc.fillColor("#334155").font("Helvetica").fontSize(9.5);
    doc.text(order.address.street, left + 16, billTop + 51, { width: 250 });
    doc.text(`${order.address.city}, ${order.address.state} – ${order.address.zipCode}`, left + 16, billTop + 65, {
      width: 250,
    });
    doc.text(order.contactDetails.phone, rightColX, billTop + 34, { width: 160 });
    doc.text(order.contactDetails.email, rightColX, billTop + 51, { width: 190 });

    const tableTop = billTop + 112;
    doc.fillColor(accent).font("Helvetica-Bold").fontSize(11).text("Product Details", left, tableTop - 20);
    // Column layout: x and width for each column so they fit in pageWidth and align correctly
    const tablePadding = 8;
    const totalTableContent = pageWidth - tablePadding * 2;
    const fixedColWidths = [24, 36, 24, 42, 46, 32, 46, 50]; // S.No, HSN, Qty, Rate, Taxable, GST%, GST Amt, Total
    const descWidth = totalTableContent - fixedColWidths.reduce((a, b) => a + b, 0) - 24; // 24 = S.No already
    const colWidths = [24, descWidth, ...fixedColWidths.slice(1)];
    const colAligns = ["left", "left", "left", "right", "right", "right", "right", "right", "right"];
    const cols = colWidths.map((w, i) => ({ x: 0, w, align: colAligns[i] }));
    let cx = left + tablePadding;
    cols.forEach((c, i) => {
      cols[i].x = cx;
      cx += c.w;
    });
    const headers = ["S.No", "Description", "HSN", "Qty", "Rate", "Taxable", "GST%", "GST Amt", "Total"];
    const rowHeight = 22;
    doc.roundedRect(left, tableTop, pageWidth, rowHeight, 6).fill(accent);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8.5);
    headers.forEach((h, i) => {
      const c = cols[i];
      doc.text(h, c.x, tableTop + 7, { width: c.w, align: c.align || "left" });
    });

    let rowY = tableTop + rowHeight;
    doc.font("Helvetica").fontSize(8.5);
    invoiceData.lines.forEach((row, index) => {
      doc.rect(left, rowY, pageWidth, rowHeight).fill(index % 2 === 0 ? soft : "#ffffff");
      doc.fillColor(dark);
      const cellY = rowY + 7;
      doc.text(String(row.sno), cols[0].x, cellY, { width: cols[0].w });
      doc.text(String(row.description || ""), cols[1].x, cellY, { width: cols[1].w - 4 });
      doc.text(String(row.hsn || ""), cols[2].x, cellY, { width: cols[2].w });
      doc.text(String(row.qty), cols[3].x, cellY, { width: cols[3].w, align: "right" });
      doc.text(formatMoney(row.rate), cols[4].x, cellY, { width: cols[4].w, align: "right" });
      doc.text(formatMoney(row.taxableValue), cols[5].x, cellY, { width: cols[5].w, align: "right" });
      doc.text(`${row.gstPct}%`, cols[6].x, cellY, { width: cols[6].w, align: "right" });
      doc.text(formatMoney(row.gstAmount), cols[7].x, cellY, { width: cols[7].w, align: "right" });
      doc.text(formatMoney(row.total), cols[8].x, cellY, { width: cols[8].w, align: "right" });
      rowY += rowHeight;
    });
    doc.roundedRect(left, tableTop, pageWidth, rowY - tableTop, 6).stroke(border);

    const summaryTop = rowY + 18;
    const leftBoxWidth = 240;
    const rightBoxWidth = pageWidth - leftBoxWidth - cardGap;
    doc.roundedRect(left, summaryTop, leftBoxWidth, 92, 10).fillAndStroke("#ffffff", border);
    doc.roundedRect(left + leftBoxWidth + cardGap, summaryTop, rightBoxWidth, 126, 10).fillAndStroke("#ffffff", border);

    doc.fillColor(accent).font("Helvetica-Bold").fontSize(11).text("Tax Summary", left + 16, summaryTop + 14);
    doc.fillColor("#334155").font("Helvetica").fontSize(10);
    doc.text(`CGST`, left + 16, summaryTop + 40);
    doc.text(formatMoney(invoiceData.cgst), left + 140, summaryTop + 40, { width: 70, align: "right" });
    doc.text(`SGST`, left + 16, summaryTop + 56);
    doc.text(formatMoney(invoiceData.sgst), left + 140, summaryTop + 56, { width: 70, align: "right" });
    doc.text(`IGST`, left + 16, summaryTop + 72);
    doc.text(formatMoney(invoiceData.igst), left + 140, summaryTop + 72, { width: 70, align: "right" });

    const totalsX = left + leftBoxWidth + cardGap + 16;
    doc.fillColor(accent).font("Helvetica-Bold").fontSize(11).text("Invoice Total", totalsX, summaryTop + 14);
    const totalRows = [
      ["Taxable Amount", formatMoney(invoiceData.subtotal)],
      ["Total GST", formatMoney(invoiceData.totalGst)],
      ["Shipping Charges", formatMoney(invoiceData.shippingCharge)],
    ];
    totalRows.forEach(([label, value], index) => {
      const y = summaryTop + 40 + index * 18;
      doc.fillColor(labelColor).font("Helvetica").fontSize(10).text(label, totalsX, y);
      doc.fillColor(dark).font("Helvetica-Bold").text(value, totalsX + 160, y, {
        width: rightBoxWidth - 40 - 160,
        align: "right",
      });
    });
    doc.moveTo(totalsX, summaryTop + 95).lineTo(left + pageWidth - 16, summaryTop + 95).strokeColor(border).stroke();
    doc.fillColor(accent).font("Helvetica-Bold").fontSize(12).text("Grand Total", totalsX, summaryTop + 104);
    doc.text(formatMoney(invoiceData.grandTotal), totalsX + 160, summaryTop + 104, {
      width: rightBoxWidth - 40 - 160,
      align: "right",
    });

    // Keep Declaration block (Amount in Words + Declaration footer) together on one page
    const wordsBoxHeight = 58;
    const wordsToFooterGap = 18;
    const footerBoxHeight = 96;
    const declarationBlockHeight = wordsBoxHeight + wordsToFooterGap + footerBoxHeight;
    const pageBottom = doc.page.height - doc.page.margins.bottom;
    let wordsTop;
    let footerTop;
    if (summaryTop + 142 + declarationBlockHeight > pageBottom) {
      doc.addPage({ size: "A4", margin: 50 });
      wordsTop = doc.page.margins.top;
      footerTop = wordsTop + wordsBoxHeight + wordsToFooterGap;
    } else {
      wordsTop = summaryTop + 142;
      footerTop = wordsTop + wordsBoxHeight + wordsToFooterGap;
    }

    doc.roundedRect(left, wordsTop, pageWidth, wordsBoxHeight, 10).fillAndStroke("#ffffff", border);
    doc.fillColor(accent).font("Helvetica-Bold").fontSize(11).text("Amount in Words", left + 16, wordsTop + 14);
    doc.fillColor(dark).font("Helvetica-Oblique").fontSize(10)
      .text(amountToWords(invoiceData.grandTotal), left + 16, wordsTop + 32, { width: pageWidth - 32 });

    doc.roundedRect(left, footerTop, pageWidth, footerBoxHeight, 10).fillAndStroke("#ffffff", border);
    doc.fillColor(accent).font("Helvetica-Bold").fontSize(11).text("Declaration", left + 16, footerTop + 14);
    doc.fillColor("#334155").font("Helvetica").fontSize(9.5).text(
      "We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.",
      left + 16,
      footerTop + 34,
      { width: 340 }
    );
    doc.fillColor(labelColor).font("Helvetica").fontSize(9).text("For I Jack Paper Products", left + pageWidth - 170, footerTop + 28, {
      width: 150,
      align: "right",
    });
    doc.moveTo(left + pageWidth - 165, footerTop + 62).lineTo(left + pageWidth - 20, footerTop + 62).strokeColor(border).stroke();
    doc.fillColor(dark).font("Helvetica-Bold").fontSize(9.5).text("Authorized Signatory", left + pageWidth - 170, footerTop + 68, {
      width: 150,
      align: "right",
    });

    doc.end();
  });
}

/**
 * Send invoice PDF to customer email via Resend
 */
async function sendInvoiceEmail(toEmail, customerName, invoiceNumber, pdfBuffer) {
  const apiKey = process.env.RESEND_API_KEY;
  const configuredFromEmail = process.env.INVOICE_FROM_EMAIL;
  const fromEmail =
    configuredFromEmail && !configuredFromEmail.toLowerCase().includes("gmail.com")
      ? configuredFromEmail
      : "I Jack Paper Products <onboarding@resend.dev>";

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
    replyTo: SUPPLIER.email,
    attachments: [
      {
        filename: `Invoice-${invoiceNumber}.pdf`,
        content: pdfBuffer.toString("base64"),
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

async function buildPdfForInvoiceRecord(invoice) {
  const { orderSnapshot, invoiceData } = invoice.invoiceSnapshot;
  return buildInvoicePdfFromSnapshot(
    orderSnapshot,
    invoice.invoiceNumber,
    invoiceData
  );
}

async function ensureInvoiceStored(invoice) {
  if (!invoice.pdfPath) {
    try {
      const pdfBuffer = await buildPdfForInvoiceRecord(invoice);
      const pdfPath = await uploadInvoiceToSupabase(
        pdfBuffer,
        `${invoice.invoiceNumber}.pdf`
      );
      invoice.pdfPath = pdfPath;
      invoice.lastStorageError = null;
      await invoice.save();
      return pdfPath;
    } catch (error) {
      invoice.lastStorageError = error.message || "Storage upload failed";
      await invoice.save();
      throw error;
    }
  }

  try {
    await getInvoiceSignedUrl(invoice.pdfPath);
    return invoice.pdfPath;
  } catch (error) {
    if (!/Object not found/i.test(error.message || "")) {
      throw error;
    }

    try {
      const pdfBuffer = await buildPdfForInvoiceRecord(invoice);
      const pdfPath = await uploadInvoiceToSupabase(
        pdfBuffer,
        `${invoice.invoiceNumber}.pdf`
      );
      invoice.pdfPath = pdfPath;
      invoice.lastStorageError = null;
      await invoice.save();
      return pdfPath;
    } catch (uploadError) {
      invoice.lastStorageError = uploadError.message || "Storage upload failed";
      await invoice.save();
      throw uploadError;
    }
  }
}

async function createInvoiceRecordForOrder(order) {
  const invoiceNumber = order.invoiceNumber || await getNextInvoiceNumber(order.createdAt);
  const invoiceData = await buildInvoiceData(order);
  const pdfBuffer = await buildInvoicePdf(order, invoiceNumber, invoiceData);

  const orderSnapshot = {
    _id: order._id,
    contactDetails: order.contactDetails,
    address: order.address,
    createdAt: order.createdAt,
  };

  const invoiceDoc = await Invoice.create({
    orderId: order._id,
    invoiceNumber,
    customerEmail: order.contactDetails.email,
    customerName: order.contactDetails.name,
    pdfPath: null,
    invoiceSnapshot: { orderSnapshot, invoiceData },
  });

  await Order.findByIdAndUpdate(order._id, { invoiceNumber });

  if (supabase) {
    try {
      const pdfPath = await uploadInvoiceToSupabase(
        pdfBuffer,
        `${invoiceNumber}.pdf`
      );
      await Invoice.findByIdAndUpdate(invoiceDoc._id, {
        pdfPath,
        lastStorageError: null,
      });
    } catch (err) {
      await Invoice.findByIdAndUpdate(invoiceDoc._id, {
        lastStorageError: err.message || "Upload failed",
      });
      console.error("Invoice: Supabase upload failed", err);
    }
  } else {
    await Invoice.findByIdAndUpdate(invoiceDoc._id, {
      lastStorageError: "Supabase not configured",
    });
  }

  return {
    invoiceDoc,
    pdfBuffer,
    invoiceNumber,
  };
}

async function ensureInvoiceRecordForOrder(orderId) {
  let existing = await Invoice.findOne({ orderId });
  if (existing) return existing;

  const order = await Order.findById(orderId).populate("items.notebook").lean();
  if (!order || order.payment.paymentStatus !== "SUCCESS") {
    return null;
  }

  const { invoiceDoc } = await createInvoiceRecordForOrder(order);
  existing = await Invoice.findById(invoiceDoc._id);
  return existing;
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

  const { invoiceDoc, pdfBuffer, invoiceNumber } = await createInvoiceRecordForOrder(order);

  try {
    await sendInvoiceEmail(
      order.contactDetails.email,
      order.contactDetails.name,
      invoiceNumber,
      pdfBuffer
    );
    await Invoice.findByIdAndUpdate(invoiceDoc._id, {
      lastEmailSentAt: new Date(),
      lastEmailError: null,
    });
  } catch (err) {
    await Invoice.findByIdAndUpdate(invoiceDoc._id, {
      lastEmailError: err.message || "Send failed",
    });
    console.error("Invoice email send failed:", err);
  }
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
  ensureInvoiceRecordForOrder,
  uploadInvoiceToSupabase,
  getInvoiceSignedUrl,
  ensureInvoiceStored,
};
