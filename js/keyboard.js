import { state, keyboardNavigationState } from "./state.js";
import { showToast, closeModal } from "./utils.js";
import { renderCart } from "./pos.js";

// 3.5 KEYBOARD CONTROLS & SHORTCUTS
// ==========================================================================
export const initKeyboardControls = (navigateTo) => {
  const shortcuts = {
    // Navigation shortcuts
    "ctrl+p": () => navigateTo("pos"),
    "ctrl+d": () => navigateTo("dashboard"),
    "ctrl+i": () => navigateTo("products"),
    "ctrl+h": () => navigateTo("sales-history"),
    "ctrl+u": () => navigateTo("customers"),
    "ctrl+l": () => navigateTo("suppliers"),
    "ctrl+e": () => navigateTo("expenses"),
    "ctrl+r": () => navigateTo("reports"),
    "ctrl+s": () => navigateTo("settings"),

    // POS specific shortcuts
    "ctrl+shift+c": () => {
      if (document.getElementById("page-pos").classList.contains("active")) {
        state.cart = [];
        renderCart();
        showToast("Cart cleared", "success");
      }
    },
    "ctrl+shift+enter": () => {
      if (document.getElementById("page-pos").classList.contains("active")) {
        document.getElementById("pos-checkout-btn")?.click();
      }
    },

    // Modal/Dialog controls
    escape: () => {
      const modal = document.getElementById("modal-container");
      if (modal && !modal.classList.contains("hidden")) {
        closeModal();
      }
    },

    // Help/Shortcuts menu
    "ctrl+?": (e) => {
      e.preventDefault();
      showKeyboardShortcuts();
    },
    "ctrl+shift+?": (e) => {
      e.preventDefault();
      showKeyboardShortcuts();
    },

    // Theme toggle
    "ctrl+shift+t": () => {
      document.getElementById("theme-toggle")?.click();
    },
  };

  // Category quick navigation in POS (Alt+1 to Alt+9)
  const categories = state.categories;
  categories.forEach((cat, idx) => {
    if (idx < 9) {
      shortcuts[`alt+${idx + 1}`] = () => {
        if (document.getElementById("page-pos").classList.contains("active")) {
          const catSelect = document.getElementById("pos-category-filter");
          if (catSelect) {
            catSelect.value = cat;
            catSelect.dispatchEvent(new Event("change"));
            showToast(`Filtered by ${cat}`, "success");
          }
        }
      };
    }
  });

  // Global keyboard event listener
  document.addEventListener("keydown", (e) => {
    if (handleKeyboardNavigation(e)) return;

    // Ignore if user is typing in an input field (unless it's a special shortcut)
    const isInput =
      e.target.tagName === "INPUT" ||
      e.target.tagName === "TEXTAREA" ||
      e.target.contentEditable === "true";

    if (isInput && !e.ctrlKey && !e.altKey && e.key !== "Escape") {
      return;
    }

    // Build the key combination string
    const keys = [];
    if (e.ctrlKey) keys.push("ctrl");
    if (e.shiftKey) keys.push("shift");
    if (e.altKey) keys.push("alt");

    // Add the actual key
    const key = e.key.toLowerCase();
    if (key !== "control" && key !== "shift" && key !== "alt") {
      keys.push(key === "?" ? "?" : key);
    }

    const combo = keys.join("+");

    // Check if this combination has a shortcut
    if (shortcuts[combo]) {
      e.preventDefault();
      try {
        shortcuts[combo](e);
      } catch (error) {
        console.error("Keyboard shortcut error:", error);
      }
    }

    // POS-specific Enter key for quick add (when search is focused)
    if (
      e.key === "Enter" &&
      isInput &&
      document.getElementById("pos-search") === e.target
    ) {
      // Find the first product in the filtered grid and add it
      const firstCard = document.querySelector(".pos-product-card");
      if (firstCard) {
        firstCard.click();
      }
    }
  });

  initKeyboardNavigationObserver();
};

export const getModalFocusableElements = () => {
  const modal = document.getElementById("modal-container");
  if (!modal || modal.classList.contains("hidden")) return [];
  return Array.from(
    modal.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => element.offsetParent !== null);
};

export const focusActiveProduct = (index = keyboardNavigationState.activeProductIndex, shouldFocus = true) => {
  const cards = Array.from(document.querySelectorAll("#pos-product-grid .pos-product-card"));
  if (!cards.length) return;

  keyboardNavigationState.activeProductIndex = Math.max(0, Math.min(index, cards.length - 1));
  cards.forEach((card, cardIndex) => {
    const isActive = cardIndex === keyboardNavigationState.activeProductIndex;
    card.classList.toggle("keyboard-focus", isActive);
    card.tabIndex = isActive ? 0 : -1;
    card.setAttribute("aria-selected", String(isActive));
  });

  const activeCard = cards[keyboardNavigationState.activeProductIndex];
  keyboardNavigationState.lastProductElement = activeCard;
  if (shouldFocus) {
    activeCard.focus({ preventScroll: true });
    activeCard.scrollIntoView({ block: "nearest" });
  }
};

