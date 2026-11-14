import { currentBusiness } from "./state.js";

export const formatCurrency = (amount) => {
  return (
    "Rs. " +
    Number(amount || 0).toLocaleString("en-PK", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
};

export const padDatePart = (n) => String(n).padStart(2, "0");


// Formats qty together with its unit for invoices (e.g. "0.5 KG", "250 g", "3 Pack")
export const WEIGHTED_UNITS = ["kg", "kilo", "kilogram", "gram", "g", "liter", "litre", "l", "ml", "milliliter"];

export const isWeightedUnit = (unit) =>
  WEIGHTED_UNITS.includes(String(unit || "").trim().toLowerCase());

// Formats qty together with its unit for invoices (e.g. "0.5 KG", "250 g", "3 Pack")
export const formatQtyWithUnit = (qty, unit) => {
  const value = parseFloat(qty);
  const safeUnit = String(unit || "pcs").trim();
  if (!Number.isFinite(value)) return `0 ${safeUnit}`;
  const trimmed = Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/\.?0+$/, "");
  const unitLabel = safeUnit.toLowerCase() === "gram" ? "g" : safeUnit;
  return `${trimmed} ${unitLabel}`;
};

export const showToast = (message, type = "info") => {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `<i class="fa-solid fa-circle-info"></i> <span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
};

export const toggleLoader = (show, text = "Processing...") => {
  const loader = document.getElementById("global-loader");
  const loaderText = document.getElementById("loader-text");
  if (loaderText) loaderText.innerText = text;
  if (loader) {
    if (show) loader.classList.remove("hidden");
    else loader.classList.add("hidden");
  }
};

export const closeModal = () => {
  const modalContainer = document.getElementById("modal-container");
  if (modalContainer) modalContainer.classList.add("hidden");
};

export const showDeleteConfirmation = (message) =>
  new Promise((resolve) => {
    const modalContainer = document.getElementById("modal-container");
    const modalContent = document.getElementById("modal-content");
    if (!modalContainer || !modalContent) {
      resolve(false);
      return;
    }

    modalContent.innerHTML = `
      <div class="delete-confirm-modal">
        <div class="delete-confirm-icon"><i class="fa-solid fa-trash-can"></i></div>
        <h3>Delete Record?</h3>
        <p>${message}</p>
        <div class="delete-confirm-actions">
          <button type="button" class="btn btn-secondary" id="delete-confirm-cancel">Cancel</button>
          <button type="button" class="btn btn-danger" id="delete-confirm-approve"><i class="fa-solid fa-trash-can"></i> Delete</button>
        </div>
      </div>
    `;
    modalContainer.classList.remove("hidden");

    const finish = (confirmed) => {
      window.closeModal();
      resolve(confirmed);
    };
    document.getElementById("delete-confirm-cancel")?.addEventListener("click", () => finish(false));
    document.getElementById("delete-confirm-approve")?.addEventListener("click", () => finish(true));
  });

export const normalizeToStandardUnit = (qty, unit) => {
  const parsedQty = parseFloat(qty) || 0;
  if (unit === "Gram") return parsedQty / 1000;
  return parsedQty;
};

export const splitNameByScript = (name) => {
  const latin = [];
  const urdu = [];
  let currentScript = null;
  let buffer = "";
  const flush = () => {
    const cleaned = buffer.replace(/^[\s\-–—|]+|[\s\-–—|]+$/g, "");
    if (cleaned) (currentScript === "urdu" ? urdu : latin).push(cleaned);
    buffer = "";
  };
  for (const ch of String(name || "")) {
    if (/[\u0600-\u06FF]/.test(ch)) {
      if (currentScript !== "urdu") { flush(); currentScript = "urdu"; }
      buffer += ch;
    } else if (/[A-Za-z0-9.]/.test(ch)) {
      if (currentScript !== "latin") { flush(); currentScript = "latin"; }
      buffer += ch;
    } else {
      buffer += ch; // spaces, brackets, dashes stay attached to the current run
    }
  }
  flush();
  return { latin: latin.join(" "), urdu: urdu.join(" ") };
};

export const readLogoFile = (file) =>
  new Promise((resolve, reject) => {
    if (!file) return resolve("");
    if (file.size > 5 * 1024 * 1024) {
      reject(new Error("Logo must be smaller than 5 MB."));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const maxWidth = 600;
        const maxHeight = 240;
        const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      image.onerror = () => reject(new Error("Unable to process the logo file."));
      image.src = reader.result;
    };
    reader.onerror = () => reject(new Error("Unable to read the logo file."));
    reader.readAsDataURL(file);
  });

export const populatePrintWindowContent = (
  printWindow,
  saleData,
  format = "thermal",
  autoPrint = true,
) => {
  if (!printWindow) return;

  const logoSize = Math.min(250, Math.max(50, Number(currentBusiness?.logoSize) || 100));
  const logoSizeRatio = logoSize / 100;

  const logoContent = currentBusiness?.logoDataUrl
    ? `<img src="${currentBusiness.logoDataUrl}" alt="Shop logo">`
    : `<h1>${currentBusiness?.shopName || "PAKPOS"}</h1>`;
  const invoiceAddressContent = currentBusiness?.showAddressOnInvoice !== false && currentBusiness?.address
    ? `<div class="invoice-address">Address: ${currentBusiness.address}</div>`
    : "";

  const subtotalForCalc = saleData.subtotal || 0;

  const itemsHtmlSimple = saleData.items
    .map((item, idx) => {
      return `
      <tr>
        <td style="padding:6px 8px;">${idx + 1}</td>
        <td style="padding:6px 8px;">${/[\u0600-\u06FF]/.test(String(item.name || "")) ? `<span class="urdu-text" style="font-size:13px;">${item.name}</span>` : item.name}</td>
        <td style="padding:6px 8px; text-align:right;">${formatCurrency(item.sellingPrice)}<div style="font-size:10px;color:#64748b;">per ${item.unit || "pcs"}</div></td>
        <td style="padding:6px 8px; text-align:center;">${formatQtyWithUnit(item.qty, item.unit)}</td>
        <td style="padding:6px 8px; text-align:center;">${subtotalForCalc ? (((item.lineTotal || 0) / subtotalForCalc) * (saleData.taxAmount || 0)).toFixed(2) : "0.00"}</td>
        <td style="padding:6px 8px; text-align:right;">${formatCurrency(item.lineTotal)}</td>
      </tr>
    `;
    })
    .join("");

  // Use the same styled template for A5 and A4, but adjust page size and max-width
  if (format === "A5" || format === "A4") {
    const pageSize = format === "A4" ? "A4" : "A5";
    const pageCss = `@page { size: ${pageSize} portrait; margin: 10mm; }`;

    const containerMaxWidth = format === "A4" ? "180mm" : "148mm";
    const titleSize = format === "A4" ? "36px" : "32px";
    const shopFontSize = format === "A4" ? "22px" : "20px";

    const html = `
      <html>
        <head>
          <title>Invoice - ${saleData.invoiceNumber}</title>
          <meta charset="utf-8">
          <link rel="preconnect" href="https://fonts.googleapis.com">
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Gulzar&family=Noto+Nastaliq+Urdu:wght@400;700&display=swap" rel="stylesheet">
          <style>
            ${pageCss}
            body { font-family: 'Inter', 'Noto Nastaliq Urdu', sans-serif; color:#17212b; margin:0; padding:18px; display:flex; justify-content:center; background:#f3f6f8; }
            .urdu-text { font-family: 'Gulzar', 'Noto Nastaliq Urdu', serif; direction: rtl; line-height: 2.1; font-size: 13px; }
            .invoice-wrap { width:100%; max-width:${containerMaxWidth}; border-top:5px solid #0f766e; padding:28px; background:#fff; box-sizing:border-box; box-shadow:0 8px 24px rgba(15,23,42,.08); }
            .inv-header { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; padding-bottom:22px; border-bottom:1px solid #dbe4e8; }
            .inv-title { flex:1; order:1; text-align:left; }
            .inv-title h1 { margin:0 0 8px; font-size:${shopFontSize}; letter-spacing:.2px; color:#0f766e; }
            .inv-title img { display:block; width:auto; max-width:min(${150 * logoSizeRatio}px, 100%); max-height:${58 * logoSizeRatio}px; margin:0 0 8px; object-fit:contain; object-position:left center; }
            .inv-title h4 { margin:0 0 8px; font-size:${titleSize}; line-height:1; font-weight:800; letter-spacing:1px; color:#17212b; }
            .inv-title span { color:#64748b; font-size:12px; }
            .inv-meta { order:3; flex:1; text-align:right; font-size:12px; line-height:1.8; color:#64748b; }
            .inv-number { font-weight:700; color:#17212b; }
            .boxes { display:flex; gap:12px; margin-top:20px; }
            .box { flex:1; padding:14px; border:1px solid #dbe4e8; border-radius:6px; background:#f8fafb; }
            .box h4{ margin:0 0 7px; font-size:10px; letter-spacing:1px; color:#0f766e; }
            .box p{ margin:2px 0; font-size:12px; }
            table.inv-items { width:100%; border-collapse:collapse; margin-top:22px; }
            table.inv-items thead th { background:#0f766e; color:#fff; padding:10px; text-align:left; font-size:11px; }
            table.inv-items thead th:first-child { border-radius:4px 0 0 4px; }
            table.inv-items thead th:last-child { border-radius:0 4px 4px 0; }
            table.inv-items tbody td { border-bottom:1px solid #e8eef0; padding:10px; font-size:12px; }
            .totals { width:100%; display:flex; justify-content:flex-end; margin-top:20px; }
            .totals .right { width:300px; }
            .totals .right .row { display:flex; justify-content:space-between; padding:5px 0; font-size:12px; }
            .totals .right .grand { margin-top:6px; padding:12px 10px; border-radius:5px; background:#e6f4f2; color:#0f766e; font-weight:800; font-size:17px; }
            .payment { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin-top:24px; padding-top:16px; border-top:1px solid #dbe4e8; font-size:12px; }
            .signature { flex:1; color:#64748b; }
            .signature strong { color:#17212b; }
            .signature .sig-line { border-top:1px dashed #aab8bf; width:180px; margin-top:24px; }
            .payment .methods { text-align:right; line-height:1.8; }
            .inv-footer { text-align:center; margin-top:24px; font-size:11px; color:#64748b; border-top:1px solid #dbe4e8; padding-top:12px; }
            .invoice-address { font-size:13px; font-weight:600; margin-bottom:4px; }
            @media print { body { background:#fff; padding:0; } .invoice-wrap { box-shadow:none; } }
          </style>
        </head>
        <body>
          <div class="invoice-wrap">
            <div class="inv-header">
              <div class="inv-title">
                ${logoContent}
                <h2>INVOICE</h2>
                <span>Thank you for your business</span>
              </div>
              <div class="inv-meta">
                <div>Invoice # <span class="inv-number">${saleData.invoiceNumber}</span></div>
                <div>${new Date().toLocaleDateString()}</div>
              </div>
            </div>

            <div class="boxes">
              <div class="box">
                <h4>BILLED TO</h4>
                <p><strong>${saleData.customerName}</strong></p>
                <p>Phone: ${saleData.customerPhone ? saleData.customerPhone : "N/A"}</p>
              </div>
              <div class="box">
                <h4>FROM</h4>
                <p>${currentBusiness?.shopName || ""}</p>
                <p>Phone: ${currentBusiness?.phone || ""}</p>
                <p>Usage: Sale ${saleData.invoiceNumber}</p>
              </div>
            </div>

            <table class="inv-items">
              <thead>
                <tr>
                  <th style="width:40px;">No</th>
                  <th>Description</th>
                  <th style="width:110px; text-align:right;">Price</th>
                  <th style="width:70px; text-align:center;">Qty</th>
                  <th style="width:90px; text-align:center;">GST</th>
                  <th style="width:110px; text-align:right;">Amount</th>
                </tr>
              </thead>
              <tbody>
                ${itemsHtmlSimple}
              </tbody>
            </table>

            <div class="totals">
              <div class="right">
                <div class="row"><div>Subtotal</div><div>${formatCurrency(saleData.subtotal)}</div></div>
                ${saleData.discount > 0 ? `<div class="row"><div>Discount</div><div>-${formatCurrency(saleData.discount)}</div></div>` : ""}
                <div class="row"><div>GST</div><div>${formatCurrency(saleData.taxAmount || 0)}</div></div>
                <div class="row grand"><div>Total</div><div>${formatCurrency(saleData.grandTotal)}</div></div>
              </div>
            </div>

            <div class="payment">
              <div class="signature">
                <div>Payment Method: <strong>${saleData.paymentMethod || "Cash"}</strong></div>
                <div class="sig-line"></div>
                <div style="font-size:12px; color:#7a7a7a;">Signature</div>
              </div>
              <div class="methods">
                <div><strong>Paid:</strong> ${formatCurrency(saleData.paidAmount)}</div>
                <div><strong>Balance:</strong> ${formatCurrency(saleData.balanceDue)}</div>
              </div>
            </div>

            <div class="inv-footer">
              ${currentBusiness?.showAddressOnInvoice !== false && currentBusiness?.address ? `<div class="invoice-address">${currentBusiness.address}</div>` : ""}
              <div>Phone: ${currentBusiness?.phone || ""}</div>
              <div class="urdu-text" dir="auto">${currentBusiness?.invoiceFooter || ""}</div>
            </div>
          </div>
          <script>${autoPrint ? "window.onload = () => { setTimeout(() => { window.print(); }, 200); };" : ""}</script>
        </body>
      </html>
    `;

    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    return;
  }

  // Fallback: use existing generic template for thermal/A4
  const itemsHtml = saleData.items
    .map(
      (item) => `
    <tr>
      <td style="width:70%;">${item.name} (${formatQtyWithUnit(item.qty, item.unit)})</td>
      <td style="text-align: right; width:30%;">${formatCurrency(item.lineTotal)}</td>
    </tr>
  `,
    )
    .join("");

  // Choose CSS based on requested format
  let pageCss = "";
  let bodyStyle = "";
  if (format === "A4") {
    pageCss = "@page { size: A4 portrait; margin: 10mm; }";
    bodyStyle = "width:210mm; font-family: Arial, sans-serif; font-size:12px;";
  } else {
    // thermal
    pageCss = "@page { size: 80mm auto; margin: 3mm; }";
    bodyStyle = "width:80mm; font-family: monospace; font-size:11px;";
  }

  printWindow.document.open();
  printWindow.document.write(`
    <html>
      <head>
        <title>Receipt - ${saleData.invoiceNumber}</title>
        <meta charset="utf-8">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Gulzar&family=Noto+Nastaliq+Urdu:wght@400;700&display=swap" rel="stylesheet">
        <style>
          ${pageCss}
          body {
            ${bodyStyle}
            margin: 0;
            padding: 0;
            background: #fff;
            color: #111;
            font-family: Arial, Helvetica, sans-serif;
            line-height: 1.35;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .receipt-box {
            width: 80mm;
            max-width: 80mm;
            min-width: 80mm;
            background: #fff;
            box-sizing: border-box;
            padding: 8px 8px 10px;
            border: none;
          }
          .center { text-align: center; }
          .shop-logo {
            display: block;
            width: auto;
            max-width: min(${58 * logoSizeRatio}mm, 100%);
            max-height: ${24 * logoSizeRatio}mm;
            margin: 0 auto 5px;
            object-fit: contain;
          }
          .shop-name {
            font-size: 20px;
            font-weight: 800;
            letter-spacing: 0.2px;
            margin: 0;
            color: #111;
          }
          .phone {
            font-size: 17px;
            font-weight: 700;
            line-height: 1.2;
            margin-top: 2px;
            color: #111;
          }
          .invoice-address {
            font-size: 13px;
            font-weight: 700;
            line-height: 1.3;
            margin-top: 4px;
          }
          .rule {
            border-top: 1.5px dashed #111;
            margin: 8px 0 7px;
          }
          .invoice-meta {
            font-size: 12px;
            font-weight: 700;
            line-height: 1.5;
            margin: 0;
          }
          .time-line {
            font-size: 11px;
            font-weight: 700;
            line-height: 1.5;
            margin: 2px 0 0;
          }
          .customer-line {
            font-size: 12px;
            font-weight: 700;
            line-height: 1.5;
            margin: 0;
          }
          .items {
            width: 100%;
            border-collapse: collapse;
            margin-top: 8px;
          }
          .items td {
            padding: 7px 2px;
            font-size: 17px;
            vertical-align: top;
            color: #111;
          }
          .items tr {
            border-bottom: 1px solid #111;
          }
          .item-name {
            width: 70%;
            text-align: left;
            font-weight: 700;
            padding-right: 4px;
          }
          .item-name.urdu {
            font-family: 'Gulzar', 'Noto Nastaliq Urdu', serif;
            direction: rtl;
            unicode-bidi: plaintext;
            text-align: left;
            font-size: 17px;
            line-height: 1.8;
            font-weight: 800;
            letter-spacing: 0;
            padding: 9px 2px 1px;
          }
          tr.item-row-mix, tr.item-row-urdu-amount { border-bottom: none; }
          tr.item-row-end { border-bottom: 1px solid #111; }
          tr.item-row-urdu-amount td { padding-top: 0; padding-bottom: 7px; }
          .item-amount {
            width: 30%;
            text-align: right;
            font-weight: 700;
            font-size: 17px;
          }
          .totals {
            width: 100%;
            margin-top: 10px;
            font-size: 16px;
            font-weight: 800;
          }
          .totals-row {
            display: flex;
            justify-content: space-between;
            gap: 10px;
            padding: 6px 2px;
            border-bottom: 1px dashed #111;
          }
          .totals-row.grand {
            border-top: 2px solid #111;
            border-bottom: 2px solid #111;
            padding-top: 8px;
            margin-top: 4px;
            font-weight: 900;
            font-size: 17px;
          }
          .footer {
            margin-top: 12px;
            font-size: 11px;
            text-align: center;
            font-weight: 700;
            font-style: italic;
          }
          .urdu-text {
            font-family: 'Gulzar', 'Noto Nastaliq Urdu', serif;
            direction: rtl;
            font-size: 12px;
            margin-top: 8px;
            line-height: 1.9;
          }
        </style>
      </head>
      <body>
        <div class="receipt-box">
          <div class="center">
            ${currentBusiness?.logoDataUrl ? `<img class="shop-logo" src="${currentBusiness.logoDataUrl}" alt="Shop logo">` : ""}
            <div class="shop-name">${currentBusiness?.shopName || "BASIT K/S"}</div>
            <div class="phone">Phone: ${currentBusiness?.phone || "03xxxxxxxxx"}</div>
            ${invoiceAddressContent}
          </div>

          <div class="rule"></div>

          <p class="invoice-meta">Invoice: <span>${saleData.invoiceNumber}</span></p>
          <p class="time-line">Date &amp; Time: <span>${new Date(saleData.createdAt || Date.now()).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span></p>
          <p class="customer-line">Customer: <span>${saleData.customerName || "Walk-in Customer"}</span></p>

          <div class="rule"></div>

          <table class="items">
            ${saleData.items.map((item) => {
              const amountCell = `<td class="item-amount">Rs. ${Number(item.lineTotal || 0).toFixed(2)}</td>`;
              const isWeighted = isWeightedUnit(item.unit);
              const rawQty = parseFloat(item.qty);
              const qtyLabel = isWeighted || !Number.isInteger(rawQty) || rawQty > 1
                ? `(${formatQtyWithUnit(item.qty, item.unit)})`
                : "";
              const { latin, urdu } = splitNameByScript(item.name);

              // Pure English / numeric name -> single line (unchanged)
              if (!urdu) {
                return `
                  <tr>
                    <td class="item-name">${item.name} ${qtyLabel}</td>
                    ${amountCell}
                  </tr>
                `;
              }

              // Pure Urdu name -> name line, then amount line
              if (!latin) {
                return `
                  <tr>
                    <td colspan="2" class="item-name urdu">${item.name} ${qtyLabel}</td>
                  </tr>
                  <tr class="item-row-urdu-amount item-row-end">
                    <td></td>
                    ${amountCell}
                  </tr>
                `;
              }

              // Mixed name -> English on line 1 (with amount), Urdu on line 2
              return `
                <tr class="item-row-mix">
                  <td class="item-name">${latin} ${qtyLabel}</td>
                  ${amountCell}
                </tr>
                <tr class="item-row-end">
                  <td colspan="2" class="item-name urdu">${urdu}</td>
                </tr>
              `;
            }).join("")}
          </table>

          <div class="totals">
            <div class="totals-row">
              <span>Subtotal:</span>
              <span>Rs. ${Number(saleData.subtotal || 0).toFixed(2)}</span>
            </div>
            ${saleData.discount > 0 ? `
            <div class="totals-row">
              <span>Discount:</span>
              <span>-Rs. ${Number(saleData.discount || 0).toFixed(2)}</span>
            </div>
            ` : ""}
            ${saleData.taxAmount > 0 ? `
            <div class="totals-row">
              <span>Tax/GST:</span>
              <span>Rs. ${Number(saleData.taxAmount || 0).toFixed(2)}</span>
            </div>
            ` : ""}
            <div class="totals-row grand">
              <span>Grand Total:</span>
              <span>Rs. ${Number(saleData.grandTotal || 0).toFixed(2)}</span>
            </div>
            <div class="totals-row">
              <span>Paid:</span>
              <span>Rs. ${Number(saleData.paidAmount || 0).toFixed(2)}</span>
            </div>
            <div class="totals-row">
              <span>Balance:</span>
              <span>Rs. ${Number(saleData.balanceDue || 0).toFixed(2)}</span>
            </div>
          </div>

          <div class="footer">Thanks for Shopping</div>
          <div class="urdu-text center">${currentBusiness?.invoiceFooter || "آپ کا شکریہ"}</div>
        </div>
        <script>${autoPrint ? "window.onload = () => { setTimeout(() => { window.print(); }, 200); };" : ""}</script>
      </body>
    </html>
  `);
  printWindow.document.close();
};

export const populateReturnPrintWindowContent = (
  printWindow,
  returnData,
  format = "thermal",
  autoPrint = true,
) => {
  if (!printWindow) return;

  const itemsHtml = (returnData.items || [])
    .map((item, index) => {
      const qty = Number(item.qty ?? item.normalizedQty ?? 0);
      const lineTotal = Number(item.lineTotal ?? (qty * (item.sellingPrice || 0)) ?? 0);
      return `
        <tr>
          <td style="padding:6px 4px;">${index + 1}</td>
          <td style="padding:6px 4px;">${item.name}</td>
          <td style="padding:6px 4px; text-align:center;">${qty} ${item.unit || "pcs"}</td>
          <td style="padding:6px 4px; text-align:right;">${formatCurrency(lineTotal)}</td>
        </tr>
      `;
    })
    .join("");

  const pageCss =
    format === "A4"
      ? "@page { size: A4 portrait; margin: 8mm; }"
      : format === "A5"
        ? "@page { size: A5 portrait; margin: 8mm; }"
        : "@page { size: 80mm auto; margin: 3mm; }";

  const bodyStyle =
    format === "A4" || format === "A5"
      ? "width:100%; max-width: 180mm; font-family: Arial, sans-serif; font-size:12px;"
      : "width:80mm; font-family: monospace; font-size:11px;";

  printWindow.document.open();
  printWindow.document.write(`
    <html>
      <head>
        <title>Return Slip - ${returnData.invoiceNumber}</title>
        <meta charset="utf-8">
        <style>
          ${pageCss}
          body { ${bodyStyle} color:#17212b; padding:8px; }
          h2, p { text-align: center; margin:4px 0; }
          h2 { color:#dc2626; font-size:20px; }
          .header { border-bottom:1px dashed #94a3b8; padding-bottom:8px; margin-bottom:8px; }
          table { width:100%; border-collapse:collapse; margin-top:10px; }
          td { padding:5px 0; border-bottom:1px solid #e2e8f0; vertical-align:top; }
          .totals { margin-top:10px; border-top:1px solid #0f172a; padding-top:8px; }
          .row { display:flex; justify-content:space-between; margin:4px 0; }
          .grand { font-weight:bold; font-size:13px; color:#dc2626; }
          .rule { color:#94a3b8; }
        </style>
      </head>
      <body>
        <div class="header">
          <h2>RETURN SLIP</h2>
          <p>${currentBusiness?.shopName || "PakPOS Store"}</p>
          <p>Invoice: ${returnData.invoiceNumber}</p>
          <p>Customer: ${returnData.customerName || "Walk-in Customer"}</p>
        </div>

        <div class="rule">--------------------------------</div>
        <table>
          <thead>
            <tr>
              <th style="text-align:left;">#</th>
              <th style="text-align:left;">Item</th>
              <th style="text-align:center;">Qty</th>
              <th style="text-align:right;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
        </table>
        <div class="totals">
          <div class="row"><span>Return Total</span><span>${formatCurrency(returnData.returnTotal || returnData.grandTotal || 0)}</span></div>
          <div class="row grand"><span>Refund</span><span>${formatCurrency(returnData.returnTotal || returnData.grandTotal || 0)}</span></div>
        </div>
        <p style="margin-top:12px;">Thank you for shopping with us.</p>
        <p>Restocked automatically to inventory.</p>
        <script>
          ${autoPrint ? "window.onload = () => { setTimeout(() => { window.print(); }, 200); };" : ""}
        <\/script>
      </body>
    </html>
  `);
  printWindow.document.close();
};

export const printReceivedPayment = ({ cust, amount, fromDate, toDate, note }) => {
  const printWindow = window.open("", "_blank", "width=420,height=600");
  if (!printWindow) return;
  printWindow.document.write(`
    <html><head><title>Udhaar Payment Receipt</title>
    <style>body{font-family:Arial,sans-serif;padding:24px;color:#111}h2{text-align:center}table{width:100%;border-collapse:collapse;margin-top:20px}td{padding:10px;border-bottom:1px solid #ddd}td:last-child{text-align:right;font-weight:bold}.total{font-size:20px}</style>
    </head><body onload="window.print()">
      <h2>Udhaar Payment Receipt</h2>
      <p style="text-align:center">${currentBusiness?.shopName || "PakPOS Store"}</p>
      <table>
        <tr><td>Customer</td><td>${cust.name}</td></tr>
        <tr><td>Payment From</td><td>${fromDate}</td></tr>
        <tr><td>Payment To</td><td>${toDate}</td></tr>
        <tr class="total"><td>Received Amount</td><td>${formatCurrency(amount)}</td></tr>
        ${note ? `<tr><td>Note / Details</td><td>${note}</td></tr>` : ""}
      </table>
      <p style="text-align:center;margin-top:30px">Payment received successfully.</p>
    </body></html>
  `);
  printWindow.document.close();
};
window.closeModal = closeModal;

export const saveInvoicePdf = async (printWindow, saleData, format) => {
  const ipcRenderer = window.require?.("electron")?.ipcRenderer;
  if (!ipcRenderer) {
    printWindow.print();
    showToast("Use your system print dialog to save the invoice as PDF.", "info");
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    const result = await ipcRenderer.invoke("save-invoice-pdf", {
      html: printWindow.document.documentElement.outerHTML,
      invoiceNumber: saleData.invoiceNumber,
      format,
    });
    if (result?.canceled) showToast("PDF save canceled.", "info");
    else showToast("Invoice PDF saved locally.", "success");
  } catch (error) {
    showToast(`Unable to save PDF: ${error.message}`, "error");
  } finally {
    if (!printWindow.closed) printWindow.close();
  }
};

