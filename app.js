import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  initializeAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  doc,
  setDoc,
  getDoc,
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// ==========================================================================
// 1. FIREBASE CONFIGURATION & INITIALIZATION
// ==========================================================================
const firebaseConfig = {
  apiKey: "AIzaSyCk1M2mLQDyT2DoJuGOogjZYKOcGnendsU",
  authDomain: "pos-by-basit.firebaseapp.com",
  projectId: "pos-by-basit",
  storageBucket: "pos-by-basit.firebasestorage.app",
  messagingSenderId: "565421098587",
  appId: "1:565421098587:web:0bc1d69f52f3bab647217e",
  measurementId: "G-QH75X9ZVCL",
};

const app = initializeApp(firebaseConfig);
const auth = initializeAuth(app, {
  persistence: browserLocalPersistence,
});
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentSingleTabManager(),
  }),
});

// ==========================================================================
// 2. GLOBAL STATE MANAGEMENT
// ==========================================================================
let currentUser = null;
let currentBusiness = null;
let businessId = null;

let state = {
  products: [],
  categories: [
    "Grocery",
    "Beverages",
    "Dairy",
    "Bakery",
    "Snacks",
    "Household",
  ],
  customers: [],
  suppliers: [],
  sales: [],
  purchases: [],
  expenses: [],
  udhaarPayments: [],
  cart: [],
  selectedCategory: "ALL",
  posSearchQuery: "",
};

let salesChartInstance = null;
let topProductsChartInstance = null;
let pendingListenerCount = 0;
let queuedOperationCount = 0;
let syncingOutbox = false;

const OUTBOX_DB_NAME = "pos-by-basit-outbox";
const OUTBOX_STORE_NAME = "operations";

