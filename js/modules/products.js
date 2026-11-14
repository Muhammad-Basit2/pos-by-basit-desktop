import { state, businessId, currentBusiness, setCurrentBusiness } from "../state.js";
import { db } from "../firebase-init.js";
import { formatCurrency, showDeleteConfirmation, toggleLoader, showToast } from "../utils.js";
import { renderPosProducts } from "../pos.js";
import { renderCustomersTable, renderPosCustomerDropdown } from "./customers.js";
import { refreshDashboard } from "./reports.js";
import { populateCategoryDropdowns, renderCategoryChips } from "../main.js";
import { doc, collection, updateDoc, deleteDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// 8. PRODUCT MANAGEMENT
// ==========================================================================
export const renderProductsTable = () => {
  const tbody = document.getElementById("products-table-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  const filter =
    document.getElementById("product-category-filter")?.value || "ALL";
  const q =
    document.getElementById("product-search-input")?.value.toLowerCase() || "";
  const clearStockFilter = document.getElementById("clear-stock-filter");

  if (clearStockFilter) {
    clearStockFilter.classList.toggle("hidden", state.inventoryStockFilter !== "low");
  }

  const filtered = state.products.filter((p) => {
    const matchCat = filter === "ALL" || p.category === filter;
    const matchQ =
      p.name.toLowerCase().includes(q) || (p.barcode && p.barcode.includes(q));
    const matchStock =
      state.inventoryStockFilter !== "low" ||
      p.currentStock <= (p.minStockAlert || 5);
    return matchCat && matchQ && matchStock;
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

export const openProductModal = (product = null) => {
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
        const updatedProduct = { ...product, ...prodData, id: product.id };
        state.products = state.products.map((item) =>
          item.id === product.id ? updatedProduct : item,
        );
        renderProductsTable();
        renderPosProducts();
        window.closeModal();
        toggleLoader(false);
        updateDoc(doc(db, "products", product.id), prodData).catch((err) =>
          showToast(`Product sync failed: ${err.message}`, "error"),
        );
        showToast("Product updated!", "success");
      } else {
        prodData.createdAt = serverTimestamp();
        const productRef = doc(collection(db, "products"));
        const localProduct = {
          ...prodData,
          id: productRef.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        state.products.push(localProduct);
        renderProductsTable();
        renderPosProducts();
        window.closeModal();
        toggleLoader(false);
        setDoc(productRef, prodData).catch((err) =>
          showToast(`Product sync failed: ${err.message}`, "error"),
        );
        showToast("Product added!", "success");
      }
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

export const exportProductsCSV = () => {
  let csv = "Barcode,Product Name,Category,Unit,Cost,Price,Stock\n";
  state.products.forEach((p) => {
    csv += `"${p.barcode || ""}","${p.name}","${p.category}","${p.unit}",${p.purchasePrice},${p.sellingPrice},${p.currentStock}\n`;
  });
  downloadCSV(csv, "products_export.csv");
};

export const exportToExcel = (rows, sheetName, filename) => {
  if (typeof XLSX === "undefined") {
    showToast("Excel export is unavailable. Please reconnect and try again.", "error");
    return;
  }
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  XLSX.writeFile(workbook, filename);
  showToast(`${sheetName} exported to Excel.`, "success");
};

export const exportProductsExcel = () => {
  exportToExcel(
    state.products.map((product) => ({
      Barcode: product.barcode || product.sku || "",
      "Product Name": product.name || "",
      Category: product.category || "",
      Unit: product.unit || "",
      Cost: product.purchasePrice || 0,
      Price: product.sellingPrice || 0,
      Stock: product.currentStock || 0,
    })),
    "Stock",
    "stock_export.xlsx",
  );
};

export const normalizeSpreadsheetKey = (key) =>
  String(key || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

export const spreadsheetValue = (row, ...keys) => {
  const normalizedRow = Object.entries(row).reduce((result, [key, value]) => {
    result[normalizeSpreadsheetKey(key)] = value;
    return result;
  }, {});
  for (const key of keys) {
    const value = normalizedRow[normalizeSpreadsheetKey(key)];
    if (value !== undefined && value !== "") return value;
  }
  return "";
};

export const parseCSVRows = (text) => {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    const nextCharacter = text[index + 1];
    if (character === '"' && quoted && nextCharacter === '"') {
      value += '"';
      index++;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(value.trim());
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && nextCharacter === "\n") index++;
      row.push(value.trim());
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }

  row.push(value.trim());
  if (row.some((cell) => cell !== "")) rows.push(row);
  if (rows.length < 2) return [];

  const headers = rows.shift().map((header, index) => index === 0 ? header.replace(/^\uFEFF/, "") : header);
  return rows.map((cells) => headers.reduce((result, header, index) => {
    result[header] = cells[index] || "";
    return result;
  }, {}));
};

export const decodeCsvBytes = (bytes) => {
  const hasUtf16Pattern = bytes[1] === 0 || bytes[3] === 0;
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || hasUtf16Pattern) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1256").decode(bytes);
  }
};

export const readSpreadsheetRows = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    const isCSV = file.name.toLowerCase().endsWith(".csv");
    reader.onload = (event) => {
      try {
        if (isCSV) {
          const bytes = new Uint8Array(event.target.result);
          resolve(parseCSVRows(decodeCsvBytes(bytes)));
          return;
        }
        if (typeof XLSX === "undefined") {
          reject(new Error("Excel support is unavailable. Please use CSV or reconnect and try again."));
          return;
        }
        const workbook = XLSX.read(event.target.result, { type: "array" });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        resolve(XLSX.utils.sheet_to_json(firstSheet, { defval: "" }));
      } catch (error) {
        reject(new Error("The spreadsheet could not be read. Please check its format."));
      }
    };
    reader.onerror = () => reject(new Error("The spreadsheet file could not be opened."));
    reader.readAsArrayBuffer(file);
  });

export const importSpreadsheet = async (file, type) => {
  if (!file) return;
  const fileInput = document.getElementById(`import-${type}-file`);
  if (fileInput) fileInput.value = "";
  toggleLoader(true, `Importing ${type === "products" ? "stock" : "customers"}...`);

  try {
    const fileName = file.name.toLowerCase();
    if (!fileName.endsWith(".xlsx") && !fileName.endsWith(".xls") && !fileName.endsWith(".csv")) {
      throw new Error("Please select an Excel (.xlsx/.xls) or CSV file.");
    }
    const rows = await readSpreadsheetRows(file);
    if (!rows.length) throw new Error("The spreadsheet has no data rows.");
    const hasCorruptedText = rows.some((row) =>
      Object.values(row).some((value) => String(value).includes("????")),
    );
    if (hasCorruptedText) {
      throw new Error("This CSV already contains ???? instead of Urdu text. Re-save it as UTF-8 CSV and import again.");
    }

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const importedCategories = new Set();
    for (const row of rows) {
      if (type === "products") {
        const name = String(spreadsheetValue(row, "name", "product name", "item") || "").trim();
        if (!name) {
          skipped++;
          continue;
        }
        const barcode = String(spreadsheetValue(row, "barcode", "sku", "barcode sku") || "").trim();
        const existing = state.products.find((product) =>
          barcode ? String(product.barcode || "") === barcode : product.name.toLowerCase() === name.toLowerCase(),
        );
        const data = {
          businessId,
          name,
          barcode,
          category: String(spreadsheetValue(row, "category", "group") || "Grocery").trim(),
          unit: String(spreadsheetValue(row, "unit", "unit type") || "Piece").trim(),
          currentStock: Number(spreadsheetValue(row, "stock", "current stock", "quantity")) || 0,
          purchasePrice: Number(spreadsheetValue(row, "cost", "purchase price", "purchase cost")) || 0,
          sellingPrice: Number(spreadsheetValue(row, "price", "selling price", "sale price")) || 0,
          minStockAlert: Number(spreadsheetValue(row, "minimum stock", "min stock alert")) || 5,
          updatedAt: serverTimestamp(),
        };
        if (data.category) importedCategories.add(data.category);
        if (existing) {
          await updateDoc(doc(db, "products", existing.id), data);
          updated++;
        } else {
          await addDoc(collection(db, "products"), { ...data, createdAt: serverTimestamp() });
          imported++;
        }
      } else {
        const name = String(spreadsheetValue(row, "name", "customer name", "customer") || "").trim();
        if (!name) {
          skipped++;
          continue;
        }
        const phone = String(spreadsheetValue(row, "phone", "mobile", "contact") || "").trim();
        const existing = state.customers.find((customer) =>
          phone ? String(customer.phone || "") === phone : customer.name.toLowerCase() === name.toLowerCase(),
        );
        const data = {
          businessId,
          name,
          phone,
          cnic: String(spreadsheetValue(row, "cnic", "national id") || "").trim(),
          balance: Number(spreadsheetValue(row, "balance", "initial balance", "udhaar", "credit")) || 0,
          updatedAt: serverTimestamp(),
        };
        if (existing) {
          await updateDoc(doc(db, "customers", existing.id), data);
          updated++;
        } else {
          await addDoc(collection(db, "customers"), { ...data, createdAt: serverTimestamp() });
          imported++;
        }
      }
    }
    const newCategories = [...importedCategories].filter(
      (category) => !state.categories.some((existing) => existing.toLowerCase() === category.toLowerCase()),
    );
    if (newCategories.length) {
      state.categories = [...state.categories, ...newCategories];
      setCurrentBusiness({ ...currentBusiness, categories: state.categories });
      await updateDoc(doc(db, "businesses", businessId), { categories: state.categories });
      populateCategoryDropdowns();
      renderCategoryChips();
    }
    showToast(`Import complete: ${imported} added, ${updated} updated${skipped ? `, ${skipped} skipped` : ""}.`, "success");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    toggleLoader(false);
  }
};

export const downloadCSV = (content, filename) => {
  const blob = new Blob([content], { type: "text/csv" });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.setAttribute("href", url);
  a.setAttribute("download", filename);
  a.click();
};
