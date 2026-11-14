import { state, businessId, makeOperationId, queueOfflineOperation } from "../state.js";
import { db } from "../firebase-init.js";
import { formatCurrency, showDeleteConfirmation, toggleLoader, showToast, printReceivedPayment } from "../utils.js";
import { refreshDashboard } from "./reports.js";
import { exportToExcel, importSpreadsheet } from "./products.js";
import { doc, collection, addDoc, updateDoc, setDoc, deleteDoc, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

export const renderCustomersTable = () => {
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
        <button class="btn btn-sm btn-danger" title="Remove customer" aria-label="Remove customer" onclick="window.deleteCustomer('${c.id}')"><i class="fa-solid fa-trash"></i> Remove</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
};

export const getCustomerName = () => {
  const select = document.getElementById("pos-customer-select");
  const walkinInput = document.getElementById("pos-walkin-customer-name");
  const customerId = select?.value || "WALKIN";
  if (customerId === "WALKIN") {
    return (walkinInput?.value || "").trim() || "Walk-in Customer";
  }
  const customerObj = state.customers.find((c) => c.id === customerId);
  return customerObj?.name || "Unknown Customer";
};

export const renderPosCustomerDropdown = () => {
  const select = document.getElementById("pos-customer-select");
  const walkinInput = document.getElementById("pos-walkin-customer-name");
  if (!select) return;
  select.innerHTML = `<option value="WALKIN">Walk-in Customer (Grahak)</option>`;
  state.customers.forEach((c) => {
    select.innerHTML += `<option value="${c.id}">${c.name} (${c.phone || "No Phone"}) - Bal: ${formatCurrency(c.balance)}</option>`;
  });
  // Show/hide walk-in name input based on selection
  if (walkinInput) {
    walkinInput.style.display = select.value === "WALKIN" ? "block" : "none";
  }
};

export const openCustomerModal = (customer = null) => {
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
export const openCustomerFormModal = (customer = null) => {
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
        const updatedCustomer = { ...customer, ...data, id: customer.id };
        state.customers = state.customers.map((item) =>
          item.id === customer.id ? updatedCustomer : item,
        );
        renderCustomersTable();
        renderPosCustomerDropdown();
        refreshDashboard();
        window.closeModal();
        toggleLoader(false);
        updateDoc(doc(db, "customers", customer.id), data).catch((err) =>
          showToast(`Customer sync failed: ${err.message}`, "error"),
        );
        showToast("Customer updated!", "success");
      } else {
        data.createdAt = serverTimestamp();
        const customerRef = doc(collection(db, "customers"));
        state.customers.push({
          ...data,
          id: customerRef.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        renderCustomersTable();
        renderPosCustomerDropdown();
        refreshDashboard();
        window.closeModal();
        toggleLoader(false);
        setDoc(customerRef, data).catch((err) =>
          showToast(`Customer sync failed: ${err.message}`, "error"),
        );
        showToast("Customer added!", "success");
      }
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
    state.customers = state.customers.filter((customer) => customer.id !== id);
    renderCustomersTable();
    renderPosCustomerDropdown();
    refreshDashboard();
    deleteDoc(doc(db, "customers", id)).catch((err) =>
      showToast(`Customer delete sync failed: ${err.message}`, "error"),
    );
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

        const paymentRef = doc(db, "udhaarPayments", operationId);
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
      if (!navigator.onLine || ["unavailable", "deadline-exceeded", "network-request-failed"].includes(err.code)) {
        await queueOfflineOperation("udhaarPayment", paymentPayload);
        window.closeModal();
        showToast("Udhaar payment saved offline. It will sync when internet returns.", "success");
        if (event.submitter?.dataset.printPayment === "true") {
          printReceivedPayment({ cust, amount, fromDate, toDate, note });
        }
        return;
      }
      showToast(err.message, "error");
    } finally {
      toggleLoader(false);
    }
  };
};

export const getLedgerDate = (entry) => {
  if (entry.fromDate) return entry.fromDate;
  return entry.createdAt?.toDate ? entry.createdAt.toDate().toISOString().slice(0, 10) : "";
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
    <div class="modal-footer"><button type="button" class="btn btn-secondary" onclick="window.closeModal()">Close</button><button type="button" class="btn btn-primary" id="print-customer-ledger"><i class="fa-solid fa-print"></i> Print Ledger</button><button type="button" class="btn btn-secondary" id="print-customer-ledger-thermal"><i class="fa-solid fa-receipt"></i> Print Thermal</button></div>
  `;
  modalContainer.classList.remove("hidden");
  document.getElementById("ledger-from-date")?.addEventListener("change", renderLedger);
  document.getElementById("ledger-to-date")?.addEventListener("change", renderLedger);
  const printCustomerLedger = (thermal = false) => {
    const fromDate = document.getElementById("ledger-from-date")?.value || "Any date";
    const toDate = document.getElementById("ledger-to-date")?.value || "Any date";
    const printWindow = window.open("", "_blank", thermal ? "width=400,height=700" : "width=700,height=700");
    if (!printWindow) return;
    const pageStyle = thermal
      ? `@page{size:80mm auto;margin:3mm}body{width:80mm;box-sizing:border-box;font-family:monospace;font-size:10px;margin:0;padding:4px;color:#111}h2{text-align:center;font-size:15px;margin:0 0 8px}.details{line-height:1.5;margin-bottom:8px}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{padding:4px 1px;border-bottom:1px dashed #111;text-align:left;word-break:break-word}th{font-size:9px}td{font-size:9px}th:nth-child(1),td:nth-child(1){width:19%}th:nth-child(2),td:nth-child(2){width:24%}th:nth-child(3),td:nth-child(3){width:37%}th:nth-child(4),td:nth-child(4){width:20%;text-align:right}.balance{border-top:1px solid #111;margin-top:8px;padding-top:6px;font-size:10px}`
      : `body{font-family:Arial;padding:24px}h2{text-align:center}table{width:100%;border-collapse:collapse}th,td{padding:10px;border:1px solid #ccc;text-align:left}.amount{text-align:right}`;
    printWindow.document.write(`<html><head><title>Udhaar Ledger - ${cust.name}</title><style>${pageStyle}</style></head><body><h2>Udhaar Ledger</h2><div class="details"><strong>Customer:</strong> ${cust.name}<br><strong>From:</strong> ${fromDate}<br><strong>To:</strong> ${toDate}</div><table>${document.querySelector("#customer-ledger-body")?.closest("table")?.innerHTML || ""}</table><div class="balance"><strong>Current Udhaar: ${formatCurrency(cust.balance)}</strong></div></body></html>`);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  };
  document.getElementById("print-customer-ledger")?.addEventListener("click", () => printCustomerLedger(false));
  document.getElementById("print-customer-ledger-thermal")?.addEventListener("click", () => printCustomerLedger(true));
  renderLedger();
};

export const exportCustomersExcel = () => {
  exportToExcel(
    state.customers.map((customer) => ({
      Name: customer.name || "",
      Phone: customer.phone || "",
      CNIC: customer.cnic || "",
      Balance: customer.balance || 0,
    })),
    "Customers",
    "customers_export.xlsx",
  );
};

export const importCustomersSpreadsheet = (file) => importSpreadsheet(file, "customers");