const openOutbox = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(OUTBOX_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(OUTBOX_STORE_NAME, { keyPath: "opId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const readOutbox = async () => {
  const database = await openOutbox();
  return new Promise((resolve, reject) => {
    const request = database
      .transaction(OUTBOX_STORE_NAME, "readonly")
      .objectStore(OUTBOX_STORE_NAME)
      .getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
};

const writeOutboxOperation = async (operation) => {
  const database = await openOutbox();
  return new Promise((resolve, reject) => {
    const request = database
      .transaction(OUTBOX_STORE_NAME, "readwrite")
      .objectStore(OUTBOX_STORE_NAME)
      .put(operation);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

const removeOutboxOperation = async (opId) => {
  const database = await openOutbox();
  return new Promise((resolve, reject) => {
    const request = database
      .transaction(OUTBOX_STORE_NAME, "readwrite")
      .objectStore(OUTBOX_STORE_NAME)
      .delete(opId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

const refreshOutboxStatus = async () => {
  try {
    const operations = await readOutbox();
    queuedOperationCount = operations.filter((operation) => operation.status !== "synced").length;
  } catch (err) {
    queuedOperationCount = 0;
  }
  updateConnectionStatus();
};

const updateConnectionStatus = () => {
  const status = document.getElementById("connection-status");
  if (!status) return;

  const isOnline = navigator.onLine;
  status.className = `connection-status ${isOnline ? (pendingListenerCount || syncingOutbox ? "syncing" : "online") : "offline"}`;
  status.innerHTML = isOnline
    ? pendingListenerCount || syncingOutbox
      ? `<i class="fa-solid fa-arrows-rotate"></i> Syncing${queuedOperationCount ? ` (${queuedOperationCount})` : ""}...`
      : '<i class="fa-solid fa-cloud"></i> Online'
    : `<i class="fa-solid fa-cloud-arrow-down"></i> Offline - Saved locally${queuedOperationCount ? ` (${queuedOperationCount})` : ""}`;
};

window.addEventListener("online", updateConnectionStatus);
window.addEventListener("online", () => syncOutbox());
window.addEventListener("offline", updateConnectionStatus);
updateConnectionStatus();
refreshOutboxStatus();

// ==========================================================================
// 3. UTILITY FUNCTIONS & MODAL HANDLERS
// ==========================================================================
const subscribeToQuery = (queryRef, onData, onError) => {
  let hasPendingWrites = false;

  return onSnapshot(
    queryRef,
    { includeMetadataChanges: true },
    (snapshot) => {
      const nextPendingWrites = snapshot.metadata.hasPendingWrites;
      if (nextPendingWrites !== hasPendingWrites) {
        hasPendingWrites = nextPendingWrites;
        pendingListenerCount += hasPendingWrites ? 1 : -1;
        updateConnectionStatus();
      }
      onData(snapshot);
    },
    onError,
  );
};

const commitSaleOperation = async (payload) => {
  const saleRef = doc(db, "sales", payload.opId);
  let generatedInvNum = "";

  await runTransaction(db, async (transaction) => {
    const existingSale = await transaction.get(saleRef);
    if (existingSale.exists()) {
      generatedInvNum = existingSale.data().invoiceNumber;
      return;
    }

    const productDocsMap = new Map();
    for (const item of payload.saleItems) {
      const productRef = doc(db, "products", item.productId);
      const productDoc = await transaction.get(productRef);
      if (!productDoc.exists()) throw new Error(`Product ${item.name} does not exist!`);
      const currentStock = productDoc.data().currentStock;
      if (currentStock < item.normalizedQty) {
        throw new Error(`Insufficient stock for ${item.name}! Stock left: ${currentStock}`);
      }
      productDocsMap.set(item.productId, { ref: productRef, stock: currentStock });
    }

    let customerDocData = null;
    let customerRef = null;
    if (payload.balanceDue > 0 && payload.customerId !== "WALKIN") {
      customerRef = doc(db, "customers", payload.customerId);
      const customerDoc = await transaction.get(customerRef);
      if (customerDoc.exists()) customerDocData = customerDoc.data();
    }

    const counterRef = doc(db, "businesses", payload.businessId, "counters", "invoices");
    const counterDoc = await transaction.get(counterRef);
    const nextSequence = (counterDoc.exists() ? counterDoc.data().lastNumber || 0 : 0) + 1;
    const invoiceDate = new Date(payload.createdAt);
    const datePart = [invoiceDate.getFullYear(), invoiceDate.getMonth() + 1, invoiceDate.getDate()]
      .map((part) => String(part).padStart(2, "0"))
      .join("");
    generatedInvNum = `INV-${datePart}-${String(nextSequence).padStart(4, "0")}`;

    for (const item of payload.saleItems) {
      const productInfo = productDocsMap.get(item.productId);
      transaction.update(productInfo.ref, {
        currentStock: productInfo.stock - item.normalizedQty,
        updatedAt: serverTimestamp(),
      });
    }
    transaction.set(counterRef, { lastNumber: nextSequence }, { merge: true });
    transaction.set(saleRef, {
      businessId: payload.businessId,
      invoiceNumber: generatedInvNum,
      customerId: payload.customerId,
      customerName: payload.customerName,
      items: payload.saleItems,
      subtotal: payload.subtotal,
      discount: payload.discount,
      taxAmount: payload.taxAmount,
      grandTotal: payload.grandTotal,
      paidAmount: payload.paidAmount,
      balanceDue: payload.balanceDue,
      totalProfit: payload.totalProfit,
      paymentMethod: payload.paymentMethod,
      cashierUid: payload.cashierUid,
      createdAt: new Date(payload.createdAt),
      offlineOperationId: payload.opId,
    });
    if (customerRef && customerDocData) {
      transaction.update(customerRef, {
        balance: (customerDocData.balance || 0) + payload.balanceDue,
      });
    }
  });
  return generatedInvNum;
};

const commitPaymentOperation = async (payload) => {
  const paymentRef = doc(db, "udhaarPayments", payload.opId);
  await runTransaction(db, async (transaction) => {
    const existingPayment = await transaction.get(paymentRef);
    if (existingPayment.exists()) return;

    const customerRef = doc(db, "customers", payload.customerId);
    const customerDoc = await transaction.get(customerRef);
    if (!customerDoc.exists()) throw new Error("Customer not found.");
    const currentBalance = customerDoc.data().balance || 0;
    if (payload.amount > currentBalance) throw new Error("Payment exceeds current Udhaar balance.");

    transaction.update(customerRef, { balance: Math.max(0, currentBalance - payload.amount) });
    transaction.set(paymentRef, {
      businessId: payload.businessId,
      customerId: payload.customerId,
      customerName: payload.customerName,
      amount: payload.amount,
      fromDate: payload.fromDate,
      toDate: payload.toDate,
      note: payload.note,
      createdAt: new Date(payload.createdAt),
      offlineOperationId: payload.opId,
    });
  });
};

const syncOutbox = async () => {
  if (!navigator.onLine || syncingOutbox || !currentUser) return;
  syncingOutbox = true;
  updateConnectionStatus();
  try {
    const operations = (await readOutbox()).filter((operation) => operation.status === "queued");
    for (const operation of operations) {
      if (!navigator.onLine) break;
      const syncingOperation = { ...operation, status: "syncing", attempts: (operation.attempts || 0) + 1 };
      await writeOutboxOperation(syncingOperation);
      await refreshOutboxStatus();
      try {
        if (operation.type === "sale") {
          await commitSaleOperation(operation.payload);
        } else if (operation.type === "udhaarPayment") {
          await commitPaymentOperation(operation.payload);
        }
        await removeOutboxOperation(operation.opId);
      } catch (err) {
        await writeOutboxOperation({ ...syncingOperation, status: "failed", error: err.message });
        showToast(`Sync failed: ${err.message}`, "error");
      }
      await refreshOutboxStatus();
    }
  } finally {
    syncingOutbox = false;
    await refreshOutboxStatus();
  }
};

const makeOperationId = () => `${Date.now()}-${crypto.randomUUID()}`;

const applyLocalOperation = (operation) => {
  if (operation.type === "sale") {
    const payload = operation.payload;
    payload.saleItems.forEach((item) => {
      const product = state.products.find((entry) => entry.id === item.productId);
      if (product) product.currentStock -= item.normalizedQty;
    });
    if (payload.customerId !== "WALKIN" && payload.balanceDue > 0) {
      const customer = state.customers.find((entry) => entry.id === payload.customerId);
      if (customer) customer.balance = (customer.balance || 0) + payload.balanceDue;
    }
    state.sales.push({ ...payload, id: operation.opId, invoiceNumber: payload.localInvoiceNumber, createdAt: new Date(), syncStatus: "Pending sync" });
    renderPosProducts();
    renderProductsTable();
    renderSalesHistoryTable();
    refreshDashboard();
  } else if (operation.type === "udhaarPayment") {
    const payload = operation.payload;
    const customer = state.customers.find((entry) => entry.id === payload.customerId);
    if (customer) customer.balance = Math.max(0, (customer.balance || 0) - payload.amount);
    state.udhaarPayments.push({ ...payload, id: operation.opId, createdAt: new Date(), syncStatus: "Pending sync" });
    renderCustomersTable();
  }
};

const queueOfflineOperation = async (type, payload) => {
  const operation = { opId: makeOperationId(), type, payload, status: "queued", attempts: 0, createdAt: new Date().toISOString() };
  await writeOutboxOperation(operation);
  applyLocalOperation(operation);
  await refreshOutboxStatus();
  return operation;
};

const restorePendingOperations = async () => {
  const operations = await readOutbox();
  for (const operation of operations) {
    if (operation.status === "syncing") {
      operation.status = "queued";
      await writeOutboxOperation(operation);
    }
    if (operation.payload?.businessId === businessId && operation.status !== "synced") {
      applyLocalOperation(operation);
    }
  }
};

const formatCurrency = (amount) => {
  return (
    "Rs. " +
    Number(amount || 0).toLocaleString("en-PK", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
};

const showToast = (message, type = "info") => {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `<i class="fa-solid fa-circle-info"></i> <span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
};

const toggleLoader = (show, text = "Processing...") => {
  const loader = document.getElementById("global-loader");
  const loaderText = document.getElementById("loader-text");
  if (loaderText) loaderText.innerText = text;
  if (loader) {
    if (show) loader.classList.remove("hidden");
    else loader.classList.add("hidden");
  }
};

window.closeModal = () => {
  const modalContainer = document.getElementById("modal-container");
  if (modalContainer) modalContainer.classList.add("hidden");
};

const showDeleteConfirmation = (message) =>
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

const normalizeToStandardUnit = (qty, unit) => {
  const parsedQty = parseFloat(qty) || 0;
  if (unit === "Gram") return parsedQty / 1000;
  return parsedQty;
};

const readLogoFile = (file) =>
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

const populatePrintWindowContent = (
  printWindow,
  saleData,
  format = "thermal",
  autoPrint = true,
) => {
  if (!printWindow) return;

  const logoContent = currentBusiness?.logoDataUrl
    ? `<img src="${currentBusiness.logoDataUrl}" alt="Shop logo">`
    : `<h1>${currentBusiness?.shopName || "PAKPOS"}</h1>`;

  const subtotalForCalc = saleData.subtotal || 0;

  const itemsHtmlSimple = saleData.items
    .map((item, idx) => {
      return `
      <tr>
        <td style="padding:6px 8px;">${idx + 1}</td>
        <td style="padding:6px 8px;">${item.name}</td>
        <td style="padding:6px 8px; text-align:right;">${formatCurrency(item.sellingPrice)}</td>
        <td style="padding:6px 8px; text-align:center;">${item.qty}</td>
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
          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Nastaliq+Urdu:wght@400;700&display=swap" rel="stylesheet">
          <style>
            ${pageCss}
            body { font-family: 'Inter', 'Noto Nastaliq Urdu', sans-serif; color:#17212b; margin:0; padding:18px; display:flex; justify-content:center; background:#f3f6f8; }
            .urdu-text { font-family: 'Noto Nastaliq Urdu', serif; direction: rtl; line-height: 2; }
            .invoice-wrap { width:100%; max-width:${containerMaxWidth}; border-top:5px solid #0f766e; padding:28px; background:#fff; box-sizing:border-box; box-shadow:0 8px 24px rgba(15,23,42,.08); }
            .inv-header { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; padding-bottom:22px; border-bottom:1px solid #dbe4e8; }
            .inv-title { flex:1; order:1; text-align:left; }
            .inv-title h1 { margin:0 0 8px; font-size:${shopFontSize}; letter-spacing:.2px; color:#0f766e; }
            .inv-title img { display:block; width:auto; max-width:150px; max-height:58px; margin:0 0 8px; object-fit:contain; object-position:left center; }
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
              <div>${currentBusiness?.address || ""} • Phone: ${currentBusiness?.phone || ""}</div>
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
      <td style="width:70%;">${item.name} (${item.qty} ${item.unit})</td>
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
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Noto+Nastaliq+Urdu:wght@400;700&display=swap" rel="stylesheet">
        <style>
          ${pageCss}
          body { ${bodyStyle} font-family: 'Inter', 'Noto Nastaliq Urdu', sans-serif; padding: 6px; color: #17212b; }
          .urdu-text { font-family: 'Noto Nastaliq Urdu', serif; direction: rtl; line-height: 2; }
          h2, p { text-align: center; margin: 2px 0; }
          h2 { color:#0f766e; font-size:18px; }
          .receipt-logo { display:block; width:auto; max-width:54mm; max-height:18mm; margin:0 auto 3px; object-fit:contain; }
          table { width:100%; border-collapse:collapse; margin-top:10px; }
          td { padding:5px 0; vertical-align:top; border-bottom:1px solid #dbe4e8; }
          .border-top { border-top:1px solid #0f766e; }
          .total-row { font-weight:bold; font-size:12px; color:#0f766e; }
          .small { font-size:9px; color:#64748b; }
          .receipt-rule { color:#94a3b8; }
        </style>
      </head>
      <body>
        ${currentBusiness?.logoDataUrl ? `<img class="receipt-logo" src="${currentBusiness.logoDataUrl}" alt="Shop logo">` : `<h2>${currentBusiness?.shopName || "PakPOS Store"}</h2>`}
        <p class="small">${currentBusiness?.address || ""}</p>
        <p class="small">Phone: ${currentBusiness?.phone || "N/A"}</p>
        <p class="receipt-rule">--------------------------------</p>
        <p>Invoice: ${saleData.invoiceNumber}</p>
        <p>Customer: ${saleData.customerName}</p>
        <p class="receipt-rule">--------------------------------</p>
        <table>
          ${itemsHtml}
          <tr class="border-top">
            <td>Subtotal:</td>
            <td style="text-align: right;">${formatCurrency(saleData.subtotal)}</td>
          </tr>
          ${saleData.discount > 0 ? `<tr><td>Discount:</td><td style="text-align: right;">-${formatCurrency(saleData.discount)}</td></tr>` : ""}
          ${saleData.taxAmount > 0 ? `<tr><td>GST:</td><td style="text-align: right;">${formatCurrency(saleData.taxAmount)}</td></tr>` : ""}
          <tr class="total-row border-top">
            <td>Grand Total:</td>
            <td style="text-align: right;">${formatCurrency(saleData.grandTotal)}</td>
          </tr>
          <tr>
            <td>Paid:</td>
            <td style="text-align: right;">${formatCurrency(saleData.paidAmount)}</td>
          </tr>
          <tr>
            <td>Balance:</td>
            <td style="text-align: right;">${formatCurrency(saleData.balanceDue)}</td>
          </tr>
        </table>
        <p class="urdu-text" dir="auto" style="margin-top: 10px; text-align:center;">${currentBusiness?.invoiceFooter || "Thank you for shopping!"}</p>
        <script>
          // Auto-print on window load (user can cancel or choose printer);
          window.onload = () => { setTimeout(() => { window.print(); }, 200); };
        <\/script>
      </body>
    </html>
  `);
  printWindow.document.close();
};

// ==========================================================================
// 4. AUTHENTICATION & NAVIGATION INITIALIZATION
// ==========================================================================
onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    await loadUserProfileAndBusiness();
    document.getElementById("auth-screen")?.classList.add("hidden");
    document.getElementById("app-screen")?.classList.remove("hidden");
    initNavigation();
    initAppListeners();
    setupRealtimeListeners();
    await restorePendingOperations();
    await syncOutbox();
    startClock();
  } else {
    currentUser = null;
    currentBusiness = null;
    businessId = null;
    document.getElementById("app-screen")?.classList.add("hidden");
    document.getElementById("auth-screen")?.classList.remove("hidden");
  }
});

const startClock = () => {
  const clock = document.getElementById("clock-display");
  if (!clock) return;
  setInterval(() => {
    const now = new Date();
    clock.innerText = now.toLocaleTimeString("en-PK") + " PKT";
  }, 1000);
};

const loadUserProfileAndBusiness = async () => {
  try {
    const userRef = doc(db, "users", currentUser.uid);
    let userDoc = await getDoc(userRef);

    if (!userDoc.exists()) {
      const newBizRef = doc(collection(db, "businesses"));
      await setDoc(newBizRef, {
        shopName: "My PakPOS Store",
        ownerName: currentUser.displayName || "Admin",
        phone: "",
        address: "",
        tax: 0,
        createdAt: serverTimestamp(),
      });

      await setDoc(userRef, {
        uid: currentUser.uid,
        name: currentUser.displayName || "Admin User",
        email: currentUser.email,
        businessId: newBizRef.id,
        role: "Admin",
      });

      userDoc = await getDoc(userRef);
    }

    const userData = userDoc.data() || {};
    businessId = userData.businessId || "default_biz";

    const bizDoc = await getDoc(doc(db, "businesses", businessId));
    if (bizDoc.exists()) {
      currentBusiness = bizDoc.data();
    } else {
      currentBusiness = {
        shopName: "My PakPOS Store",
        ownerName: "Admin",
        phone: "",
        address: "",
        tax: 0,
      };
    }

    const shopElem = document.getElementById("sidebar-shop-name");
    const roleElem = document.getElementById("sidebar-user-role");

    if (shopElem) shopElem.innerText = currentBusiness.shopName || "My Store";
    if (roleElem) roleElem.innerText = userData.role || "Admin";

    const setShopName = document.getElementById("set-shop-name");
    const setShopPhone = document.getElementById("set-shop-phone");
    const setShopAddress = document.getElementById("set-shop-address");
    const setShopTax = document.getElementById("set-shop-tax");
    const logoPreview = document.getElementById("shop-logo-preview");

    if (setShopName) setShopName.value = currentBusiness.shopName || "";
    if (setShopPhone) setShopPhone.value = currentBusiness.phone || "";
    if (setShopAddress) setShopAddress.value = currentBusiness.address || "";
    if (setShopTax) setShopTax.value = currentBusiness.tax || 0;
    if (logoPreview && currentBusiness.logoDataUrl) {
      logoPreview.src = currentBusiness.logoDataUrl;
      logoPreview.classList.remove("hidden");
    }
  } catch (err) {
    if (err.code === "permission-denied") {
      showToast(
        "Firebase Rule Error: Update Firestore Rules in console.",
        "error",
      );
    } else {
      showToast("Error loading shop profile: " + err.message, "error");
    }
  }
};

const navigateTo = (pageId) => {
  const pages = document.querySelectorAll(".page-view");
  const navLinks = document.querySelectorAll(".sidebar-nav a");
  const title = document.getElementById("page-title");

  pages.forEach((p) => p.classList.remove("active"));
  navLinks.forEach((l) => l.classList.remove("active"));

  const targetPage = document.getElementById(`page-${pageId}`);
  if (targetPage) targetPage.classList.add("active");

  const activeLink = document.querySelector(
    `.sidebar-nav a[data-page="${pageId}"]`,
  );
  if (activeLink) activeLink.classList.add("active");

  if (title) {
    const titles = {
      dashboard: "Dashboard",
      pos: "POS Terminal",
      products: "Inventory Management",
      purchases: "Stock Purchases",
      "sales-history": "Sales History",
      customers: "Customers & Udhaar",
      suppliers: "Suppliers Directory",
      expenses: "Expense Tracker",
      reports: "Financial Reports",
      "delete-records": "Delete Records",
      settings: "Store Settings",
    };
    title.innerText = titles[pageId] || "Dashboard";
  }

  if (pageId === "dashboard") refreshDashboard();

  document.getElementById("sidebar")?.classList.remove("open");
  document.getElementById("sidebar-overlay")?.classList.remove("open");
};

const initNavigation = () => {
  document.querySelectorAll(".sidebar-nav a").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const page = link.getAttribute("data-page");
      if (page) navigateTo(page);
    });
  });

  document
    .getElementById("quick-pos-btn")
    ?.addEventListener("click", () => navigateTo("pos"));

  const hamburger = document.getElementById("mobile-hamburger");
  const closeBtn = document.getElementById("sidebar-close-btn");
  const overlay = document.getElementById("sidebar-overlay");
  const sidebar = document.getElementById("sidebar");

  hamburger?.addEventListener("click", () => {
    sidebar?.classList.add("open");
    overlay?.classList.add("open");
  });

  closeBtn?.addEventListener("click", () => {
    sidebar?.classList.remove("open");
    overlay?.classList.remove("open");
  });

  overlay?.addEventListener("click", () => {
    sidebar?.classList.remove("open");
    overlay?.classList.remove("open");
  });

  const themeToggle = document.getElementById("theme-toggle");
  themeToggle?.addEventListener("click", () => {
    document.body.classList.toggle("dark-mode");
    const isDark = document.body.classList.contains("dark-mode");
    themeToggle.innerHTML = isDark
      ? `<i class="fa-solid fa-sun"></i> <span>Light Mode</span>`
      : `<i class="fa-solid fa-moon"></i> <span>Dark Mode</span>`;
  });
};

const initAppListeners = () => {
  const catFilter = document.getElementById("product-category-filter");
  const prodSearch = document.getElementById("product-search-input");
  if (catFilter) catFilter.addEventListener("change", renderProductsTable);
  if (prodSearch) prodSearch.addEventListener("input", renderProductsTable);

  const salesSearch = document.getElementById("sales-search-input");
  const salesDateFilter = document.getElementById("sales-date-filter");
  if (salesSearch) salesSearch.addEventListener("input", renderSalesHistoryTable);
  if (salesDateFilter) salesDateFilter.addEventListener("change", renderSalesHistoryTable);

  const customerSearch = document.getElementById("customer-search-input");
  if (customerSearch) customerSearch.addEventListener("input", renderCustomersTable);

  const supplierSearch = document.getElementById("supplier-search-input");
  if (supplierSearch) supplierSearch.addEventListener("input", renderSuppliersTable);

  document
    .getElementById("delete-record-type")
    ?.addEventListener("change", renderDeleteRecords);
  document
    .getElementById("delete-record-search")
    ?.addEventListener("input", renderDeleteRecords);
  document
    .getElementById("delete-record-btn")
    ?.addEventListener("click", deleteSelectedRecord);

  const posSearch = document.getElementById("pos-search");
  const posCatSelect = document.getElementById("pos-category-filter");
  if (posSearch) {
    posSearch.addEventListener("input", (e) => {
      state.posSearchQuery = e.target.value;
      renderPosProducts();
    });
  }
  if (posCatSelect) {
    posCatSelect.addEventListener("change", (e) => {
      state.selectedCategory = e.target.value;
      renderPosProducts();
      renderCategoryChips();
    });
  }

  document
    .getElementById("pos-discount-input")
    ?.addEventListener("input", calculateCartTotals);
  document
    .getElementById("pos-tax-input")
    ?.addEventListener("input", calculateCartTotals);
  document
    .getElementById("pos-paid-amount")
    ?.addEventListener("input", calculateCartTotals);
  document.getElementById("pos-clear-cart")?.addEventListener("click", () => {
    state.cart = [];
    renderCart();
  });

  // Print preview of current cart (without completing sale)
  document
    .getElementById("pos-print-preview-btn")
    ?.addEventListener("click", () => {
      const format =
        document.getElementById("pos-print-format")?.value || "thermal";
      if (!state.cart || state.cart.length === 0) {
        showToast("Cart is empty", "error");
        return;
      }

      // Build temporary saleData object from current cart for preview
      let subtotal = 0;
      const saleItems = state.cart.map((item) => {
        const normalizedQty = normalizeToStandardUnit(item.qty, item.unit);
        const lineTotal = normalizedQty * item.sellingPrice;
        subtotal += lineTotal;
        return Object.assign({}, item, { normalizedQty, lineTotal });
      });
      const discount =
        parseFloat(document.getElementById("pos-discount-input")?.value) || 0;
      const taxPct =
        parseFloat(document.getElementById("pos-tax-input")?.value) || 0;
      const taxAmount = (subtotal - discount) * (taxPct / 100);
      const grandTotal = Math.max(0, subtotal - discount + taxAmount);
      const paidAmount =
        parseFloat(document.getElementById("pos-paid-amount")?.value) || 0;
      const balanceDue = grandTotal > paidAmount ? grandTotal - paidAmount : 0;
      const customerId =
        document.getElementById("pos-customer-select")?.value || "WALKIN";
      const customerObj = state.customers.find((c) => c.id === customerId);
      const customerName = customerObj ? customerObj.name : "Walk-in Customer";

      const salePreview = {
        invoiceNumber: "INV-" + Math.floor(1000 + Math.random() * 9000),
        customerName,
        items: saleItems,
        subtotal,
        discount,
        taxAmount,
        grandTotal,
        paidAmount,
        balanceDue,
        paymentMethod:
          document.getElementById("pos-payment-method")?.value || "Cash",
      };

      const printWindow = window.open("", "_blank", "width=400,height=600");
      populatePrintWindowContent(printWindow, salePreview, format, false);
    });

  document
    .getElementById("settings-form")
    ?.addEventListener("submit", async (e) => {
      e.preventDefault();
      toggleLoader(true, "Saving Settings...");
      try {
        const shopName = document.getElementById("set-shop-name").value;
        const phone = document.getElementById("set-shop-phone").value;
        const address = document.getElementById("set-shop-address").value;
        const tax =
          parseFloat(document.getElementById("set-shop-tax").value) || 0;
        const logoFile = document.getElementById("set-shop-logo")?.files?.[0];
        const removeLogo = document.getElementById("set-remove-logo")?.checked;
        const logoDataUrl = removeLogo
          ? ""
          : logoFile
            ? await readLogoFile(logoFile)
            : currentBusiness?.logoDataUrl || "";

        const businessUpdate = {
          shopName,
          phone,
          address,
          tax,
          logoDataUrl,
        };
        await updateDoc(doc(db, "businesses", businessId), businessUpdate);
        currentBusiness = { ...currentBusiness, ...businessUpdate };
        showToast("Settings updated successfully!", "success");
        loadUserProfileAndBusiness();
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        toggleLoader(false);
      }
    });

  document.getElementById("set-shop-logo")?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    const preview = document.getElementById("shop-logo-preview");
    if (!file || !preview) return;
    const reader = new FileReader();
    reader.onload = () => {
      preview.src = reader.result;
      preview.classList.remove("hidden");
    };
    reader.readAsDataURL(file);
  });

  document
    .getElementById("load-demo-data-btn")
    ?.addEventListener("click", seedDemoData);
  document
    .getElementById("export-products-csv")
    ?.addEventListener("click", exportProductsCSV);
  document
    .getElementById("export-sales-csv")
    ?.addEventListener("click", exportSalesCSV);
  document
    .getElementById("add-expense-btn")
    ?.addEventListener("click", () => openExpenseFormModal());
  document
    .getElementById("new-purchase-btn")
    ?.addEventListener("click", () => openPurchaseFormModal());
  document
    .getElementById("add-supplier-btn")
    ?.addEventListener("click", () => openSupplierFormModal());

  const posCustSearch = document.getElementById("pos-customer-search");
  if (posCustSearch) {
    posCustSearch.addEventListener("input", (e) => {
      const q = (e.target.value || "").toLowerCase();
      const select = document.getElementById("pos-customer-select");
      if (!select) return;
      select.innerHTML = `<option value="WALKIN">Walk-in Customer (Grahak)</option>`;
      state.customers
        .filter(
          (c) =>
            (c.name || "").toLowerCase().includes(q) ||
            (c.phone || "").toLowerCase().includes(q),
        )
        .forEach((c) => {
          select.innerHTML += `<option value="${c.id}">${c.name} (${c.phone || "No Phone"}) - Bal: ${formatCurrency(c.balance)}</option>`;
        });
    });
  }

  document
    .getElementById("pos-add-customer-btn")
    ?.addEventListener("click", () => {
      document.getElementById("add-customer-btn")?.click();
    });

  document
    .getElementById("generate-report-btn")
    ?.addEventListener("click", generateReport);

  // --- Mobile POS cart drawer toggle ---
  const createMobileCartToggle = () => {
    // Only create if not present
    if (document.getElementById("cart-toggle-btn")) return;

    const btn = document.createElement("button");
    btn.id = "cart-toggle-btn";
    btn.className = "cart-toggle-btn mobile-only";
    btn.innerHTML = `<i class="fa-solid fa-cart-shopping"></i> Cart`;
    document.body.appendChild(btn);

    const overlay = document.createElement("div");
    overlay.id = "cart-overlay";
    overlay.className = "cart-overlay";
    document.body.appendChild(overlay);

    const posRight = document.querySelector(".pos-right");
    if (!posRight) return;

    const openCart = () => {
      posRight.classList.add("open");
      overlay.classList.add("open");
    };
    const closeCart = () => {
      posRight.classList.remove("open");
      overlay.classList.remove("open");
    };

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (posRight.classList.contains("open")) closeCart();
      else openCart();
    });

    overlay.addEventListener("click", () => closeCart());

    // Close cart when navigating away from POS page
    document.querySelectorAll(".sidebar-nav a").forEach((link) => {
      link.addEventListener("click", () => closeCart());
    });

    // Auto-show/hide based on viewport
    const checkViewport = () => {
      if (window.innerWidth <= 600) {
        btn.classList.remove("hidden");
      } else {
        btn.classList.add("hidden");
        closeCart();
      }
    };

    window.addEventListener("resize", checkViewport);
    checkViewport();
  };

  createMobileCartToggle();
};

document.getElementById("login-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  toggleLoader(true, "Signing in...");
  try {
    const email = document.getElementById("login-email").value;
    const pass = document.getElementById("login-password").value;
    await setPersistence(auth, browserLocalPersistence);
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    toggleLoader(false);
  }
});

document
  .getElementById("register-form")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();
    toggleLoader(true, "Registering Store...");
    try {
      const name = document.getElementById("reg-name").value;
      const shopName = document.getElementById("reg-shop").value;
      const email = document.getElementById("reg-email").value;
      const pass = document.getElementById("reg-password").value;

      const userCred = await createUserWithEmailAndPassword(auth, email, pass);
      const uid = userCred.user.uid;
      const newBizRef = doc(collection(db, "businesses"));

      await setDoc(newBizRef, {
        shopName,
        ownerName: name,
        phone: "",
        address: "",
        tax: 0,
        createdAt: serverTimestamp(),
      });

      await setDoc(doc(db, "users", uid), {
        uid,
        name,
        email,
        businessId: newBizRef.id,
        role: "Admin",
      });

      showToast("Store setup successful!", "success");
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      toggleLoader(false);
    }
  });

document.getElementById("show-register")?.addEventListener("click", () => {
  document.getElementById("login-form")?.classList.add("hidden");
  document.getElementById("register-form")?.classList.remove("hidden");
});

document.getElementById("show-login")?.addEventListener("click", () => {
  document.getElementById("register-form")?.classList.add("hidden");
  document.getElementById("login-form")?.classList.remove("hidden");
});

document
  .getElementById("logout-btn")
  ?.addEventListener("click", () => signOut(auth));

// ==========================================================================
// 5. FIRESTORE REAL-TIME SUBSCRIPTIONS
// ==========================================================================
const setupRealtimeListeners = () => {
  if (!businessId) return;

  const handleErr = (err) => {
    if (err.code === "permission-denied") {
      showToast(
        "Access Denied: Please check Firestore Rules in Firebase Console.",
        "error",
      );
    }
  };

  const qProd = query(
    collection(db, "products"),
    where("businessId", "==", businessId),
  );
  subscribeToQuery(
    qProd,
    (snapshot) => {
      state.products = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
      renderProductsTable();
      renderPosProducts();
      populateCategoryDropdowns();
      renderCategoryChips();
      renderDeleteRecords();
      refreshDashboard();
    },
    handleErr,
  );

  const qCust = query(
    collection(db, "customers"),
    where("businessId", "==", businessId),
  );
  subscribeToQuery(
    qCust,
    (snapshot) => {
      state.customers = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
      renderCustomersTable();
      renderPosCustomerDropdown();
      renderDeleteRecords();
      refreshDashboard();
    },
    handleErr,
  );

  const qUdhaarPayments = query(
    collection(db, "udhaarPayments"),
    where("businessId", "==", businessId),
  );
  subscribeToQuery(
    qUdhaarPayments,
    (snapshot) => {
      state.udhaarPayments = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
    },
    handleErr,
  );

  const qSupp = query(
    collection(db, "suppliers"),
    where("businessId", "==", businessId),
  );
  subscribeToQuery(
    qSupp,
    (snapshot) => {
      state.suppliers = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
      renderSuppliersTable();
      renderDeleteRecords();
      refreshDashboard();
    },
    handleErr,
  );

  const qSales = query(
    collection(db, "sales"),
    where("businessId", "==", businessId),
  );
  subscribeToQuery(
    qSales,
    (snapshot) => {
      state.sales = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      renderSalesHistoryTable();
      renderDeleteRecords();
      refreshDashboard();
    },
    handleErr,
  );

  const qPurch = query(
    collection(db, "purchases"),
    where("businessId", "==", businessId),
  );
  subscribeToQuery(
    qPurch,
    (snapshot) => {
      state.purchases = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
      renderPurchasesTable();
      renderDeleteRecords();
      refreshDashboard();
    },
    handleErr,
  );

  const qExp = query(
    collection(db, "expenses"),
    where("businessId", "==", businessId),
  );
  subscribeToQuery(
    qExp,
    (snapshot) => {
      state.expenses = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
      renderExpensesTable();
      renderDeleteRecords();
      refreshDashboard();
    },
    handleErr,
  );
};

const populateCategoryDropdowns = () => {
  const invSelect = document.getElementById("product-category-filter");
  const posSelect = document.getElementById("pos-category-filter");

  const options =
    `<option value="ALL">All Categories</option>` +
    state.categories.map((c) => `<option value="${c}">${c}</option>`).join("");

  if (invSelect) invSelect.innerHTML = options;
  if (posSelect) posSelect.innerHTML = options;
};

const renderCategoryChips = () => {
  const container = document.getElementById("pos-category-chips");
  if (!container) return;

  const cats = ["ALL", ...state.categories];
  container.innerHTML = cats
    .map(
      (c) => `
    <span class="chip ${state.selectedCategory === c ? "active" : ""}" onclick="window.selectCategoryChip('${c}')">${c}</span>
  `,
    )
    .join("");
};

window.selectCategoryChip = (cat) => {
  state.selectedCategory = cat;
  const posSelect = document.getElementById("pos-category-filter");
  if (posSelect) posSelect.value = cat;
  renderPosProducts();
  renderCategoryChips();
};

const renderSalesHistoryTable = () => {
  const tbody = document.getElementById("sales-table-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  const search =
    document.getElementById("sales-search-input")?.value.toLowerCase().trim() || "";
  const dateFilter = document.getElementById("sales-date-filter")?.value || "";

  state.sales.filter((s) => {
    const date = s.createdAt?.toDate ? s.createdAt.toDate() : null;
    const dateStr = date ? date.toLocaleString() : "";
    const matchesSearch = [s.invoiceNumber, s.customerName, s.paymentMethod]
      .filter(Boolean)
      .some((value) => value.toString().toLowerCase().includes(search));
    const matchesDate = !dateFilter || (date && date.toISOString().slice(0, 10) === dateFilter);
    return matchesSearch && matchesDate;
  }).forEach((s) => {
    const tr = document.createElement("tr");
    const saleDate = s.createdAt?.toDate ? s.createdAt.toDate() : s.createdAt instanceof Date ? s.createdAt : null;
    const dateStr = saleDate ? saleDate.toLocaleString() : "N/A";
    const statusLabel = s.syncStatus || "Completed";
    const statusClass = s.syncStatus ? "bg-orange" : "bg-green";
    tr.innerHTML = `
      <td><strong>${s.invoiceNumber}</strong></td>
      <td>${dateStr}</td>
      <td>${s.customerName || "Walk-in"}</td>
      <td>${(s.items || []).length} items</td>
      <td><strong>${formatCurrency(s.grandTotal)}</strong></td>
      <td><span class="chip">${s.paymentMethod || "Cash"}</span></td>
      <td><span class="chip ${statusClass}" style="color:#fff;">${statusLabel}</span></td>
      <td>
        <button class="btn btn-sm btn-secondary" onclick='window.reprintInvoice(${JSON.stringify(s)})'><i class="fa-solid fa-print"></i></button>
      </td>
    `;
    tbody.appendChild(tr);
  });
};

window.reprintInvoice = (saleObj) => {
  const format =
    document.getElementById("pos-print-format")?.value || "thermal";
  const printWindow = window.open("", "_blank", "width=400,height=600");
  populatePrintWindowContent(printWindow, saleObj, format, true);
};

const renderPurchasesTable = () => {
  const tbody = document.getElementById("purchases-table-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  state.purchases.forEach((p) => {
    const tr = document.createElement("tr");
    const dateStr = p.createdAt?.toDate
      ? p.createdAt.toDate().toLocaleDateString()
      : "N/A";
    tr.innerHTML = `
      <td><strong>${p.invoiceNumber || "PUR-001"}</strong></td>
      <td>${dateStr}</td>
      <td>${p.supplierName}</td>
      <td>${formatCurrency(p.totalAmount)}</td>
      <td>${formatCurrency(p.paidAmount)}</td>
      <td><strong class="text-red">${formatCurrency(p.balanceDue)}</strong></td>
      <td>
        <button class="btn btn-sm btn-secondary" onclick="window.editPurchaseModal('${p.id}')"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-sm btn-danger" onclick="window.deletePurchase('${p.id}')"><i class="fa-solid fa-trash"></i></button>
      </td>
    `;
    tbody.appendChild(tr);
  });
};

const renderExpensesTable = () => {
  const tbody = document.getElementById("expenses-table-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  state.expenses.forEach((e) => {
    const tr = document.createElement("tr");
    const dateStr = e.createdAt?.toDate
      ? e.createdAt.toDate().toLocaleDateString()
      : "N/A";
    tr.innerHTML = `
      <td>${dateStr}</td>
      <td><strong>${e.title}</strong></td>
      <td><span class="chip">${e.category}</span></td>
      <td><strong class="text-red">${formatCurrency(e.amount)}</strong></td>
      <td>
        <button class="btn btn-sm btn-secondary" onclick="window.editExpenseModal('${e.id}')"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-sm btn-danger" onclick="window.deleteExpense('${e.id}')"><i class="fa-solid fa-trash"></i></button>
      </td>
    `;
    tbody.appendChild(tr);
  });
};

window.editExpenseModal = (id) => {
  const e = state.expenses.find((x) => x.id === id);
  if (e) openExpenseFormModal(e);
};

window.deleteExpense = async (id) => {
  if (await showDeleteConfirmation("This expense entry will be permanently removed.")) {
    await deleteDoc(doc(db, "expenses", id));
    showToast("Expense removed.", "info");
  }
};

// ==========================================================================
// 6. DASHBOARD & CHARTS MODULE
// ==========================================================================
const updateDashboardMetrics = () => {
  const todayStr = new Date().toISOString().split("T")[0];

  let todaySalesTotal = 0;
  let todayProfitTotal = 0;
  let todayOrdersCount = 0;

  state.sales.forEach((sale) => {
    const saleDate = sale.createdAt?.toDate
      ? sale.createdAt.toDate().toISOString().split("T")[0]
      : "";
    if (saleDate === todayStr) {
      todaySalesTotal += sale.grandTotal || 0;
      todayProfitTotal += sale.totalProfit || 0;
      todayOrdersCount++;
    }
  });

  let todayPurchasesTotal = 0;
  state.purchases.forEach((purch) => {
    const purchDate = purch.createdAt?.toDate
      ? purch.createdAt.toDate().toISOString().split("T")[0]
      : "";
    if (purchDate === todayStr) todayPurchasesTotal += purch.totalAmount || 0;
  });

  let lowStockCount = 0;
  let totalStockVal = 0;
  state.products.forEach((p) => {
    if (p.currentStock <= (p.minStockAlert || 5)) lowStockCount++;
    totalStockVal += p.currentStock * p.purchasePrice;
  });

  let totalReceivables = 0;
  state.customers.forEach((c) => (totalReceivables += c.balance || 0));

  const setElem = (id, val) => {
    const elem = document.getElementById(id);
    if (elem) elem.innerText = val;
  };

  setElem("dash-today-sales", formatCurrency(todaySalesTotal));
  setElem("dash-today-profit", formatCurrency(todayProfitTotal));
  setElem("dash-today-orders", todayOrdersCount);
  setElem("dash-today-purchases", formatCurrency(todayPurchasesTotal));
  setElem("dash-total-products", state.products.length);
  setElem("dash-low-stock-count", lowStockCount);
  setElem("dash-stock-value", formatCurrency(totalStockVal));
  setElem("dash-total-receivables", formatCurrency(totalReceivables));
};

function refreshDashboard() {
  updateDashboardMetrics();
  renderCharts();
}

const renderCharts = () => {
  if (typeof Chart === "undefined") return;

  const salesCanvas = document.getElementById("sales-chart");
  if (salesCanvas) {
    const ctxSales = salesCanvas.getContext("2d");
    const days = [];
    const salesData = [];

    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      days.push(d.toLocaleDateString("en-PK", { weekday: "short" }));

      const dayTotal = state.sales
        .filter(
          (s) =>
            s.createdAt?.toDate &&
            s.createdAt.toDate().toISOString().split("T")[0] === dateStr,
        )
        .reduce((acc, curr) => acc + curr.grandTotal, 0);
      salesData.push(dayTotal);
    }

    if (salesChartInstance) salesChartInstance.destroy();
    salesChartInstance = new Chart(ctxSales, {
      type: "line",
      data: {
        labels: days,
        datasets: [
          {
            label: "Daily Sales (PKR)",
            data: salesData,
            borderColor: "#0f766e",
            backgroundColor: "rgba(15, 118, 110, 0.1)",
            fill: true,
            tension: 0.3,
          },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false },
    });
  }

  const topCanvas = document.getElementById("top-products-chart");
  if (topCanvas) {
    const ctxTop = topCanvas.getContext("2d");
    const productSalesMap = {};

    state.sales.forEach((s) => {
      (s.items || []).forEach((item) => {
        productSalesMap[item.name] =
          (productSalesMap[item.name] || 0) + item.lineTotal;
      });
    });

    const sortedProducts = Object.entries(productSalesMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    if (topProductsChartInstance) topProductsChartInstance.destroy();
    topProductsChartInstance = new Chart(ctxTop, {
      type: "bar",
      data: {
        labels: sortedProducts.map((p) => p[0]),
        datasets: [
          {
            label: "Revenue (PKR)",
            data: sortedProducts.map((p) => p[1]),
            backgroundColor: "#16a34a",
          },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false },
    });
  }
};

// ==========================================================================
// 7. POS TERMINAL ENGINE
// ==========================================================================
const renderPosProducts = () => {
  const grid = document.getElementById("pos-product-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const filtered = state.products.filter((p) => {
    const matchesCat =
      state.selectedCategory === "ALL" || p.category === state.selectedCategory;
    const q = state.posSearchQuery.toLowerCase();
    const matchesSearch =
      p.name.toLowerCase().includes(q) ||
      (p.barcode && p.barcode.includes(q)) ||
      (p.sku && p.sku.toLowerCase().includes(q));
    return matchesCat && matchesSearch;
  });

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column: 1/-1;"><p>No matching products found.</p></div>`;
    return;
  }

  filtered.forEach((p) => {
    const card = document.createElement("div");
    card.className = "pos-product-card";
    card.onclick = () => addToCart(p);
    card.innerHTML = `
      <div>
        <div class="pos-product-title">${p.name}</div>
        <div class="pos-product-stock">Stock: ${p.currentStock} ${p.unit}</div>
      </div>
      <div class="pos-product-price">${formatCurrency(p.sellingPrice)} / ${p.unit}</div>
    `;
    grid.appendChild(card);
  });
};

const addToCart = (product) => {
  const existingIndex = state.cart.findIndex((item) => item.id === product.id);

  if (existingIndex > -1) {
    state.cart[existingIndex].qty += product.unit === "Gram" ? 250 : 1;
  } else {
    const initQty = product.unit === "Gram" ? 250 : 1;
    state.cart.push({
      id: product.id,
      name: product.name,
      unit: product.unit,
      purchasePrice: product.purchasePrice,
      sellingPrice: product.sellingPrice,
      qty: initQty,
    });
  }
  renderCart();
};

const renderCart = () => {
  const container = document.getElementById("pos-cart-items");
  if (!container) return;
  container.innerHTML = "";

  if (state.cart.length === 0) {
    container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-basket-shopping"></i><p>Cart is empty.</p></div>`;
    calculateCartTotals();
    return;
  }

  state.cart.forEach((item, index) => {
    const el = document.createElement("div");
    el.className = "cart-item";

    const normalizedQty = normalizeToStandardUnit(item.qty, item.unit);
    const lineTotal = normalizedQty * item.sellingPrice;

    el.innerHTML = `
      <div class="cart-item-info">
        <div class="cart-item-title">${item.name}</div>
        <div class="cart-item-unit-price">${formatCurrency(item.sellingPrice)} / ${item.unit}</div>
      </div>
      <div class="cart-item-qty-controls">
        <input type="number" step="${item.unit === "KG" || item.unit === "Gram" ? "0.05" : "1"}" 
               value="${item.qty}" onchange="window.updateCartQty(${index}, this.value)">
        <span style="font-size: 0.75rem;">${item.unit}</span>
      </div>
      <div style="font-weight: 700; width: 80px; text-align: right;">${formatCurrency(lineTotal)}</div>
      <button class="icon-btn text-red" onclick="window.removeCartItem(${index})"><i class="fa-solid fa-xmark"></i></button>
    `;
    container.appendChild(el);
  });

  calculateCartTotals();
};

window.updateCartQty = (index, val) => {
  const parsed = parseFloat(val);
  if (isNaN(parsed) || parsed <= 0) {
    state.cart.splice(index, 1);
  } else {
    state.cart[index].qty = parsed;
  }
  renderCart();
};

window.removeCartItem = (index) => {
  state.cart.splice(index, 1);
  renderCart();
};

const calculateCartTotals = () => {
  let subtotal = 0;
  state.cart.forEach((item) => {
    const normalizedQty = normalizeToStandardUnit(item.qty, item.unit);
    subtotal += normalizedQty * item.sellingPrice;
  });

  const discount =
    parseFloat(document.getElementById("pos-discount-input")?.value) || 0;
  const taxPct =
    parseFloat(document.getElementById("pos-tax-input")?.value) || 0;

  const taxAmount = (subtotal - discount) * (taxPct / 100);
  const grandTotal = Math.max(0, subtotal - discount + taxAmount);

  const paidAmount =
    parseFloat(document.getElementById("pos-paid-amount")?.value) || 0;
  const diff = paidAmount - grandTotal;

  const setVal = (id, val) => {
    const elem = document.getElementById(id);
    if (elem) elem.innerText = val;
  };

  setVal("pos-subtotal", formatCurrency(subtotal));
  setVal("pos-grand-total", formatCurrency(grandTotal));

  if (diff >= 0) {
    setVal("pos-change-due", formatCurrency(diff));
    setVal("pos-balance-due", formatCurrency(0));
  } else {
    setVal("pos-change-due", formatCurrency(0));
    setVal("pos-balance-due", formatCurrency(Math.abs(diff)));
  }
};

// CHECKOUT TRANSACTION
document
  .getElementById("pos-checkout-btn")
  ?.addEventListener("click", async () => {
    if (state.cart.length === 0) {
      showToast("Cart is empty!", "error");
      return;
    }

    // Open receipt window synchronously on user click to prevent popup blockers
    const format =
      document.getElementById("pos-print-format")?.value || "thermal";
    const printWindow = window.open("", "_blank", "width=400,height=600");

    toggleLoader(true, "Completing Sale & Updating Stock...");

    try {
      let subtotal = 0;
      let totalCost = 0;

      const saleItems = state.cart.map((item) => {
        const normalizedQty = normalizeToStandardUnit(item.qty, item.unit);
        const lineTotal = normalizedQty * item.sellingPrice;
        const lineCost = normalizedQty * item.purchasePrice;

        subtotal += lineTotal;
        totalCost += lineCost;

        return {
          productId: item.id,
          name: item.name,
          unit: item.unit,
          qty: item.qty,
          normalizedQty,
          sellingPrice: item.sellingPrice,
          purchasePrice: item.purchasePrice,
          lineTotal,
        };
      });

      const discount =
        parseFloat(document.getElementById("pos-discount-input")?.value) || 0;
      const taxPct =
        parseFloat(document.getElementById("pos-tax-input")?.value) || 0;
      const taxAmount = (subtotal - discount) * (taxPct / 100);
      const grandTotal = Math.max(0, subtotal - discount + taxAmount);
      const paidAmount =
        parseFloat(document.getElementById("pos-paid-amount")?.value) || 0;
      const balanceDue = grandTotal > paidAmount ? grandTotal - paidAmount : 0;
      const totalProfit = grandTotal - totalCost;

      const paymentMethod =
        document.getElementById("pos-payment-method")?.value || "Cash";
      const customerId =
        document.getElementById("pos-customer-select")?.value || "WALKIN";
      const customerObj = state.customers.find((c) => c.id === customerId);
      const customerName = customerObj ? customerObj.name : "Walk-in Customer";
      const operationId = makeOperationId();
      const localInvoiceNumber = `LOCAL-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${operationId.slice(-6)}`;
      const salePayload = {
        opId: operationId,
        businessId,
        cashierUid: currentUser.uid,
        createdAt: new Date().toISOString(),
        localInvoiceNumber,
        saleItems,
        customerId,
        customerName,
        subtotal,
        discount,
        taxAmount,
        grandTotal,
        paidAmount,
        balanceDue,
        totalProfit,
        paymentMethod,
      };

      if (!navigator.onLine) {
        await queueOfflineOperation("sale", salePayload);
        showToast(`Sale saved offline as ${localInvoiceNumber}. It will sync when internet returns.`, "success");
        populatePrintWindowContent(printWindow, {
          ...salePayload,
          invoiceNumber: localInvoiceNumber,
          items: saleItems,
        }, format, true);
        state.cart = [];
        if (document.getElementById("pos-discount-input")) document.getElementById("pos-discount-input").value = 0;
        if (document.getElementById("pos-paid-amount")) document.getElementById("pos-paid-amount").value = "";
        renderCart();
        return;
      }

      let generatedInvNum = "";

      await runTransaction(db, async (transaction) => {
        // 1. All Reads First
        const productDocsMap = new Map();

        for (const item of saleItems) {
          const prodRef = doc(db, "products", item.productId);
          const prodDoc = await transaction.get(prodRef);

          if (!prodDoc.exists())
            throw new Error(`Product ${item.name} does not exist!`);

          const currentStock = prodDoc.data().currentStock;
          if (currentStock < item.normalizedQty) {
            throw new Error(
              `Insufficient stock for ${item.name}! Stock left: ${currentStock}`,
            );
          }

          productDocsMap.set(item.productId, {
            ref: prodRef,
            stock: currentStock,
          });
        }

        let customerDocData = null;
        let custRef = null;
        if (balanceDue > 0 && customerId !== "WALKIN") {
          custRef = doc(db, "customers", customerId);
          const custDoc = await transaction.get(custRef);
          if (custDoc.exists()) {
            customerDocData = custDoc.data();
          }
        }

        const invoiceCounterRef = doc(
          db,
          "businesses",
          businessId,
          "counters",
          "invoices",
        );
        const invoiceCounterDoc = await transaction.get(invoiceCounterRef);
        const nextInvoiceSequence =
          (invoiceCounterDoc.exists()
            ? invoiceCounterDoc.data().lastNumber || 0
            : 0) + 1;

        // 2. All Writes After Reads
        for (const item of saleItems) {
          const prodInfo = productDocsMap.get(item.productId);
          const newStock = prodInfo.stock - item.normalizedQty;
          transaction.update(prodInfo.ref, {
            currentStock: newStock,
            updatedAt: serverTimestamp(),
          });
        }

        const now = new Date();
        const invoiceDate = [
          now.getFullYear(),
          now.getMonth() + 1,
          now.getDate(),
        ]
          .map((part) => String(part).padStart(2, "0"))
          .join("");
        generatedInvNum = `INV-${invoiceDate}-${String(nextInvoiceSequence).padStart(4, "0")}`;
        const newSaleRef = doc(collection(db, "sales"));

        transaction.set(
          invoiceCounterRef,
          { lastNumber: nextInvoiceSequence },
          { merge: true },
        );

        transaction.set(newSaleRef, {
          businessId,
          invoiceNumber: generatedInvNum,
          customerId,
          customerName,
          items: saleItems,
          subtotal,
          discount,
          taxAmount,
          grandTotal,
          paidAmount,
          balanceDue,
          totalProfit,
          paymentMethod,
          cashierUid: currentUser.uid,
          createdAt: serverTimestamp(),
        });

        if (custRef && customerDocData) {
          const newBal = (customerDocData.balance || 0) + balanceDue;
          transaction.update(custRef, { balance: newBal });
        }
      });

      showToast("Sale completed successfully!", "success");

      const saleReceiptData = {
        invoiceNumber: generatedInvNum,
        customerName,
        items: saleItems,
        subtotal,
        discount,
        taxAmount,
        grandTotal,
        paidAmount,
        balanceDue,
        paymentMethod,
      };

      populatePrintWindowContent(printWindow, saleReceiptData, format, true);

      state.cart = [];
      if (document.getElementById("pos-discount-input"))
        document.getElementById("pos-discount-input").value = 0;
      if (document.getElementById("pos-paid-amount"))
        document.getElementById("pos-paid-amount").value = "";
      renderCart();
    } catch (err) {
      if (printWindow) printWindow.close();
      showToast(err.message, "error");
    } finally {
      toggleLoader(false);
    }
  });

// ==========================================================================
// 8. PRODUCT MANAGEMENT
// ==========================================================================
const renderProductsTable = () => {
  const tbody = document.getElementById("products-table-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  const filter =
    document.getElementById("product-category-filter")?.value || "ALL";
  const q =
    document.getElementById("product-search-input")?.value.toLowerCase() || "";

  const filtered = state.products.filter((p) => {
    const matchCat = filter === "ALL" || p.category === filter;
    const matchQ =
      p.name.toLowerCase().includes(q) || (p.barcode && p.barcode.includes(q));
    return matchCat && matchQ;
  });

  filtered.forEach((p) => {
    const tr = document.createElement("tr");
    const isLow = p.currentStock <= (p.minStockAlert || 5);

    tr.innerHTML = `
      <td>${p.barcode || p.sku || "N/A"}</td>
      <td><strong>${p.name}</strong></td>
      <td><span class="chip">${p.category}</span></td>
      <td>${p.unit}</td>
      <td>${formatCurrency(p.purchasePrice)}</td>
      <td>${formatCurrency(p.sellingPrice)}</td>
      <td><strong>${p.currentStock}</strong> ${p.unit}</td>
      <td><span class="chip ${isLow ? "bg-red" : "bg-green"}" style="color:#fff;">${isLow ? "Low Stock" : "In Stock"}</span></td>
      <td>
        <button class="btn btn-sm btn-secondary" onclick="window.editProductModal('${p.id}')"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-sm btn-danger" onclick="window.deleteProduct('${p.id}')"><i class="fa-solid fa-trash"></i></button>
      </td>
    `;
    tbody.appendChild(tr);
  });
};

document.getElementById("add-product-btn")?.addEventListener("click", () => {
  openProductModal();
});

const openProductModal = (product = null) => {
  const modalContainer = document.getElementById("modal-container");
  const modalContent = document.getElementById("modal-content");
  if (!modalContainer || !modalContent) return;

  modalContent.innerHTML = `
    <div class="modal-header">
      <h3>${product ? "Edit Product" : "Add New Product"}</h3>
      <button class="icon-btn" onclick="window.closeModal()"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <form id="product-form">
      <div class="modal-body">
        <div class="form-group">
          <label>Product Name *</label>
          <input type="text" id="prod-name" value="${product ? product.name : ""}" required>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Barcode / SKU</label>
            <input type="text" id="prod-barcode" value="${product ? product.barcode || "" : ""}">
          </div>
          <div class="form-group">
            <label>Category</label>
            <select id="prod-category">
              ${state.categories.map((c) => `<option value="${c}" ${product && product.category === c ? "selected" : ""}>${c}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Unit Type</label>
            <select id="prod-unit">
              <option value="Piece" ${product && product.unit === "Piece" ? "selected" : ""}>Piece</option>
              <option value="KG" ${product && product.unit === "KG" ? "selected" : ""}>KG (Kilogram)</option>
              <option value="Gram" ${product && product.unit === "Gram" ? "selected" : ""}>Gram</option>
              <option value="Liter" ${product && product.unit === "Liter" ? "selected" : ""}>Liter</option>
              <option value="Box" ${product && product.unit === "Box" ? "selected" : ""}>Box</option>
              <option value="Pack" ${product && product.unit === "Pack" ? "selected" : ""}>Pack</option>
            </select>
          </div>
          <div class="form-group">
            <label>Current Stock</label>
            <input type="number" step="0.01" id="prod-stock" value="${product ? product.currentStock : "0"}" required>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Purchase Price (Cost)</label>
            <input type="number" step="0.01" id="prod-cost" value="${product ? product.purchasePrice : "0"}" required>
          </div>
          <div class="form-group">
            <label>Selling Price</label>
            <input type="number" step="0.01" id="prod-price" value="${product ? product.sellingPrice : "0"}" required>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" onclick="window.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save Product</button>
      </div>
    </form>
  `;

  modalContainer.classList.remove("hidden");

  document.getElementById("product-form").onsubmit = async (e) => {
    e.preventDefault();
    toggleLoader(true, "Saving product...");

    const prodData = {
      businessId,
      name: document.getElementById("prod-name").value,
      barcode: document.getElementById("prod-barcode").value,
      category: document.getElementById("prod-category").value,
      unit: document.getElementById("prod-unit").value,
      currentStock:
        parseFloat(document.getElementById("prod-stock").value) || 0,
      purchasePrice:
        parseFloat(document.getElementById("prod-cost").value) || 0,
      sellingPrice:
        parseFloat(document.getElementById("prod-price").value) || 0,
      minStockAlert: 5,
      updatedAt: serverTimestamp(),
    };

    try {
      if (product) {
        await updateDoc(doc(db, "products", product.id), prodData);
        showToast("Product updated!", "success");
      } else {
        prodData.createdAt = serverTimestamp();
        await addDoc(collection(db, "products"), prodData);
        showToast("Product added!", "success");
      }
      window.closeModal();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      toggleLoader(false);
    }
  };
};

window.editProductModal = (id) => {
  const p = state.products.find((item) => item.id === id);
  if (p) openProductModal(p);
};

window.deleteProduct = async (id) => {
  if (await showDeleteConfirmation("This product will be permanently removed from your inventory.")) {
    try {
      await deleteDoc(doc(db, "products", id));
      showToast("Product deleted.", "info");
    } catch (err) {
      showToast(err.message, "error");
    }
  }
};

// ==========================================================================
// 9. CUSTOMERS, SUPPLIERS, EXPENSES, PURCHASES MODALS
// ==========================================================================
const renderCustomersTable = () => {
  const tbody = document.getElementById("customers-table-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  const search =
    document.getElementById("customer-search-input")?.value.toLowerCase().trim() || "";

  state.customers.filter((c) =>
    [c.name, c.phone, c.cnic]
      .filter(Boolean)
      .some((value) => value.toString().toLowerCase().includes(search)),
  ).forEach((c) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${c.name}</strong></td>
      <td>${c.phone || "N/A"}</td>
      <td>${c.cnic || "N/A"}</td>
      <td><strong class="${c.balance > 0 ? "text-red" : "text-green"}">${formatCurrency(c.balance)}</strong></td>
      <td>
        <button class="btn btn-sm btn-secondary" onclick="window.openCustomerLedger('${c.id}')"><i class="fa-solid fa-book"></i> Ledger</button>
        <button class="btn btn-sm btn-secondary" onclick="window.editCustomerModal('${c.id}')"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-sm btn-accent" onclick="window.receiveCustomerPayment('${c.id}')"><i class="fa-solid fa-hand-holding-dollar"></i> Clear Udhaar</button>
        <button class="btn btn-sm btn-danger" onclick="window.deleteCustomer('${c.id}')"><i class="fa-solid fa-trash"></i></button>
      </td>
    `;
    tbody.appendChild(tr);
  });
};

const renderPosCustomerDropdown = () => {
  const select = document.getElementById("pos-customer-select");
  if (!select) return;
  select.innerHTML = `<option value="WALKIN">Walk-in Customer (Grahak)</option>`;
  state.customers.forEach((c) => {
    select.innerHTML += `<option value="${c.id}">${c.name} (${c.phone || "No Phone"}) - Bal: ${formatCurrency(c.balance)}</option>`;
  });
};

const openCustomerModal = (customer = null) => {
  // keep for backward compatibility
  if (!customer) {
    const name = prompt("Enter Customer Name:");
    if (!name) return;
    const phone = prompt("Enter Customer Phone (+92...):");
    addDoc(collection(db, "customers"), {
      businessId,
      name,
      phone: phone || "",
      balance: 0,
      createdAt: serverTimestamp(),
    }).then(() => showToast("Customer added!", "success"));
  } else {
    const newName =
      prompt("Edit Customer Name:", customer.name) || customer.name;
    const newPhone =
      prompt("Edit Customer Phone:", customer.phone || "") ||
      customer.phone ||
      "";
    const newCnic =
      prompt("Edit CNIC (optional):", customer.cnic || "") ||
      customer.cnic ||
      "";
    updateDoc(doc(db, "customers", customer.id), {
      name: newName,
      phone: newPhone,
      cnic: newCnic,
      updatedAt: serverTimestamp(),
    }).then(() => showToast("Customer updated!", "success"));
  }
};

// New: Customer Form Modal
const openCustomerFormModal = (customer = null) => {
  const modalContainer = document.getElementById("modal-container");
  const modalContent = document.getElementById("modal-content");
  if (!modalContainer || !modalContent) return;

  modalContent.innerHTML = `
    <div class="modal-header">
      <h3>${customer ? "Edit Customer" : "Add Customer"}</h3>
      <button class="icon-btn" onclick="window.closeModal()"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <form id="customer-form">
      <div class="modal-body">
        <div class="form-group">
          <label>Full Name *</label>
          <input type="text" id="cust-name" value="${customer ? customer.name : ""}" required>
        </div>
        <div class="form-group">
          <label>Phone</label>
          <input type="text" id="cust-phone" value="${customer ? customer.phone || "" : ""}">
        </div>
        <div class="form-group">
          <label>CNIC (optional)</label>
          <input type="text" id="cust-cnic" value="${customer ? customer.cnic || "" : ""}">
        </div>
        <div class="form-group">
          <label>Initial Balance (Udhaar)</label>
          <input type="number" id="cust-balance" value="${customer ? customer.balance || 0 : 0}" step="0.01">
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" onclick="window.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save Customer</button>
      </div>
    </form>
  `;

  modalContainer.classList.remove("hidden");

  document.getElementById("customer-form").onsubmit = async (e) => {
    e.preventDefault();
    toggleLoader(
      true,
      customer ? "Updating customer..." : "Saving customer...",
    );
    try {
      const data = {
        businessId,
        name: document.getElementById("cust-name").value,
        phone: document.getElementById("cust-phone").value || "",
        cnic: document.getElementById("cust-cnic").value || "",
        balance: parseFloat(document.getElementById("cust-balance").value) || 0,
        updatedAt: serverTimestamp(),
      };
      if (customer) {
        await updateDoc(doc(db, "customers", customer.id), data);
        showToast("Customer updated!", "success");
      } else {
        data.createdAt = serverTimestamp();
        await addDoc(collection(db, "customers"), data);
        showToast("Customer added!", "success");
      }
      window.closeModal();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      toggleLoader(false);
    }
  };
};

// wire the add customer button to the form modal
if (document.getElementById("add-customer-btn")) {
  document
    .getElementById("add-customer-btn")
    .addEventListener("click", () => openCustomerFormModal());
}

window.editCustomerModal = (id) => {
  const c = state.customers.find((x) => x.id === id);
  if (c) openCustomerFormModal(c);
};

window.deleteCustomer = async (id) => {
  if (await showDeleteConfirmation("This customer and their Udhaar record will be permanently removed.")) {
    await deleteDoc(doc(db, "customers", id));
    showToast("Customer deleted.", "info");
  }
};

window.receiveCustomerPayment = async (id) => {
  const cust = state.customers.find((c) => c.id === id);
  if (!cust) return;

  const modalContainer = document.getElementById("modal-container");
  const modalContent = document.getElementById("modal-content");
  if (!modalContainer || !modalContent) return;

  const today = new Date().toISOString().slice(0, 10);
  modalContent.innerHTML = `
    <div class="modal-header">
      <h3>Clear Udhaar</h3>
      <button class="icon-btn" onclick="window.closeModal()"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <form id="udhaar-payment-form">
      <div class="modal-body">
        <p>Customer: <strong>${cust.name}</strong></p>
        <p>Current Udhaar: <strong>${formatCurrency(cust.balance)}</strong></p>
        <div class="form-row">
          <div class="form-group">
            <label for="udhaar-from-date">From</label>
            <input type="date" id="udhaar-from-date" value="${today}" required>
          </div>
          <div class="form-group">
            <label for="udhaar-to-date">To</label>
            <input type="date" id="udhaar-to-date" value="${today}" required>
          </div>
        </div>
        <div class="form-group">
          <label for="udhaar-payment-amount">Received Amount (Rs.)</label>
          <input type="number" id="udhaar-payment-amount" min="0.01" max="${cust.balance}" step="0.01" required>
        </div>
        <div class="form-group">
          <label for="udhaar-payment-note">Payment Note / Details (Optional)</label>
          <textarea id="udhaar-payment-note" rows="3" maxlength="300" placeholder="Example: Paid in cash for weekly Udhaar"></textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" onclick="window.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-accent"><i class="fa-solid fa-hand-holding-dollar"></i> Clear Udhaar</button>
        <button type="submit" class="btn btn-primary" data-print-payment="true"><i class="fa-solid fa-print"></i> Save & Print</button>
      </div>
    </form>
  `;
  modalContainer.classList.remove("hidden");

  document.getElementById("udhaar-payment-form").onsubmit = async (event) => {
    event.preventDefault();
    const fromDate = document.getElementById("udhaar-from-date").value;
    const toDate = document.getElementById("udhaar-to-date").value;
    const amount = parseFloat(
      document.getElementById("udhaar-payment-amount").value,
    );
    const note = document.getElementById("udhaar-payment-note").value.trim();

    if (fromDate > toDate) {
      showToast("From date cannot be after To date.", "error");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > cust.balance) {
      showToast(
        "Enter a valid amount within the current Udhaar balance.",
        "error",
      );
      return;
    }

    const operationId = makeOperationId();
    const paymentPayload = {
      opId: operationId,
      businessId,
      customerId: id,
      customerName: cust.name,
      amount,
      fromDate,
      toDate,
      note,
      createdAt: new Date().toISOString(),
    };

    toggleLoader(true, "Recording Udhaar Payment...");
    try {
      if (!navigator.onLine) {
        await queueOfflineOperation("udhaarPayment", paymentPayload);
        window.closeModal();
        showToast("Udhaar payment saved offline. It will sync when internet returns.", "success");
        if (event.submitter?.dataset.printPayment === "true") {
          printReceivedPayment({ cust, amount, fromDate, toDate, note });
        }
        return;
      }

      await runTransaction(db, async (transaction) => {
        const customerRef = doc(db, "customers", id);
        const customerDoc = await transaction.get(customerRef);
        if (!customerDoc.exists()) throw new Error("Customer not found.");

        const currentBalance = customerDoc.data().balance || 0;
        if (amount > currentBalance)
          throw new Error("Payment exceeds current Udhaar balance.");

        const paymentRef = doc(collection(db, "udhaarPayments"));
        transaction.update(customerRef, {
          balance: Math.max(0, currentBalance - amount),
        });
        transaction.set(paymentRef, {
          businessId,
          customerId: id,
          customerName: cust.name,
          amount,
          fromDate,
          toDate,
          note,
          createdAt: serverTimestamp(),
        });
      });
      window.closeModal();
      showToast("Udhaar payment recorded!", "success");
      if (event.submitter?.dataset.printPayment === "true") {
        printReceivedPayment({ cust, amount, fromDate, toDate, note });
      }
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      toggleLoader(false);
    }
  };
};

const getLedgerDate = (entry) => {
  if (entry.fromDate) return entry.fromDate;
  return entry.createdAt?.toDate ? entry.createdAt.toDate().toISOString().slice(0, 10) : "";
};

const printReceivedPayment = ({ cust, amount, fromDate, toDate, note }) => {
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

window.openCustomerLedger = (id) => {
  const cust = state.customers.find((customer) => customer.id === id);
  if (!cust) return;

  const modalContainer = document.getElementById("modal-container");
  const modalContent = document.getElementById("modal-content");
  if (!modalContainer || !modalContent) return;

  const today = new Date().toISOString().slice(0, 10);
  const renderLedger = () => {
    const fromDate = document.getElementById("ledger-from-date")?.value || "";
    const toDate = document.getElementById("ledger-to-date")?.value || "";
    const entries = [
      ...state.sales
        .filter((sale) => sale.customerId === id && sale.balanceDue > 0)
        .map((sale) => ({ date: getLedgerDate(sale), type: "Credit Sale", detail: sale.invoiceNumber, amount: sale.balanceDue })),
      ...state.udhaarPayments
        .filter((payment) => payment.customerId === id)
        .map((payment) => ({ date: getLedgerDate(payment), type: "Received Payment", detail: `${payment.fromDate} to ${payment.toDate}${payment.note ? ` - ${payment.note}` : ""}`, amount: -payment.amount })),
    ]
      .filter((entry) => (!fromDate || entry.date >= fromDate) && (!toDate || entry.date <= toDate))
      .sort((a, b) => a.date.localeCompare(b.date));
    const totalCredit = entries.reduce((total, entry) => total + entry.amount, 0);
    const rows = entries.length
      ? entries.map((entry) => `<tr><td>${entry.date || "N/A"}</td><td>${entry.type}</td><td>${entry.detail}</td><td class="${entry.amount < 0 ? "text-green" : "text-red"}">${formatCurrency(Math.abs(entry.amount))}</td></tr>`).join("")
      : `<tr><td colspan="4">No ledger entries for this period.</td></tr>`;
    const body = document.getElementById("customer-ledger-body");
    const total = document.getElementById("customer-ledger-total");
    if (body) body.innerHTML = rows;
    if (total) total.textContent = formatCurrency(totalCredit);
  };

  modalContent.innerHTML = `
    <div class="modal-header"><h3>Udhaar Ledger: ${cust.name}</h3><button class="icon-btn" onclick="window.closeModal()"><i class="fa-solid fa-xmark"></i></button></div>
    <div class="modal-body">
      <div class="form-row"><div class="form-group"><label>From</label><input type="date" id="ledger-from-date" value=""></div><div class="form-group"><label>To</label><input type="date" id="ledger-to-date" value="${today}"></div></div>
      <div class="table-responsive"><table class="data-table"><thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Amount</th></tr></thead><tbody id="customer-ledger-body"></tbody></table></div>
      <p style="text-align:right;margin-top:12px"><strong>Period Balance: <span id="customer-ledger-total"></span></strong></p>
    </div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" onclick="window.closeModal()">Close</button><button type="button" class="btn btn-primary" id="print-customer-ledger"><i class="fa-solid fa-print"></i> Print Ledger</button></div>
  `;
  modalContainer.classList.remove("hidden");
  document.getElementById("ledger-from-date")?.addEventListener("change", renderLedger);
  document.getElementById("ledger-to-date")?.addEventListener("change", renderLedger);
  document.getElementById("print-customer-ledger")?.addEventListener("click", () => {
    const fromDate = document.getElementById("ledger-from-date")?.value || "Any date";
    const toDate = document.getElementById("ledger-to-date")?.value || "Any date";
    const printWindow = window.open("", "_blank", "width=700,height=700");
    if (!printWindow) return;
    printWindow.document.write(`<html><head><title>Udhaar Ledger - ${cust.name}</title><style>body{font-family:Arial;padding:24px}h2{text-align:center}table{width:100%;border-collapse:collapse}th,td{padding:10px;border:1px solid #ccc;text-align:left}.amount{text-align:right}</style></head><body><h2>Udhaar Ledger</h2><p><strong>Customer:</strong> ${cust.name}</p><p><strong>From:</strong> ${fromDate} &nbsp; <strong>To:</strong> ${toDate}</p><table>${document.querySelector("#customer-ledger-body")?.closest("table")?.innerHTML || ""}</table><p><strong>Current Udhaar: ${formatCurrency(cust.balance)}</strong></p></body></html>`);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  });
  renderLedger();
};

const renderSuppliersTable = () => {
  const tbody = document.getElementById("suppliers-table-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  const search =
    document.getElementById("supplier-search-input")?.value.toLowerCase().trim() || "";

  // Compute overall totals from purchases
  let overallPaid = 0;
  let overallPayable = 0;

  // Build a quick lookup of purchases grouped by supplierName
  const purchasesBySupplier = {};
  (state.purchases || []).forEach((p) => {
    const name = (p.supplierName || "").toString();
    if (!purchasesBySupplier[name]) purchasesBySupplier[name] = [];
    purchasesBySupplier[name].push(p);
  });

  state.suppliers.filter((s) =>
    [s.companyName, s.contactName, s.phone]
      .filter(Boolean)
      .some((value) => value.toString().toLowerCase().includes(search)),
  ).forEach((s) => {
    const company = s.companyName || "";
    // Sum paidAmount and balanceDue for this supplier from purchases
    const purList = purchasesBySupplier[company] || [];
    const supplierPaid = purList.reduce(
      (acc, curr) => acc + (curr.paidAmount || 0),
      0,
    );
    const supplierPayable =
      purList.reduce((acc, curr) => acc + (curr.balanceDue || 0), 0) ||
      s.balance ||
      0;

    overallPaid += supplierPaid;
    overallPayable += supplierPayable;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${s.companyName}</strong></td>
      <td>${s.contactName || "N/A"}</td>
      <td>${s.phone || "N/A"}</td>
      <td>${formatCurrency(supplierPaid)}</td>
      <td><strong class="text-red">${formatCurrency(supplierPayable)}</strong></td>
      <td>
        <button class="btn btn-sm btn-secondary" onclick="window.openSupplierLedger('${s.id}')"><i class="fa-solid fa-book"></i> Ledger</button>
        <button class="btn btn-sm btn-secondary" onclick="window.editSupplierModal('${s.id}')"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-sm btn-danger" onclick="window.deleteSupplier('${s.id}')"><i class="fa-solid fa-trash"></i></button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Update overall totals in the UI if present
  const totalPaidEl = document.getElementById("suppliers-total-paid");
  const totalPayableEl = document.getElementById("suppliers-total-payable");
  if (totalPaidEl) totalPaidEl.innerText = formatCurrency(overallPaid);
  if (totalPayableEl) totalPayableEl.innerText = formatCurrency(overallPayable);
};

window.openSupplierLedger = (id) => {
  const supplier = state.suppliers.find((item) => item.id === id);
  if (!supplier) return;

  const modalContainer = document.getElementById("modal-container");
  const modalContent = document.getElementById("modal-content");
  if (!modalContainer || !modalContent) return;

  const today = new Date().toISOString().slice(0, 10);
  const getPurchaseDate = (purchase) =>
    purchase.createdAt?.toDate
      ? purchase.createdAt.toDate().toISOString().slice(0, 10)
      : "";

  const renderLedger = () => {
    const fromDate = document.getElementById("supplier-ledger-from")?.value || "";
    const toDate = document.getElementById("supplier-ledger-to")?.value || "";
    const purchases = state.purchases
      .filter((purchase) => purchase.supplierId === id || purchase.supplierName === supplier.companyName)
      .map((purchase) => ({
        date: getPurchaseDate(purchase),
        invoiceNumber: purchase.invoiceNumber || "N/A",
        totalAmount: purchase.totalAmount || 0,
        paidAmount: purchase.paidAmount || 0,
        balanceDue: purchase.balanceDue || 0,
      }))
      .filter((purchase) => (!fromDate || purchase.date >= fromDate) && (!toDate || purchase.date <= toDate));

    const rows = purchases.length
      ? purchases.map((purchase) => `
        <tr><td>${purchase.date || "N/A"}</td><td>${purchase.invoiceNumber}</td><td>${formatCurrency(purchase.totalAmount)}</td><td class="text-green">${formatCurrency(purchase.paidAmount)}</td><td class="text-red">${formatCurrency(purchase.balanceDue)}</td></tr>
      `).join("")
      : `<tr><td colspan="5">No purchase entries for this period.</td></tr>`;
    const totalPurchases = purchases.reduce((sum, purchase) => sum + purchase.totalAmount, 0);
    const totalPaid = purchases.reduce((sum, purchase) => sum + purchase.paidAmount, 0);
    const totalDue = purchases.reduce((sum, purchase) => sum + purchase.balanceDue, 0);
    const body = document.getElementById("supplier-ledger-body");
    if (body) body.innerHTML = rows;
    const totals = document.getElementById("supplier-ledger-totals");
    if (totals) totals.innerHTML = `<strong>Purchases: ${formatCurrency(totalPurchases)}</strong> &nbsp; <strong class="text-green">Paid: ${formatCurrency(totalPaid)}</strong> &nbsp; <strong class="text-red">Payable: ${formatCurrency(totalDue)}</strong>`;
  };

  modalContent.innerHTML = `
    <div class="modal-header"><h3>Supplier Ledger: ${supplier.companyName}</h3><button class="icon-btn" onclick="window.closeModal()"><i class="fa-solid fa-xmark"></i></button></div>
    <div class="modal-body">
      <div class="form-row"><div class="form-group"><label>From</label><input type="date" id="supplier-ledger-from"></div><div class="form-group"><label>To</label><input type="date" id="supplier-ledger-to" value="${today}"></div></div>
      <div class="table-responsive"><table class="data-table"><thead><tr><th>Date</th><th>Invoice</th><th>Purchase</th><th>Paid</th><th>Payable</th></tr></thead><tbody id="supplier-ledger-body"></tbody></table></div>
      <p id="supplier-ledger-totals" style="text-align:right;margin-top:12px"></p>
    </div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" onclick="window.closeModal()">Close</button><button type="button" class="btn btn-primary" id="print-supplier-ledger"><i class="fa-solid fa-print"></i> Print Ledger</button></div>
  `;
  modalContainer.classList.remove("hidden");
  document.getElementById("supplier-ledger-from")?.addEventListener("change", renderLedger);
  document.getElementById("supplier-ledger-to")?.addEventListener("change", renderLedger);
  document.getElementById("print-supplier-ledger")?.addEventListener("click", () => {
    const printWindow = window.open("", "_blank", "width=800,height=700");
    if (!printWindow) return;
    printWindow.document.write(`<html><head><title>Supplier Ledger - ${supplier.companyName}</title><style>body{font-family:Arial;padding:24px}h2{text-align:center}table{width:100%;border-collapse:collapse}th,td{padding:10px;border:1px solid #ccc;text-align:left}</style></head><body><h2>Supplier Ledger</h2><p><strong>Supplier:</strong> ${supplier.companyName}</p><p><strong>From:</strong> ${document.getElementById("supplier-ledger-from")?.value || "Any date"} &nbsp; <strong>To:</strong> ${document.getElementById("supplier-ledger-to")?.value || "Any date"}</p><table><thead><tr><th>Date</th><th>Invoice</th><th>Purchase</th><th>Paid</th><th>Payable</th></tr></thead>${document.getElementById("supplier-ledger-body")?.innerHTML || ""}</table><p>${document.getElementById("supplier-ledger-totals")?.innerHTML || ""}</p></body></html>`);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  });
  renderLedger();
};

const openSupplierModal = (supplier = null) => {
  // kept for backward compatibility (prompt-based)
  if (!supplier) {
    const companyName = prompt("Supplier / Company Name:");
    if (!companyName) return;
    const phone = prompt("Phone Number:");
    addDoc(collection(db, "suppliers"), {
      businessId,
      companyName,
      phone: phone || "",
      balance: 0,
      createdAt: serverTimestamp(),
    }).then(() => showToast("Supplier saved!", "success"));
  } else {
    const companyName =
      prompt("Supplier / Company Name:", supplier.companyName) ||
      supplier.companyName;
    const phone =
      prompt("Phone Number:", supplier.phone || "") || supplier.phone || "";
    updateDoc(doc(db, "suppliers", supplier.id), {
      companyName,
      phone,
      updatedAt: serverTimestamp(),
    }).then(() => showToast("Supplier updated!", "success"));
  }
};

// New: Supplier Form Modal
const openSupplierFormModal = async (supplier = null) => {
  const modalContainer = document.getElementById("modal-container");
  const modalContent = document.getElementById("modal-content");
  if (!modalContainer || !modalContent) return;

  modalContent.innerHTML = `
    <div class="modal-header">
      <h3>${supplier ? "Edit Supplier" : "Add Supplier"}</h3>
      <button class="icon-btn" onclick="window.closeModal()"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <form id="supplier-form">
      <div class="modal-body">
        <div class="form-group">
          <label>Company Name *</label>
          <input type="text" id="sup-company" value="${supplier ? supplier.companyName : ""}" required>
        </div>
        <div class="form-group">
          <label>Contact Person</label>
          <input type="text" id="sup-contact" value="${supplier ? supplier.contactName || "" : ""}">
        </div>
        <div class="form-group">
          <label>Phone</label>
          <input type="text" id="sup-phone" value="${supplier ? supplier.phone || "" : ""}">
        </div>
        <div class="form-group">
          <label>Initial Payable Balance (Optional)</label>
          <input type="number" id="sup-balance" value="${supplier ? supplier.balance || 0 : 0}" step="0.01">
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" onclick="window.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save Supplier</button>
      </div>
    </form>
  `;

  modalContainer.classList.remove("hidden");

  document.getElementById("supplier-form").onsubmit = async (e) => {
    e.preventDefault();
    toggleLoader(
      true,
      supplier ? "Updating supplier..." : "Saving supplier...",
    );
    try {
      const data = {
        businessId,
        companyName: document.getElementById("sup-company").value,
        contactName: document.getElementById("sup-contact").value || "",
        phone: document.getElementById("sup-phone").value || "",
        balance: parseFloat(document.getElementById("sup-balance").value) || 0,
        updatedAt: serverTimestamp(),
      };
      if (supplier) {
        await updateDoc(doc(db, "suppliers", supplier.id), data);
        showToast("Supplier updated!", "success");
      } else {
        data.createdAt = serverTimestamp();
        await addDoc(collection(db, "suppliers"), data);
        showToast("Supplier added!", "success");
      }
      window.closeModal();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      toggleLoader(false);
    }
  };
};

window.editSupplierModal = (id) => {
  const s = state.suppliers.find((x) => x.id === id);
  if (s) openSupplierFormModal(s);
};

window.deleteSupplier = async (id) => {
  if (await showDeleteConfirmation("This supplier will be permanently removed.")) {
    await deleteDoc(doc(db, "suppliers", id));
    showToast("Supplier deleted.", "info");
  }
};

// Expense form modal
const openExpenseFormModal = (expense = null) => {
  const modalContainer = document.getElementById("modal-container");
  const modalContent = document.getElementById("modal-content");
  if (!modalContainer || !modalContent) return;

  modalContent.innerHTML = `
    <div class="modal-header">
      <h3>${expense ? "Edit Expense" : "Add Expense"}</h3>
      <button class="icon-btn" onclick="window.closeModal()"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <form id="expense-form">
      <div class="modal-body">
        <div class="form-group">
          <label>Title *</label>
          <input type="text" id="expense-title" value="${expense ? expense.title || "" : ""}" required>
        </div>
        <div class="form-group">
          <label>Category</label>
          <select id="expense-category">
            <option value="General">General</option>
            <option value="Utilities">Utilities</option>
            <option value="Rent">Rent</option>
            <option value="Salary">Salary</option>
            <option value="Other">Other</option>
          </select>
        </div>
        <div class="form-group">
          <label>Amount (Rs.) *</label>
          <input type="number" id="expense-amount" value="${expense ? expense.amount || 0 : ""}" required step="0.01">
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" onclick="window.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save Expense</button>
      </div>
    </form>
  `;

  if (expense && expense.category) {
    setTimeout(() => {
      const sel = document.getElementById("expense-category");
      if (sel) sel.value = expense.category;
    }, 0);
  }

  modalContainer.classList.remove("hidden");

  document.getElementById("expense-form").onsubmit = async (e) => {
    e.preventDefault();
    toggleLoader(true, expense ? "Updating expense..." : "Saving expense...");
    try {
      const title = document.getElementById("expense-title").value.trim();
      const category = document.getElementById("expense-category").value;
      const amount =
        parseFloat(document.getElementById("expense-amount").value) || 0;
      if (!title || isNaN(amount) || amount <= 0) {
        showToast("Please provide valid title and amount", "error");
        toggleLoader(false);
        return;
      }

      const data = {
        businessId,
        title,
        category,
        amount,
        updatedAt: serverTimestamp(),
      };
      if (expense) {
        await updateDoc(doc(db, "expenses", expense.id), data);
        showToast("Expense updated!", "success");
      } else {
        data.createdAt = serverTimestamp();
        await addDoc(collection(db, "expenses"), data);
        showToast("Expense recorded!", "success");
      }
      window.closeModal();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      toggleLoader(false);
    }
  };
};

// keep old alias for compatibility
const openExpenseModal = (expense = null) => openExpenseFormModal(expense);

const openPurchaseModal = (purchase = null) => {
  // keep for backward compatibility
  if (!purchase) {
    if (state.suppliers.length === 0) {
      showToast("Please add a supplier first!", "error");
      return;
    }
    const suppName = state.suppliers[0].companyName;
    const amount = parseFloat(
      prompt(`Enter purchase invoice total for supplier [${suppName}]:`),
    );
    if (isNaN(amount) || amount <= 0) return;

    addDoc(collection(db, "purchases"), {
      businessId,
      invoiceNumber: "PUR-" + Math.floor(1000 + Math.random() * 9000),
      supplierName: suppName,
      totalAmount: amount,
      paidAmount: amount,
      balanceDue: 0,
      createdAt: serverTimestamp(),
    }).then(() => showToast("Purchase stock invoice created!", "success"));
  } else {
    const paid = parseFloat(
      prompt("Update paid amount:", purchase.paidAmount || 0),
    );
    if (isNaN(paid)) return;
    const newBalance = Math.max(0, (purchase.totalAmount || 0) - paid);
    updateDoc(doc(db, "purchases", purchase.id), {
      paidAmount: paid,
      balanceDue: newBalance,
      updatedAt: serverTimestamp(),
    }).then(() => showToast("Purchase updated!", "success"));
  }
};

// New: Purchase Form Modal
const openPurchaseFormModal = (purchase = null) => {
  const modalContainer = document.getElementById("modal-container");
  const modalContent = document.getElementById("modal-content");
  if (!modalContainer || !modalContent) return;

  // Build supplier options
  const supplierOptions = (state.suppliers || [])
    .map(
      (s) =>
        `<option value="${s.id}" ${purchase && purchase.supplierId === s.id ? "selected" : ""}>${s.companyName}</option>`,
    )
    .join("");

  modalContent.innerHTML = `
    <div class="modal-header">
      <h3>${purchase ? "Edit Purchase" : "Record New Purchase"}</h3>
      <button class="icon-btn" onclick="window.closeModal()"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <form id="purchase-form">
      <div class="modal-body">
        <div class="form-group">
          <label>Supplier *</label>
          <select id="purchase-supplier" required>
            <option value="">Select Supplier</option>
            ${supplierOptions}
          </select>
        </div>
        <div class="form-group">
          <label>Invoice Number</label>
          <input type="text" id="purchase-inv" value="${purchase ? purchase.invoiceNumber : "PUR-" + Math.floor(1000 + Math.random() * 9000)}">
        </div>
        <div class="form-group">
          <label>Total Amount (Rs.) *</label>
          <input type="number" id="purchase-total" value="${purchase ? purchase.totalAmount || 0 : ""}" required step="0.01">
        </div>
        <div class="form-group">
          <label>Paid Amount (Rs.)</label>
          <input type="number" id="purchase-paid" value="${purchase ? purchase.paidAmount || 0 : ""}" step="0.01">
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" onclick="window.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save Purchase</button>
      </div>
    </form>
  `;

  modalContainer.classList.remove("hidden");

  document.getElementById("purchase-form").onsubmit = async (e) => {
    e.preventDefault();
    toggleLoader(
      true,
      purchase ? "Updating purchase..." : "Saving purchase...",
    );
    try {
      const supplierId = document.getElementById("purchase-supplier").value;
      if (!supplierId) {
        showToast("Please select supplier", "error");
        toggleLoader(false);
        return;
      }
      const supplier = state.suppliers.find((s) => s.id === supplierId) || {};
      const invoiceNumber =
        document.getElementById("purchase-inv").value ||
        "PUR-" + Math.floor(1000 + Math.random() * 9000);
      const totalAmount =
        parseFloat(document.getElementById("purchase-total").value) || 0;
      const paidAmount =
        parseFloat(document.getElementById("purchase-paid").value) || 0;
      const balanceDue = Math.max(0, totalAmount - paidAmount);

      const data = {
        businessId,
        invoiceNumber,
        supplierId,
        supplierName: supplier.companyName || "",
        totalAmount,
        paidAmount,
        balanceDue,
        updatedAt: serverTimestamp(),
      };

      if (purchase) {
        await updateDoc(doc(db, "purchases", purchase.id), data);
        showToast("Purchase updated!", "success");
      } else {
        data.createdAt = serverTimestamp();
        await addDoc(collection(db, "purchases"), data);
        showToast("Purchase created!", "success");
      }

      window.closeModal();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      toggleLoader(false);
    }
  };
};

window.editPurchaseModal = (id) => {
  const p = state.purchases.find((x) => x.id === id);
  if (p) openPurchaseFormModal(p);
};

window.deletePurchase = async (id) => {
  if (await showDeleteConfirmation("This purchase invoice will be permanently removed.")) {
    await deleteDoc(doc(db, "purchases", id));
    showToast("Purchase removed.", "info");
  }
};

const deleteRecordConfig = {
  products: {
    label: "Product",
    items: () => state.products,
    text: (item) => `${item.name} - ${item.barcode || item.sku || "No SKU"}`,
  },
  customers: {
    label: "Customer",
    items: () => state.customers,
    text: (item) => `${item.name} - ${item.phone || "No phone"}`,
  },
  suppliers: {
    label: "Supplier",
    items: () => state.suppliers,
    text: (item) => `${item.companyName} - ${item.phone || "No phone"}`,
  },
  purchases: {
    label: "Purchase Invoice",
    items: () => state.purchases,
    text: (item) => `${item.invoiceNumber || "No invoice"} - ${item.supplierName || "Unknown supplier"}`,
  },
  expenses: {
    label: "Expense",
    items: () => state.expenses,
    text: (item) => `${item.title} - ${formatCurrency(item.amount)}`,
  },
  sales: {
    label: "Sale / Invoice",
    items: () => state.sales,
    text: (item) => `${item.invoiceNumber || "No invoice"} - ${item.customerName || "Walk-in"}`,
  },
};

const renderDeleteRecords = () => {
  const typeSelect = document.getElementById("delete-record-type");
  const recordSelect = document.getElementById("delete-record-select");
  if (!typeSelect || !recordSelect) return;

  const type = typeSelect.value;
  const config = deleteRecordConfig[type];
  const search = document.getElementById("delete-record-search")?.value.toLowerCase().trim() || "";
  const previousValue = recordSelect.value;
  recordSelect.innerHTML = "";

  (config?.items() || [])
    .filter((item) => config.text(item).toLowerCase().includes(search))
    .forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = config.text(item);
      recordSelect.appendChild(option);
    });

  if ([...recordSelect.options].some((option) => option.value === previousValue)) {
    recordSelect.value = previousValue;
  }
};

const deleteSelectedRecord = async () => {
  const type = document.getElementById("delete-record-type")?.value;
  const recordId = document.getElementById("delete-record-select")?.value;
  const config = deleteRecordConfig[type];
  const item = config?.items().find((record) => record.id === recordId);
  if (!config || !item) {
    showToast("Select a record to delete.", "error");
    return;
  }

  if (!(await showDeleteConfirmation(`This ${config.label.toLowerCase()} will be permanently removed.`))) return;

  try {
    await deleteDoc(doc(db, type, recordId));
    showToast(`${config.label} deleted.`, "info");
    renderDeleteRecords();
  } catch (err) {
    showToast(`Unable to delete ${config.label.toLowerCase()}: ${err.message}`, "error");
  }
};

// ==========================================================================
// 10. REPORTS & UTILITIES
// ==========================================================================
const generateReport = () => {
  const start = document.getElementById("report-start-date")?.value;
  const end = document.getElementById("report-end-date")?.value;

  let filteredSales = state.sales;
  if (start && end) {
    filteredSales = state.sales.filter((s) => {
      const d = s.createdAt?.toDate
        ? s.createdAt.toDate().toISOString().split("T")[0]
        : "";
      return d >= start && d <= end;
    });
  }

  const totalSales = filteredSales.reduce(
    (acc, curr) => acc + (curr.grandTotal || 0),
    0,
  );
  const totalProfit = filteredSales.reduce(
    (acc, curr) => acc + (curr.totalProfit || 0),
    0,
  );
  const totalExpenses = state.expenses.reduce(
    (acc, curr) => acc + (curr.amount || 0),
    0,
  );

  document.getElementById("rep-total-sales").innerText =
    formatCurrency(totalSales);
  document.getElementById("rep-total-cogs").innerText = formatCurrency(
    totalSales - totalProfit,
  );
  document.getElementById("rep-total-expenses").innerText =
    formatCurrency(totalExpenses);
  document.getElementById("rep-net-profit").innerText = formatCurrency(
    totalProfit - totalExpenses,
  );
};

const seedDemoData = async () => {
  if (
    !confirm(
      "This will add demo items (Sugar, Atta, Rice, Milk, Oil, Tea) to your store inventory. Proceed?",
    )
  )
    return;
  toggleLoader(true, "Seeding Pakistani Retail Items...");

  const items = [
    {
      name: "Sugar (Cheeni)",
      category: "Grocery",
      unit: "KG",
      currentStock: 50,
      purchasePrice: 130,
      sellingPrice: 150,
    },
    {
      name: "Wheat Flour (Chakki Atta)",
      category: "Grocery",
      unit: "KG",
      currentStock: 100,
      purchasePrice: 110,
      sellingPrice: 125,
    },
    {
      name: "Basmati Rice (Chawal)",
      category: "Grocery",
      unit: "KG",
      currentStock: 40,
      purchasePrice: 280,
      sellingPrice: 320,
    },
    {
      name: "Olper's Milk 1L",
      category: "Dairy",
      unit: "Pack",
      currentStock: 24,
      purchasePrice: 260,
      sellingPrice: 290,
    },
    {
      name: "Dalda Cooking Oil 1L",
      category: "Grocery",
      unit: "Pack",
      currentStock: 15,
      purchasePrice: 500,
      sellingPrice: 540,
    },
    {
      name: "Tapal Danedar Tea 950g",
      category: "Snacks",
      unit: "Pack",
      currentStock: 10,
      purchasePrice: 1400,
      sellingPrice: 1550,
    },
  ];

  try {
    for (const item of items) {
      await addDoc(collection(db, "products"), {
        ...item,
        businessId,
        barcode: String(
          Math.floor(100000000000 + Math.random() * 900000000000),
        ),
        minStockAlert: 5,
        createdAt: serverTimestamp(),
      });
    }
    showToast("Pakistani demo inventory loaded!", "success");
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    toggleLoader(false);
  }
};

const exportProductsCSV = () => {
  let csv = "Barcode,Product Name,Category,Unit,Cost,Price,Stock\n";
  state.products.forEach((p) => {
    csv += `"${p.barcode || ""}","${p.name}","${p.category}","${p.unit}",${p.purchasePrice},${p.sellingPrice},${p.currentStock}\n`;
  });
  downloadCSV(csv, "products_export.csv");
};

const exportSalesCSV = () => {
  let csv = "Invoice Number,Customer,Grand Total,Payment Method,Date\n";
  state.sales.forEach((s) => {
    const d = s.createdAt?.toDate
      ? s.createdAt.toDate().toLocaleDateString()
      : "";
    csv += `"${s.invoiceNumber}","${s.customerName}",${s.grandTotal},"${s.paymentMethod}","${d}"\n`;
  });
  downloadCSV(csv, "sales_export.csv");
};

const downloadCSV = (content, filename) => {
  const blob = new Blob([content], { type: "text/csv" });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.setAttribute("href", url);
  a.setAttribute("download", filename);
  a.click();
};
