import { db, auth, onAuthenticationChange, initializeAuthHandlers } from "./firebase-init.js";
import { state, currentUser, currentBusiness, businessId, setCurrentUser, setCurrentBusiness, setBusinessId, updateConnectionStatus, refreshOutboxStatus, syncOutbox, restorePendingOperations, subscribeToQuery } from "./state.js";
import { formatCurrency, padDatePart, showToast, toggleLoader, showDeleteConfirmation, normalizeToStandardUnit, readLogoFile, populatePrintWindowContent, populateReturnPrintWindowContent, closeModal, saveInvoicePdf } from "./utils.js";
import { initKeyboardControls } from "./keyboard.js";
import { createInvoiceDraft, renderOpenInvoiceDrafts, renderCart, calculateCartTotals, renderPosProducts, captureActiveInvoiceDraft, startNewInvoiceDraft, finishActiveInvoiceDraft } from "./pos.js";
import { renderProductsTable, openProductModal, exportProductsCSV, exportProductsExcel, importSpreadsheet } from "./modules/products.js";
import { renderCustomersTable, renderPosCustomerDropdown, getCustomerName, openCustomerFormModal, exportCustomersExcel, importCustomersSpreadsheet } from "./modules/customers.js";
import { renderSuppliersTable, renderPurchasesTable, openPurchaseFormModal, openSupplierFormModal, renderDeleteRecords, deleteSelectedRecord } from "./modules/suppliers.js";
import { refreshDashboard, generateReport, seedDemoData, deleteAllStock, exportSalesCSV, exportRecordsPDF, renderExpensesTable, openExpenseFormModal } from "./modules/reports.js";
import { doc, collection, setDoc, getDoc, updateDoc, query, where, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

onAuthenticationChange(async (user) => {
  if (user) {
    setCurrentUser(user);
    await loadUserProfileAndBusiness();
    document.getElementById("auth-screen")?.classList.add("hidden");
    document.getElementById("app-screen")?.classList.remove("hidden");
    initNavigation();
    initAppListeners();
    initKeyboardControls(navigateTo);
    setupRealtimeListeners();
    await restorePendingOperations();
    await syncOutbox();
    startClock();
  } else {
    setCurrentUser(null);
    setCurrentBusiness(null);
    setBusinessId(null);
    document.getElementById("app-screen")?.classList.add("hidden");
    document.getElementById("auth-screen")?.classList.remove("hidden");
  }
});

export const startClock = () => {
  const clock = document.getElementById("clock-display");
  if (!clock) return;
  setInterval(() => {
    const now = new Date();
    clock.innerText = now.toLocaleTimeString("en-PK") + " PKT";
  }, 1000);
};

export const loadUserProfileAndBusiness = async () => {
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
        showAddressOnInvoice: true,
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
    setBusinessId(userData.businessId || "default_biz");

    const bizDoc = await getDoc(doc(db, "businesses", businessId));
    if (bizDoc.exists()) {
      setCurrentBusiness(bizDoc.data());
    } else {
      setCurrentBusiness({
        shopName: "My PakPOS Store",
        ownerName: "Admin",
        phone: "",
        address: "",
        showAddressOnInvoice: true,
        tax: 0,
      });
    }
    state.categories = [
      ...new Set([
        ...state.categories,
        ...(Array.isArray(currentBusiness.categories) ? currentBusiness.categories : []),
      ]),
    ];

    const shopElem = document.getElementById("sidebar-shop-name");
    const roleElem = document.getElementById("sidebar-user-role");

    if (shopElem) shopElem.innerText = currentBusiness.shopName || "My Store";
    if (roleElem) roleElem.innerText = userData.role || "Admin";

    const setShopName = document.getElementById("set-shop-name");
    const setShopPhone = document.getElementById("set-shop-phone");
    const setShopAddress = document.getElementById("set-shop-address");
    const setShowAddressOnInvoice = document.getElementById("set-show-address-invoice");
    const setShopTax = document.getElementById("set-shop-tax");
    const setInvoiceFooter = document.getElementById("set-invoice-footer");
    const setLogoSize = document.getElementById("set-logo-size");
    const setLogoSizeValue = document.getElementById("set-logo-size-value");
    const logoPreview = document.getElementById("shop-logo-preview");

    if (setShopName) setShopName.value = currentBusiness.shopName || "";
    if (setShopPhone) setShopPhone.value = currentBusiness.phone || "";
    if (setShopAddress) setShopAddress.value = currentBusiness.address || "";
    if (setShowAddressOnInvoice) setShowAddressOnInvoice.checked = currentBusiness.showAddressOnInvoice !== false;
    if (setShopTax) setShopTax.value = currentBusiness.tax || 0;
    if (setInvoiceFooter) setInvoiceFooter.value = currentBusiness.invoiceFooter || "";
    if (setLogoSize) setLogoSize.value = Math.min(250, Math.max(50, Number(currentBusiness.logoSize) || 100));
    if (setLogoSizeValue) setLogoSizeValue.textContent = `${setLogoSize?.value || 100}%`;
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

export const navigateTo = (pageId) => {
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
  if (pageId === "products") {
    state.inventoryStockFilter = "";
    const searchInput = document.getElementById("product-search-input");
    if (searchInput) searchInput.value = "";
    renderProductsTable();
  }

  document.getElementById("sidebar")?.classList.remove("open");
  document.getElementById("sidebar-overlay")?.classList.remove("open");
  document.getElementById("sidebar-toggle-btn")?.setAttribute("aria-expanded", "false");
};

export const initNavigation = () => {
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

  const lowStockMetric = document.getElementById("low-stock-metric");
  const showLowStockProducts = () => {
    navigateTo("products");
    state.inventoryStockFilter = "low";
    renderProductsTable();
  };
  lowStockMetric?.addEventListener("click", showLowStockProducts);
  lowStockMetric?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      showLowStockProducts();
    }
  });

  const sidebarToggle = document.getElementById("sidebar-toggle-btn");
  const closeBtn = document.getElementById("sidebar-close-btn");
  const overlay = document.getElementById("sidebar-overlay");
  const sidebar = document.getElementById("sidebar");
  const appScreen = document.getElementById("app-screen");

  const updateSidebarToggleState = (isExpanded) => {
    sidebarToggle?.setAttribute("aria-expanded", String(isExpanded));
    if (sidebarToggle) {
      sidebarToggle.title = isExpanded ? "Hide sidebar" : "Show sidebar";
      sidebarToggle.setAttribute("aria-label", isExpanded ? "Hide sidebar" : "Show sidebar");
    }
  };

  sidebarToggle?.addEventListener("click", () => {
    if (window.matchMedia("(max-width: 900px)").matches) {
      const isOpen = sidebar?.classList.toggle("open") || false;
      overlay?.classList.toggle("open", isOpen);
      updateSidebarToggleState(isOpen);
      return;
    }

    const isCollapsed = appScreen?.classList.toggle("sidebar-collapsed") || false;
    updateSidebarToggleState(!isCollapsed);
  });

  closeBtn?.addEventListener("click", () => {
    sidebar?.classList.remove("open");
    overlay?.classList.remove("open");
    updateSidebarToggleState(false);
  });

  overlay?.addEventListener("click", () => {
    sidebar?.classList.remove("open");
    overlay?.classList.remove("open");
    updateSidebarToggleState(false);
  });

  const themeToggle = document.getElementById("theme-toggle");
  themeToggle?.addEventListener("click", () => {
    document.body.classList.toggle("dark-mode");
    const isDark = document.body.classList.contains("dark-mode");
    themeToggle.innerHTML = isDark
      ? `<i class="fa-solid fa-sun"></i> <span>Light Mode</span>`
      : `<i class="fa-solid fa-moon"></i> <span>Dark Mode</span>`;
  });

  document
    .getElementById("manage-categories-btn")
    ?.addEventListener("click", openCategoryManager);
};