export const restoreProductFocus = () => {
  const cards = Array.from(document.querySelectorAll("#pos-product-grid .pos-product-card"));
  const index = keyboardNavigationState.lastProductElement
    ? cards.indexOf(keyboardNavigationState.lastProductElement)
    : keyboardNavigationState.activeProductIndex;
  if (index > -1) focusActiveProduct(index);
};

export const handleModalKeyboardNavigation = (e) => {
  const modal = document.getElementById("modal-container");
  if (!modal || modal.classList.contains("hidden")) return false;

  const focusableElements = getModalFocusableElements();
  if (!focusableElements.length) return true;

  const currentIndex = focusableElements.indexOf(document.activeElement);
  if (e.key === "Escape") {
    e.preventDefault();
    closeModal();
    return true;
  }

  if (e.key === "Enter") {
    const primaryAction = modal.querySelector(
      'button[type="submit"]:not([disabled]), .btn-primary:not([disabled]), #delete-confirm-approve:not([disabled])'
    );
    if (primaryAction && !["BUTTON", "A"].includes(e.target.tagName)) {
      e.preventDefault();
      primaryAction.click();
      return true;
    }
  }

  if (e.key === "Tab" || ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
    e.preventDefault();
    const direction = e.key === "ArrowUp" || e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey) ? -1 : 1;
    const nextIndex = (currentIndex + direction + focusableElements.length) % focusableElements.length;
    focusableElements[nextIndex].focus();
    return true;
  }

  return true;
};

export const getGlobalFocusableElements = () =>
  Array.from(
    document.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]'
    )
  ).filter((element) => {
    const isInModal = element.closest("#modal-container");
    return !isInModal && element.offsetParent !== null;
  });

export const getInventoryActionRows = () =>
  Array.from(document.querySelectorAll("#products-table-body tr")).map((row) =>
    Array.from(row.querySelectorAll("button:not([disabled]), a[href]"))
  ).filter((actions) => actions.length);

export const handleInventoryKeyboardNavigation = (e) => {
  if (!document.getElementById("page-products")?.classList.contains("active")) return false;
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return false;

  const activeElement = document.activeElement;
  if (!activeElement?.closest("#products-table-body")) return false;

  const actionRows = getInventoryActionRows();
  if (!actionRows.length) return false;

  const currentRowIndex = actionRows.findIndex((actions) => actions.includes(activeElement));
  const currentActions = actionRows[Math.max(0, currentRowIndex)];
  const currentActionIndex = Math.max(0, currentActions.indexOf(activeElement));
  let nextRowIndex = Math.max(0, currentRowIndex);
  let nextActionIndex = currentActionIndex;

  if (e.key === "ArrowUp") nextRowIndex -= 1;
  if (e.key === "ArrowDown") nextRowIndex += 1;
  if (e.key === "ArrowLeft") nextActionIndex -= 1;
  if (e.key === "ArrowRight") nextActionIndex += 1;

  nextRowIndex = Math.max(0, Math.min(nextRowIndex, actionRows.length - 1));
  nextActionIndex = Math.max(0, Math.min(nextActionIndex, actionRows[nextRowIndex].length - 1));
  keyboardNavigationState.inventoryRowIndex = nextRowIndex;
  keyboardNavigationState.inventoryActionIndex = nextActionIndex;
  e.preventDefault();
  const nextElement = actionRows[nextRowIndex][nextActionIndex];
  nextElement.focus();
  nextElement.scrollIntoView({ block: "nearest" });
  return true;
};

export const handleSearchKeyboardNavigation = (e) => {
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return false;

  const searchElement = e.target;
  if (searchElement.id === "product-search-input") {
    const actionRows = getInventoryActionRows();
    if (!actionRows.length) return false;

    const focusedAction = actionRows.findIndex((actions) => actions.includes(document.activeElement));
    const currentRow = focusedAction > -1 ? focusedAction : e.key === "ArrowUp" ? 0 : -1;
    const nextRow = Math.max(0, Math.min(currentRow + (e.key === "ArrowUp" ? -1 : 1), actionRows.length - 1));
    const actionIndex = e.key === "ArrowLeft" ? 0 : e.key === "ArrowRight" ? actionRows[nextRow].length - 1 : 0;
    e.preventDefault();
    actionRows[nextRow][actionIndex].focus();
    actionRows[nextRow][actionIndex].scrollIntoView({ block: "nearest" });
    return true;
  }

  if (searchElement.id === "pos-search") {
    const grid = document.getElementById("pos-product-grid");
    const cards = Array.from(grid?.querySelectorAll(".pos-product-card") || []);
    if (!cards.length) return false;

    const focusedIndex = cards.indexOf(document.activeElement);
    const currentIndex = focusedIndex > -1 ? focusedIndex : e.key === "ArrowUp" ? 0 : -1;
    const columns = Math.max(1, Math.round(grid.clientWidth / cards[0].getBoundingClientRect().width));
    const offset = e.key === "ArrowUp" ? -columns : e.key === "ArrowDown" ? columns : e.key === "ArrowLeft" ? -1 : 1;
    e.preventDefault();
    focusActiveProduct(Math.max(0, Math.min(currentIndex + offset, cards.length - 1)));
    return true;
  }

  return false;
};

