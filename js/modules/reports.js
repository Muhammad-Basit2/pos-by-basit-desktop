import { state, businessId, currentUser, currentBusiness, setCurrentBusiness, chartInstances } from "../state.js";
import { db } from "../firebase-init.js";
import { formatCurrency, showToast, toggleLoader } from "../utils.js";
import { renderProductsTable } from "./products.js";
import { downloadCSV } from "./products.js";
import { renderPosProducts } from "../pos.js";
import { renderCustomersTable } from "./customers.js";
import { renderSuppliersTable, renderPurchasesTable } from "./suppliers.js";
import { renderSalesHistoryTable } from "../main.js";
import { doc, collection, addDoc, updateDoc, deleteDoc, setDoc, getDoc, query, where, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// 6. DASHBOARD & CHARTS MODULE
// ==========================================================================
export const updateDashboardMetrics = () => {
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

export function refreshDashboard() {
  updateDashboardMetrics();
  renderCharts();
}

export const renderCharts = () => {
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

    if (chartInstances.sales) chartInstances.sales.destroy();
    chartInstances.sales = new Chart(ctxSales, {
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

    if (chartInstances.topProducts) chartInstances.topProducts.destroy();
    chartInstances.topProducts = new Chart(ctxTop, {
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

// 10. REPORTS & UTILITIES
// ==========================================================================
export const generateReport = () => {
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

export const seedDemoData = async () => {
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

export const deleteAllStock = async () => {
  if (state.products.length === 0) {
    showToast("There is no stock to delete.", "info");
    return;
  }

  const confirmed = await showDeleteConfirmation(
    `All ${state.products.length} stock item${state.products.length === 1 ? "" : "s"} will be permanently deleted. Sales and purchase records will remain.`,
  );
  if (!confirmed) return;

  toggleLoader(true, "Deleting all stock...");
  try {
    await Promise.all(
      state.products.map((product) => deleteDoc(doc(db, "products", product.id))),
    );
    state.products = [];
    state.cart = [];
    renderProductsTable();
    renderPosProducts();
    renderCart();
    showToast("All stock deleted.", "info");
  } catch (err) {
    showToast(`Unable to delete all stock: ${err.message}`, "error");
  } finally {
    toggleLoader(false);
  }
};

export const exportSalesCSV = () => {
  let csv = "Invoice Number,Customer,Grand Total,Payment Method,Date\n";
  state.sales.forEach((s) => {
    const d = s.createdAt?.toDate
      ? s.createdAt.toDate().toLocaleDateString()
      : "";
    csv += `"${s.invoiceNumber}","${s.customerName}",${s.grandTotal},"${s.paymentMethod}","${d}"\n`;
  });
  downloadCSV(csv, "sales_export.csv");
};

export const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

export const exportRecordsPDF = async (type) => {
  const isCustomers = type === "customers";
  const title = isCustomers ? "Customers" : "Stock Inventory";
  const filename = isCustomers ? "customers_export" : "stock_export";
  const columns = isCustomers
    ? ["Name", "Phone", "CNIC", "Balance"]
    : ["Barcode", "Product Name", "Category", "Unit", "Cost", "Price", "Stock"];
  const rows = isCustomers
    ? state.customers.map((customer) => [
      customer.name || "",
      customer.phone || "",
      customer.cnic || "",
      formatCurrency(customer.balance || 0),
    ])
    : state.products.map((product) => [
      product.barcode || product.sku || "",
      product.name || "",
      product.category || "",
      product.unit || "",
      formatCurrency(product.purchasePrice || 0),
      formatCurrency(product.sellingPrice || 0),
      product.currentStock || 0,
    ]);
  const tableRows = rows.map((row) =>
    `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
  ).join("");
  const tableHeaders = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
  const html = `
    <html>
      <head>
        <meta charset="utf-8">
        <title>${escapeHtml(title)}</title>
        <style>
          @page { size: A4 portrait; margin: 12mm; }
          body { font-family: Arial, sans-serif; color: #17212b; }
          h1 { color: #0f766e; margin-bottom: 4px; }
          p { color: #64748b; margin-top: 0; }
          table { width: 100%; border-collapse: collapse; margin-top: 20px; }
          th { background: #0f766e; color: #fff; text-align: left; }
          th, td { border: 1px solid #dbe4e8; padding: 8px; font-size: 11px; }
          tr:nth-child(even) { background: #f8fafb; }
        </style>
      </head>
      <body>
        <h1>${escapeHtml(currentBusiness?.shopName || "POS By Basit")}</h1>
        <p>${escapeHtml(title)} | ${escapeHtml(new Date().toLocaleDateString())}</p>
        <table><thead><tr>${tableHeaders}</tr></thead><tbody>${tableRows || `<tr><td colspan="${columns.length}">No records found.</td></tr>`}</tbody></table>
      </body>
    </html>`;
  const ipcRenderer = window.require?.("electron")?.ipcRenderer;
  if (!ipcRenderer) {
    const printWindow = window.open("", "_blank", "width=900,height=700");
    if (!printWindow) return;
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
    return;
  }
  try {
    const result = await ipcRenderer.invoke("save-invoice-pdf", {
      html,
      invoiceNumber: filename,
      format: "A4",
    });
    if (!result?.canceled) showToast(`${title} PDF saved locally.`, "success");
  } catch (error) {
    showToast(`Unable to export ${title.toLowerCase()} PDF: ${error.message}`, "error");
  }
};



export const renderExpensesTable = () => {
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

export const openExpenseFormModal = (expense = null) => {
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
export const openExpenseModal = (expense = null) => openExpenseFormModal(expense);