export const initAppListeners = () => {
  if (state.invoiceDrafts.length === 0) {
    state.invoiceDrafts.push(createInvoiceDraft(1));
  }
  renderOpenInvoiceDrafts();

  const catFilter = document.getElementById("product-category-filter");
  const prodSearch = document.getElementById("product-search-input");
  if (catFilter) catFilter.addEventListener("change", renderProductsTable);
  if (prodSearch) prodSearch.addEventListener("input", renderProductsTable);
  document.getElementById("clear-stock-filter")?.addEventListener("click", () => {
    state.inventoryStockFilter = "";
    renderProductsTable();
  });

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
  document.getElementById("pos-customer-select")?.addEventListener("change", () => {
    captureActiveInvoiceDraft();
    renderOpenInvoiceDrafts();
  });
  document.getElementById("pos-payment-method")?.addEventListener("change", () => captureActiveInvoiceDraft());
  document.getElementById("pos-print-format")?.addEventListener("change", () => captureActiveInvoiceDraft());
  document.getElementById("pos-new-invoice-btn")?.addEventListener("click", startNewInvoiceDraft);
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
      const customerName = getCustomerName();

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
    .getElementById("pos-save-pdf-btn")
    ?.addEventListener("click", () => {
      const format =
        document.getElementById("pos-print-format")?.value || "thermal";
      if (!state.cart || state.cart.length === 0) {
        showToast("Cart is empty", "error");
        return;
      }

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
      const saleData = {
        invoiceNumber: "INV-" + Math.floor(1000 + Math.random() * 9000),
        customerName: getCustomerName(),
        items: saleItems,
        subtotal,
        discount,
        taxAmount,
        grandTotal,
        paidAmount,
        balanceDue,
        paymentMethod: document.getElementById("pos-payment-method")?.value || "Cash",
      };

      const printWindow = window.open("", "_blank", "width=400,height=600");
      populatePrintWindowContent(printWindow, saleData, format, false);
      void saveInvoicePdf(printWindow, saleData, format);
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
        const showAddressOnInvoice = document.getElementById("set-show-address-invoice")?.checked !== false;
        const invoiceFooter = document.getElementById("set-invoice-footer").value;
        const logoSize = Math.min(250, Math.max(50, Number(document.getElementById("set-logo-size")?.value) || 100));
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
          showAddressOnInvoice,
          tax,
          invoiceFooter,
          logoSize,
          logoDataUrl,
        };
        await updateDoc(doc(db, "businesses", businessId), businessUpdate);
        setCurrentBusiness({ ...currentBusiness, ...businessUpdate });
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

  document.getElementById("set-logo-size")?.addEventListener("input", (event) => {
    const value = document.getElementById("set-logo-size-value");
    if (value) value.textContent = `${event.target.value}%`;
  });

  document
    .getElementById("load-demo-data-btn")
    ?.addEventListener("click", seedDemoData);
  document
    .getElementById("delete-all-stock-btn")
    ?.addEventListener("click", deleteAllStock);
  document
    .getElementById("import-products-btn")
    ?.addEventListener("click", () => document.getElementById("import-products-file")?.click());
  document
    .getElementById("import-customers-btn")
    ?.addEventListener("click", () => document.getElementById("import-customers-file")?.click());
  document
    .getElementById("import-products-file")
    ?.addEventListener("change", (event) => importSpreadsheet(event.target.files?.[0], "products"));
  document
    .getElementById("import-customers-file")
    ?.addEventListener("change", (event) => importCustomersSpreadsheet(event.target.files?.[0]));
  document
    .getElementById("export-products-csv")
    ?.addEventListener("click", exportProductsCSV);
  document
    .getElementById("export-sales-csv")
    ?.addEventListener("click", exportSalesCSV);
  document
    .getElementById("export-customers-excel")
    ?.addEventListener("click", exportCustomersExcel);
  document
    .getElementById("export-customers-pdf")
    ?.addEventListener("click", () => exportRecordsPDF("customers"));
  document
    .getElementById("export-products-excel")
    ?.addEventListener("click", exportProductsExcel);
  document
    .getElementById("export-products-pdf")
    ?.addEventListener("click", () => exportRecordsPDF("products"));
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

  const posCustomerSelect = document.getElementById("pos-customer-select");
  if (posCustomerSelect) {
    posCustomerSelect.addEventListener("change", () => {
      const walkinInput = document.getElementById("pos-walkin-customer-name");
      if (walkinInput) {
        walkinInput.style.display = posCustomerSelect.value === "WALKIN" ? "block" : "none";
      }
    });
  }

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

// 5. FIRESTORE REAL-TIME SUBSCRIPTIONS
// ==========================================================================
export const setupRealtimeListeners = () => {
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

export const populateCategoryDropdowns = () => {
  const invSelect = document.getElementById("product-category-filter");
  const posSelect = document.getElementById("pos-category-filter");

  const options =
    `<option value="ALL">All Categories</option>` +
    state.categories.map((c) => `<option value="${c}">${c}</option>`).join("");

  if (invSelect) invSelect.innerHTML = options;
  if (posSelect) posSelect.innerHTML = options;
};

export const openCategoryManager = () => {
  const modalContainer = document.getElementById("modal-container");
  const modalContent = document.getElementById("modal-content");
  if (!modalContainer || !modalContent) return;

  modalContent.innerHTML = `
    <div class="modal-header">
      <h3><i class="fa-solid fa-layer-group"></i> Manage Categories</h3>
      <button class="icon-btn" type="button" onclick="window.closeModal()"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <form id="category-form">
      <div class="modal-body">
        <div class="form-group">
          <label for="new-category-name">Add Category</label>
          <div class="button-group">
            <input type="text" id="new-category-name" placeholder="Example: Cosmetics" maxlength="40" required>
            <button type="submit" class="btn btn-primary"><i class="fa-solid fa-plus"></i> Add</button>
          </div>
        </div>
        <div class="form-group">
          <label>Available Categories</label>
          <div id="category-list" class="category-manager-list"></div>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" onclick="window.closeModal()">Close</button>
      </div>
    </form>
  `;
  modalContainer.classList.remove("hidden");

  const categoryList = document.getElementById("category-list");
  const renderCategoryList = () => {
    if (!categoryList) return;
    categoryList.innerHTML = "";
    state.categories.forEach((category) => {
      const item = document.createElement("span");
      item.className = "chip";
      item.textContent = category;
      categoryList.appendChild(item);
    });
  };

  document.getElementById("category-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.getElementById("new-category-name");
    const category = input?.value.trim() || "";
    if (!category) return;
    if (state.categories.some((item) => item.toLowerCase() === category.toLowerCase())) {
      showToast("That category already exists.", "error");
      return;
    }

    try {
      const categories = [...state.categories, category];
      await updateDoc(doc(db, "businesses", businessId), { categories });
      state.categories = categories;
      setCurrentBusiness({ ...currentBusiness, categories });
      populateCategoryDropdowns();
      renderCategoryChips();
      renderCategoryList();
      if (input) input.value = "";
      showToast(`${category} category added.`, "success");
    } catch (error) {
      showToast(`Unable to add category: ${error.message}`, "error");
    }
  });

  renderCategoryList();
};

export const renderCategoryChips = () => {
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

export const renderSalesHistoryTable = () => {
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
    const matchesDate = !dateFilter || (date && padDatePart(date.getFullYear()) + "-" + padDatePart(date.getMonth() + 1) + "-" + padDatePart(date.getDate()) === dateFilter);
    return matchesSearch && matchesDate;
  }).forEach((s) => {
    const tr = document.createElement("tr");
    const saleDate = s.createdAt?.toDate ? s.createdAt.toDate() : s.createdAt instanceof Date ? s.createdAt : null;
    const dateStr = saleDate ? saleDate.toLocaleString() : "N/A";
    const hasReturns = Array.isArray(s.returnedItems) && s.returnedItems.length > 0;
    const isFullyReturned = s.returned || s.returnStatus === "Returned" || (hasReturns && (s.items || []).reduce((sum, item) => sum + Number(item.qty ?? item.normalizedQty ?? 0), 0) <= s.returnedItems.reduce((sum, item) => sum + Number(item.returnQty || 0), 0));
    const statusLabel = isFullyReturned ? "Returned" : (hasReturns ? "Partially Returned" : (s.syncStatus || "Completed"));
    const statusClass = isFullyReturned ? "bg-red" : (hasReturns ? "bg-orange" : "bg-green");
    tr.innerHTML = `
      <td><strong>${s.invoiceNumber}</strong></td>
      <td>${dateStr}</td>
      <td>${s.customerName || "Walk-in"}</td>
      <td>${(s.items || []).length} items</td>
      <td><strong>${formatCurrency(s.grandTotal)}</strong></td>
      <td><span class="chip">${s.paymentMethod || "Cash"}</span></td>
      <td><span class="chip ${statusClass}" style="color:#fff;">${statusLabel}</span></td>
      <td class="sales-action-cell">
        <div class="sales-action-group">
          <button class="btn btn-sm btn-secondary" onclick='window.reprintInvoice(${JSON.stringify(s)})'><i class="fa-solid fa-print"></i></button>
          ${isFullyReturned ? '<span class="chip bg-red">Closed</span>' : `<button class="btn btn-sm btn-danger" onclick='window.openReturnItemsModal(${JSON.stringify(s)})'><i class="fa-solid fa-rotate-left"></i> Return Items</button>`}
        </div>
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

export const openReturnItemsModal = (saleObj) => {
  const modalContainer = document.getElementById("modal-container");
  const modalContent = document.getElementById("modal-content");
  if (!modalContainer || !modalContent) return;

  const saleItems = saleObj.items || [];
  const existingReturns = saleObj.returnedItems || [];

  const rowsHtml = saleItems
    .map((item) => {
      const soldQty = Number(item.qty ?? item.normalizedQty ?? 0);
      const alreadyReturned = existingReturns
        .filter((entry) => entry.productId === item.productId)
        .reduce((sum, entry) => sum + Number(entry.returnQty || 0), 0);
      const remainingQty = Math.max(0, soldQty - alreadyReturned);
      const unitStep = item.unit === "KG" || item.unit === "Gram" ? "0.05" : "1";

      return `
        <div class="return-item-row" style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 0; border-bottom:1px solid #e2e8f0;">
          <div style="flex:1;">
            <div style="font-weight:700; margin-bottom:4px;">${item.name}</div>
            <div style="font-size:12px; color:#64748b;">Sold: ${soldQty} ${item.unit || "pcs"} • Remaining: ${remainingQty} ${item.unit || "pcs"}</div>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <label style="font-size:12px; color:#64748b;">Return Qty</label>
            <input type="number" min="0" max="${remainingQty}" step="${unitStep}" value="0" data-return-index="${item.productId || item.name}" data-max-qty="${remainingQty}" style="width:90px; text-align:center;">
          </div>
        </div>
      `;
    })
    .join("");

  modalContent.innerHTML = `
    <div class="delete-confirm-modal return-modal-panel">
      <div class="delete-confirm-icon return-modal-icon"><i class="fa-solid fa-rotate-left"></i></div>
      <h3>Return Selected Items</h3>
      <p class="return-modal-invoice">Invoice: <strong>${saleObj.invoiceNumber}</strong></p>
      <div class="return-items-list">
        ${rowsHtml || '<p>No items available to return.</p>'}
      </div>
      <div class="delete-confirm-actions return-modal-actions">
        <button type="button" class="btn btn-secondary" id="return-items-cancel">Cancel</button>
        <button type="button" class="btn btn-danger" id="return-items-confirm"><i class="fa-solid fa-rotate-left"></i> Return Selected Items</button>
      </div>
    </div>
  `;

  modalContainer.classList.remove("hidden");

  document.getElementById("return-items-cancel")?.addEventListener("click", () => window.closeModal());
  document.getElementById("return-items-confirm")?.addEventListener("click", async () => {
    const returnSelections = saleItems
      .map((item) => {
        const soldQty = Number(item.qty ?? item.normalizedQty ?? 0);
        const existingReturns = (saleObj.returnedItems || []).filter((entry) => entry.productId === item.productId);
        const alreadyReturned = existingReturns.reduce((sum, entry) => sum + Number(entry.returnQty || 0), 0);
        const remainingQty = Math.max(0, soldQty - alreadyReturned);
        const input = modalContent.querySelector(`input[data-return-index="${item.productId || item.name}"]`);
        const returnQty = Number(input?.value || 0);
        if (returnQty <= 0 || returnQty > remainingQty) return null;
        const normalizedReturnQty = normalizeToStandardUnit(returnQty, item.unit);
        const lineTotal = Number((returnQty * (item.sellingPrice || 0)).toFixed(2));
        return {
          productId: item.productId,
          name: item.name,
          unit: item.unit,
          qty: returnQty,
          normalizedQty: normalizedReturnQty,
          sellingPrice: item.sellingPrice,
          purchasePrice: item.purchasePrice,
          lineTotal,
        };
      })
      .filter(Boolean);

    if (!returnSelections.length) {
      showToast("Select at least one valid quantity to return.", "error");
      return;
    }

    window.closeModal();
    await window.processSaleReturn(saleObj, returnSelections);
  });
};

window.openReturnItemsModal = openReturnItemsModal;

window.processSaleReturn = async (saleObj, selectedItems = []) => {
  if (!saleObj || !(saleObj.items || []).length) {
    showToast("No items available to return.", "error");
    return;
  }

  const finalSelectedItems = selectedItems.length ? selectedItems : (saleObj.items || []).map((item) => {
    const soldQty = Number(item.qty ?? item.normalizedQty ?? 0);
    const remainingQty = Math.max(0, soldQty - Number((saleObj.returnedItems || []).filter((entry) => entry.productId === item.productId).reduce((sum, entry) => sum + Number(entry.returnQty || 0), 0)));
    const normalizedQty = normalizeToStandardUnit(remainingQty, item.unit);
    return {
      productId: item.productId,
      name: item.name,
      unit: item.unit,
      qty: remainingQty,
      normalizedQty,
      sellingPrice: item.sellingPrice,
      purchasePrice: item.purchasePrice,
      lineTotal: Number((remainingQty * (item.sellingPrice || 0)).toFixed(2)),
    };
  });

  const returnTotal = finalSelectedItems.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0);

  if (!finalSelectedItems.length || returnTotal <= 0) {
    showToast("Please choose at least one item to return.", "error");
    return;
  }

  const format = document.getElementById("pos-print-format")?.value || "thermal";
  const printWindow = window.open("", "_blank", "width=400,height=600");

  toggleLoader(true, "Processing item return & restocking...");

  try {
    const existingReturns = Array.isArray(saleObj.returnedItems) ? saleObj.returnedItems : [];
    for (const item of finalSelectedItems) {
      const normalizedQty = Number(item.normalizedQty || 0);
      if (!normalizedQty) continue;

      const product = state.products.find((entry) => entry.id === item.productId);
      if (product) {
        product.currentStock = Number(product.currentStock || 0) + normalizedQty;
      }

      if (item.productId && navigator.onLine) {
        const productRef = doc(db, "products", item.productId);
        const productSnap = await getDoc(productRef);
        if (productSnap.exists()) {
          const nextStock = Number(productSnap.data().currentStock || 0) + normalizedQty;
          await updateDoc(productRef, {
            currentStock: nextStock,
            updatedAt: serverTimestamp(),
          });
        }
      }
    }

    const mergedReturnItems = [...existingReturns, ...finalSelectedItems.map((item) => ({
      productId: item.productId,
      name: item.name,
      unit: item.unit,
      returnQty: item.qty,
      normalizedQty: item.normalizedQty,
      sellingPrice: item.sellingPrice,
      lineTotal: item.lineTotal,
    }))];

    const totalReturnedQty = mergedReturnItems.reduce((sum, item) => sum + Number(item.returnQty || 0), 0);
    const totalSoldQty = (saleObj.items || []).reduce((sum, item) => sum + Number(item.qty ?? item.normalizedQty ?? 0), 0);
    const saleStatus = totalReturnedQty >= totalSoldQty ? "Returned" : "Partially Returned";

    if (saleObj.id && navigator.onLine) {
      await updateDoc(doc(db, "sales", saleObj.id), {
        returned: totalReturnedQty >= totalSoldQty,
        returnStatus: saleStatus,
        returnedAt: totalReturnedQty >= totalSoldQty ? serverTimestamp() : null,
        returnedItems: mergedReturnItems,
        returnTotal: (Number(saleObj.returnTotal || 0) + returnTotal).toFixed(2),
      });
    }

    const returnData = {
      invoiceNumber: saleObj.invoiceNumber,
      customerName: saleObj.customerName || "Walk-in Customer",
      items: finalSelectedItems,
      returnTotal,
      grandTotal: returnTotal,
      paymentMethod: "Return",
    };

    populateReturnPrintWindowContent(printWindow, returnData, format, true);
    showToast("Selected items returned and stock has been restored.", "success");
  } catch (err) {
    if (printWindow) printWindow.close();
    showToast(err.message || "Unable to process item return.", "error");
  } finally {
    toggleLoader(false);
  }
};

initializeAuthHandlers();
