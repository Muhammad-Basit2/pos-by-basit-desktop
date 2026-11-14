import { state, businessId } from "../state.js";
import { db } from "../firebase-init.js";
import { formatCurrency, showDeleteConfirmation, toggleLoader, showToast } from "../utils.js";
import { renderProductsTable } from "./products.js";
import { renderCustomersTable } from "./customers.js";
import { renderSalesHistoryTable } from "../main.js";
import { refreshDashboard } from "./reports.js";
import { doc, collection, addDoc, updateDoc, deleteDoc, setDoc, getDoc, query, where, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

export const renderPurchasesTable = () => {
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

export const renderSuppliersTable = () => {
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
    <div class="modal-footer"><button type="button" class="btn btn-secondary" onclick="window.closeModal()">Close</button><button type="button" class="btn btn-primary" id="print-supplier-ledger"><i class="fa-solid fa-print"></i> Print Ledger</button><button type="button" class="btn btn-secondary" id="print-supplier-ledger-thermal"><i class="fa-solid fa-receipt"></i> Print Thermal</button></div>
  `;
  modalContainer.classList.remove("hidden");
  document.getElementById("supplier-ledger-from")?.addEventListener("change", renderLedger);
  document.getElementById("supplier-ledger-to")?.addEventListener("change", renderLedger);
  const printSupplierLedger = (thermal = false) => {
    const printWindow = window.open("", "_blank", thermal ? "width=400,height=700" : "width=800,height=700");
    if (!printWindow) return;
    const pageStyle = thermal
      ? `@page{size:80mm auto;margin:3mm}body{width:80mm;box-sizing:border-box;font-family:monospace;font-size:10px;margin:0;padding:4px;color:#111}h2{text-align:center;font-size:15px;margin:0 0 8px}.details{line-height:1.5;margin-bottom:8px}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{padding:4px 1px;border-bottom:1px dashed #111;text-align:left;word-break:break-word}th{font-size:9px}td{font-size:9px}th:nth-child(1),td:nth-child(1){width:19%}th:nth-child(2),td:nth-child(2){width:21%}th:nth-child(3),td:nth-child(3){width:20%;text-align:right}th:nth-child(4),td:nth-child(4){width:20%;text-align:right}th:nth-child(5),td:nth-child(5){width:20%;text-align:right}.totals{border-top:1px solid #111;margin-top:8px;padding-top:6px;font-size:10px}`
      : `body{font-family:Arial;padding:24px}h2{text-align:center}table{width:100%;border-collapse:collapse}th,td{padding:10px;border:1px solid #ccc;text-align:left}`;
    printWindow.document.write(`<html><head><title>Supplier Ledger - ${supplier.companyName}</title><style>${pageStyle}</style></head><body><h2>Supplier Ledger</h2><div class="details"><strong>Supplier:</strong> ${supplier.companyName}<br><strong>From:</strong> ${document.getElementById("supplier-ledger-from")?.value || "Any date"}<br><strong>To:</strong> ${document.getElementById("supplier-ledger-to")?.value || "Any date"}</div><table><thead><tr><th>Date</th><th>Invoice</th><th>Purchase</th><th>Paid</th><th>Payable</th></tr></thead>${document.getElementById("supplier-ledger-body")?.innerHTML || ""}</table><div class="totals">${document.getElementById("supplier-ledger-totals")?.innerHTML || ""}</div></body></html>`);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  };
  document.getElementById("print-supplier-ledger")?.addEventListener("click", () => printSupplierLedger(false));
  document.getElementById("print-supplier-ledger-thermal")?.addEventListener("click", () => printSupplierLedger(true));
  renderLedger();
};

export const openSupplierModal = (supplier = null) => {
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
export const openSupplierFormModal = async (supplier = null) => {
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
export const openPurchaseModal = (purchase = null) => {
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
export const openPurchaseFormModal = (purchase = null) => {
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
        state.purchases = state.purchases.map((item) =>
          item.id === purchase.id
            ? { ...item, ...data, id: purchase.id, createdAt: item.createdAt || new Date() }
            : item,
        );
        renderPurchasesTable();
        refreshDashboard();
        window.closeModal();
        toggleLoader(false);
        updateDoc(doc(db, "purchases", purchase.id), data).catch((err) =>
          showToast(`Purchase sync failed: ${err.message}`, "error"),
        );
        showToast("Purchase updated!", "success");
      } else {
        data.createdAt = serverTimestamp();
        const purchaseRef = doc(collection(db, "purchases"));
        state.purchases.push({
          ...data,
          id: purchaseRef.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        renderPurchasesTable();
        refreshDashboard();
        window.closeModal();
        toggleLoader(false);
        setDoc(purchaseRef, data).catch((err) =>
          showToast(`Purchase sync failed: ${err.message}`, "error"),
        );
        showToast("Purchase created!", "success");
      }
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

export const deleteRecordConfig = {
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

export const renderDeleteRecords = () => {
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

export const deleteSelectedRecord = async () => {
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
