import { db } from "./firebase-init.js";
import { showToast } from "./utils.js";
import { renderPosProducts } from "./pos.js";
import { renderProductsTable } from "./modules/products.js";
import { renderCustomersTable, renderPosCustomerDropdown } from "./modules/customers.js";
import { renderSalesHistoryTable } from "./main.js";
import { refreshDashboard } from "./modules/reports.js";
import { doc, onSnapshot, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

export let currentUser = null;
export let currentBusiness = null;
export let businessId = null;

export const state = {
  products: [],
  categories: ["Grocery", "Beverages", "Dairy", "Bakery", "Snacks", "Household"],
  customers: [],
  suppliers: [],
  sales: [],
  purchases: [],
  expenses: [],
  udhaarPayments: [],
  cart: [],
  invoiceDrafts: [],
  activeInvoiceId: "invoice-1",
  nextInvoiceDraftNumber: 2,
  selectedCategory: "ALL",
  posSearchQuery: "",
  inventoryStockFilter: "",
};

export const chartInstances = { sales: null, topProducts: null };
let pendingListenerCount = 0;
let queuedOperationCount = 0;
let syncingOutbox = false;

export const keyboardNavigationState = {
  activeProductIndex: 0,
  lastProductElement: null,
  modalFocusElement: null,
  inventoryRowIndex: 0,
  inventoryActionIndex: 0,
};

const OUTBOX_DB_NAME = "pos-by-basit-outbox";
const OUTBOX_STORE_NAME = "operations";
let outboxDatabasePromise = null;

const openOutbox = () => {
  if (outboxDatabasePromise) return outboxDatabasePromise;
  outboxDatabasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(OUTBOX_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(OUTBOX_STORE_NAME, { keyPath: "opId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      outboxDatabasePromise = null;
      reject(request.error);
    };
  });
  return outboxDatabasePromise;
};

const readOutbox = async () => {
  const database = await openOutbox();
  return new Promise((resolve, reject) => {
    const request = database.transaction(OUTBOX_STORE_NAME, "readonly").objectStore(OUTBOX_STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
};

const writeOutboxOperation = async (operation) => {
  const database = await openOutbox();
  return new Promise((resolve, reject) => {
    const request = database.transaction(OUTBOX_STORE_NAME, "readwrite").objectStore(OUTBOX_STORE_NAME).put(operation);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

const removeOutboxOperation = async (opId) => {
  const database = await openOutbox();
  return new Promise((resolve, reject) => {
    const request = database.transaction(OUTBOX_STORE_NAME, "readwrite").objectStore(OUTBOX_STORE_NAME).delete(opId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export const refreshOutboxStatus = async () => {
  try {
    const operations = await readOutbox();
    queuedOperationCount = operations.filter((operation) => operation.status !== "synced").length;
  } catch (err) {
    queuedOperationCount = 0;
  }
  updateConnectionStatus();
};

export const updateConnectionStatus = () => {
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

export const subscribeToQuery = (queryRef, onData, onError) => {
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

export const commitSaleOperation = async (payload) => {
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

export const commitPaymentOperation = async (payload) => {
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

export const syncOutbox = async () => {
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
        const isNetworkError = !navigator.onLine || ["unavailable", "deadline-exceeded", "network-request-failed"].includes(err.code);
        await writeOutboxOperation({
          ...syncingOperation,
          status: isNetworkError ? "queued" : "failed",
          error: err.message,
        });
        showToast(`Sync failed: ${err.message}`, "error");
      }
      await refreshOutboxStatus();
    }
  } finally {
    syncingOutbox = false;
    await refreshOutboxStatus();
  }
};

export const makeOperationId = () => `${Date.now()}-${crypto.randomUUID()}`;

export const applyLocalOperation = (operation) => {
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
    renderPosCustomerDropdown();
    refreshDashboard();
  }
};

export const queueOfflineOperation = async (type, payload) => {
  const operation = { opId: payload.opId || makeOperationId(), type, payload, status: "queued", attempts: 0, createdAt: new Date().toISOString() };
  applyLocalOperation(operation);
  queuedOperationCount += 1;
  updateConnectionStatus();
  await writeOutboxOperation(operation);
  return operation;
};

export const restorePendingOperations = async () => {
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

export const setCurrentUser = (user) => { currentUser = user; };
export const setCurrentBusiness = (business) => { currentBusiness = business; };
export const setBusinessId = (id) => { businessId = id; };