export const handleKeyboardNavigation = (e) => {
  if (handleModalKeyboardNavigation(e)) return true;

  if (handleSearchKeyboardNavigation(e)) return true;

  if (["INPUT", "TEXTAREA"].includes(e.target.tagName) || e.target.isContentEditable) return false;

  if (handleInventoryKeyboardNavigation(e)) return true;

  const grid = document.getElementById("pos-product-grid");
  const cards = Array.from(grid?.querySelectorAll(".pos-product-card") || []);

  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
    e.preventDefault();

    if (cards.length && document.getElementById("page-pos")?.classList.contains("active")) {
      const columns = Math.max(1, Math.round(grid.clientWidth / cards[0].getBoundingClientRect().width));
      const offset = e.key === "ArrowUp" ? -columns : e.key === "ArrowDown" ? columns : e.key === "ArrowLeft" ? -1 : 1;
      focusActiveProduct(keyboardNavigationState.activeProductIndex + offset);
      return true;
    }

    const focusableElements = getGlobalFocusableElements();
    if (!focusableElements.length) return true;
    const currentIndex = focusableElements.indexOf(document.activeElement);
    const direction = e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 1;
    const nextIndex = (currentIndex + direction + focusableElements.length) % focusableElements.length;
    focusableElements[nextIndex].focus();
    return true;
  }

  if (e.key === "Enter" && document.activeElement?.classList.contains("pos-product-card")) {
    e.preventDefault();
    document.activeElement.click();
    return true;
  }

  return false;
};

export const initKeyboardNavigationObserver = () => {
  const modal = document.getElementById("modal-container");
  if (!modal) return;

  new MutationObserver(() => {
    if (!modal.classList.contains("hidden")) {
      if (!keyboardNavigationState.modalFocusElement) {
        const activeProduct = document.activeElement?.closest?.("#pos-product-grid .pos-product-card");
        if (activeProduct) keyboardNavigationState.lastProductElement = activeProduct;
        const firstFocusable = getModalFocusableElements()[0];
        if (firstFocusable) {
          keyboardNavigationState.modalFocusElement = firstFocusable;
          firstFocusable.focus();
        }
      }
    } else if (keyboardNavigationState.modalFocusElement) {
      keyboardNavigationState.modalFocusElement = null;
      restoreProductFocus();
    }
  }).observe(modal, { attributes: true, childList: true, subtree: true });
};

export const showKeyboardShortcuts = () => {
  const shortcuts = [
    { key: "Ctrl + P", desc: "POS Terminal" },
    { key: "Ctrl + D", desc: "Dashboard" },
    { key: "Ctrl + I", desc: "Inventory" },
    { key: "Ctrl + H", desc: "Sales History" },
    { key: "Ctrl + U", desc: "Customers" },
    { key: "Ctrl + L", desc: "Suppliers" },
    { key: "Ctrl + E", desc: "Expenses" },
    { key: "Ctrl + R", desc: "Reports" },
    { key: "Ctrl + S", desc: "Settings" },
    { key: "Alt + 1-9", desc: "Quick category filter (in POS)" },
    { key: "Ctrl + Shift + C", desc: "Clear cart" },
    { key: "Ctrl + Shift + Enter", desc: "Quick checkout" },
    { key: "Ctrl + Shift + T", desc: "Toggle theme" },
    { key: "Enter", desc: "Add first product to cart (in POS search)" },
    { key: "Escape", desc: "Close modal/dialog" },
  ];

  const html = `
    <div class="modal-header">
      <h3><i class="fa-solid fa-keyboard"></i> Keyboard Shortcuts</h3>
      <button class="icon-btn" id="close-shortcuts"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="modal-body">
      <div style="display: grid; grid-template-columns: auto 1fr; gap: 20px; gap-row: 12px;">
        ${shortcuts.map((s) => `
          <div style="font-weight: 600; color: var(--primary-color); font-size: 0.85rem; font-family: monospace;">${s.key}</div>
          <div style="color: var(--text-muted); font-size: 0.85rem;">${s.desc}</div>
        `).join("")}
      </div>
    </div>
  `;

  const modal = document.getElementById("modal-container");
  const modalContent = document.getElementById("modal-content");

  if (modal && modalContent) {
    modalContent.innerHTML = html;
    modal.classList.remove("hidden");

    document.getElementById("close-shortcuts")?.addEventListener("click", closeModal);
  }
};

// ==========================================================================
