import { state, businessId, currentUser, keyboardNavigationState, makeOperationId, queueOfflineOperation } from "./state.js";
import { db } from "./firebase-init.js";
import { formatCurrency, showToast, toggleLoader, normalizeToStandardUnit, populatePrintWindowContent, saveInvoicePdf } from "./utils.js";
import { getCustomerName } from "./modules/customers.js";
import { renderProductsTable } from "./modules/products.js";
import { focusActiveProduct } from "./keyboard.js";
import { doc, collection, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// 7. POS TERMINAL ENGINE
// ==========================================================================
export const renderPosProducts = () => {
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
    card.tabIndex = -1;
    card.setAttribute("role", "option");
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

  focusActiveProduct(keyboardNavigationState.activeProductIndex, false);
};

export const addToCart = (product) => {
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

export const createInvoiceDraft = (number) => ({
  id: `invoice-${number}`,
  label: `Invoice ${number}`,
  cart: [],
  customerId: "WALKIN",
  customerSearch: "",
  walkinCustomerName: "",
  discount: 0,
  tax: 0,
  paidAmount: "",
  paymentMethod: "Cash",
  printFormat: "thermal",
});

export const getActiveInvoiceDraft = () =>
  state.invoiceDrafts.find((draft) => draft.id === state.activeInvoiceId);

export const captureActiveInvoiceDraft = () => {
  const draft = getActiveInvoiceDraft();
  if (!draft) return;

  draft.cart = state.cart.map((item) => ({ ...item }));
  draft.customerId = document.getElementById("pos-customer-select")?.value || "WALKIN";
  draft.customerSearch = document.getElementById("pos-customer-search")?.value || "";
  draft.walkinCustomerName = document.getElementById("pos-walkin-customer-name")?.value || "";
  draft.discount = document.getElementById("pos-discount-input")?.value || "0";
  draft.tax = document.getElementById("pos-tax-input")?.value || "0";
  draft.paidAmount = document.getElementById("pos-paid-amount")?.value || "";
  draft.paymentMethod = document.getElementById("pos-payment-method")?.value || "Cash";
  draft.printFormat = document.getElementById("pos-print-format")?.value || "thermal";
  const customer = state.customers.find((item) => item.id === draft.customerId);
  const walkinNameInput = document.getElementById("pos-walkin-customer-name");
  draft.customerName = customer?.name || (draft.customerId === "WALKIN" ? (walkinNameInput?.value?.trim() || "Walk-in Customer") : "Walk-in Customer");
};

export const renderOpenInvoiceDrafts = () => {
  const container = document.getElementById("open-invoice-drafts");
  if (!container) return;
  container.innerHTML = state.invoiceDrafts.map((draft) => `
    <div class="invoice-draft-tab ${draft.id === state.activeInvoiceId ? "active" : ""}">
      <button class="invoice-draft-tab-main" type="button" onclick="window.switchInvoiceDraft('${draft.id}')">
        <span>${draft.label}</span>
        <small>${draft.customerName || "Walk-in Customer"} · ${draft.cart.length} item${draft.cart.length === 1 ? "" : "s"}</small>
      </button>
      <button class="invoice-draft-remove" type="button" title="Remove this open invoice" aria-label="Remove ${draft.label}" onclick="window.removeInvoiceDraft('${draft.id}')"><i class="fa-solid fa-xmark"></i></button>
    </div>
  `).join("");
};

export const applyInvoiceDraft = (draft) => {
  if (!draft) return;
  state.cart = draft.cart.map((item) => ({ ...item }));
  const customerSearch = document.getElementById("pos-customer-search");
  const customerSelect = document.getElementById("pos-customer-select");
  if (customerSearch) customerSearch.value = draft.customerSearch || "";
  renderPosCustomerDropdown();
  if (customerSelect) customerSelect.value = draft.customerId || "WALKIN";
  const walkinNameInput = document.getElementById("pos-walkin-customer-name");
  if (walkinNameInput && draft.customerId === "WALKIN") {
    walkinNameInput.value = draft.walkinCustomerName || "";
    walkinNameInput.style.display = "block";
  }
  const setValue = (id, value) => {
    const element = document.getElementById(id);
    if (element) element.value = value;
  };
  setValue("pos-discount-input", draft.discount ?? 0);
  setValue("pos-tax-input", draft.tax ?? 0);
  setValue("pos-paid-amount", draft.paidAmount ?? "");
  setValue("pos-payment-method", draft.paymentMethod || "Cash");
  setValue("pos-print-format", draft.printFormat || "thermal");
  renderCart();
  renderOpenInvoiceDrafts();
};

export const startNewInvoiceDraft = () => {
  captureActiveInvoiceDraft();
  const nextDraft = createInvoiceDraft(state.nextInvoiceDraftNumber);
  state.nextInvoiceDraftNumber += 1;
  state.invoiceDrafts.push(nextDraft);
  state.activeInvoiceId = nextDraft.id;
  applyInvoiceDraft(nextDraft);
  showToast("New invoice opened. Your previous invoice is saved here.", "success");
};

window.switchInvoiceDraft = (draftId) => {
  if (draftId === state.activeInvoiceId) return;
  captureActiveInvoiceDraft();
  const draft = state.invoiceDrafts.find((item) => item.id === draftId);
  if (!draft) return;
  state.activeInvoiceId = draftId;
  applyInvoiceDraft(draft);
};

window.removeInvoiceDraft = async (draftId) => {
  const draft = state.invoiceDrafts.find((item) => item.id === draftId);
  if (!draft) return;

  if (!(await showDeleteConfirmation(`${draft.label} and its unsaved cart will be removed.`))) return;

  if (state.invoiceDrafts.length === 1) {
    const freshDraft = createInvoiceDraft(draft.label.replace("Invoice ", "") || 1);
    state.invoiceDrafts[0] = freshDraft;
    state.activeInvoiceId = freshDraft.id;
    applyInvoiceDraft(freshDraft);
    showToast("The last open invoice was cleared.", "info");
    return;
  }

  const wasActive = state.activeInvoiceId === draftId;
  state.invoiceDrafts = state.invoiceDrafts.filter((item) => item.id !== draftId);
  const activeDraft = state.invoiceDrafts.find((item) => item.id === state.activeInvoiceId);
  state.invoiceDrafts.forEach((item, index) => {
    item.id = `invoice-${index + 1}`;
    item.label = `Invoice ${index + 1}`;
  });
  state.nextInvoiceDraftNumber = state.invoiceDrafts.length + 1;
  if (wasActive) {
    state.activeInvoiceId = state.invoiceDrafts[0].id;
    applyInvoiceDraft(state.invoiceDrafts[0]);
  } else if (activeDraft) {
    state.activeInvoiceId = activeDraft.id;
    renderOpenInvoiceDrafts();
  } else {
    state.activeInvoiceId = state.invoiceDrafts[0].id;
    renderOpenInvoiceDrafts();
  }
  showToast(`${draft.label} removed.`, "info");
};

export const finishActiveInvoiceDraft = () => {
  state.invoiceDrafts = state.invoiceDrafts.filter((draft) => draft.id !== state.activeInvoiceId);
  if (state.invoiceDrafts.length === 0) {
    const newDraft = createInvoiceDraft(state.nextInvoiceDraftNumber);
    state.nextInvoiceDraftNumber += 1;
    state.invoiceDrafts.push(newDraft);
  }
  state.activeInvoiceId = state.invoiceDrafts[0].id;
  applyInvoiceDraft(state.invoiceDrafts[0]);
};

export const renderCart = () => {
  const container = document.getElementById("pos-cart-items");
  if (!container) return;
  container.innerHTML = "";

  if (state.cart.length === 0) {
    container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-basket-shopping"></i><p>Cart is empty.</p></div>`;
    calculateCartTotals();
    captureActiveInvoiceDraft();
    renderOpenInvoiceDrafts();
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
        <label class="cart-item-rate">
          Rate / ${item.unit}
          <input type="number" min="0" step="0.01" value="${item.sellingPrice}"
                 onchange="window.updateCartRate(${index}, this.value)" aria-label="Rate for ${item.name}">
        </label>
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
  captureActiveInvoiceDraft();
  renderOpenInvoiceDrafts();
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

window.updateCartRate = (index, val) => {
  const parsed = parseFloat(val);
  if (isNaN(parsed) || parsed < 0) {
    showToast("Enter a valid rate.", "error");
    renderCart();
    return;
  }
  state.cart[index].sellingPrice = parsed;
  renderCart();
};

window.removeCartItem = (index) => {
  state.cart.splice(index, 1);
  renderCart();
};

export const calculateCartTotals = () => {
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
      const customerName = getCustomerName();
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
        const newSaleRef = doc(db, "sales", operationId);

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

      finishActiveInvoiceDraft();
    } catch (err) {
      if (!navigator.onLine || ["unavailable", "deadline-exceeded", "network-request-failed"].includes(err.code)) {
        await queueOfflineOperation("sale", salePayload);
        showToast(`Sale saved offline as ${localInvoiceNumber}. It will sync when internet returns.`, "success");
        populatePrintWindowContent(printWindow, {
          ...salePayload,
          invoiceNumber: localInvoiceNumber,
          items: saleItems,
        }, format, true);
        finishActiveInvoiceDraft();
        return;
      }
      if (printWindow) printWindow.close();
      showToast(err.message, "error");
    } finally {
      toggleLoader(false);
    }
  });

// ==========================================================================
