// popup/popup.js
import { getCart, clearCart, removeItem } from "../utils/storage.js";

function safeText(v) { return (v == null ? "" : String(v)); }

function renderItems(items, itemsContainer) {
  if (!items || items.length === 0) {
    itemsContainer.innerHTML =
      '<div class="empty">No items yet. Add something to your cart and it will appear here.</div>';
    return;
  }
  itemsContainer.innerHTML = items.map((item) => {
    const id    = safeText(item.id);
    const img   = safeText(item.img);
    const title = safeText(item.title || "Untitled item");
    const brand = safeText(item.brand || "");
    const price = safeText(item.price || "");
    const link  = safeText(item.link || "#");
    return `
      <div class="item" role="listitem" data-id="${id}">
        <img src="${img}" alt="${title}" />
        <div class="details">
          <strong title="${title}">${title}</strong>
          <p>${brand}</p>
          <p>${price}</p>
          <a href="${link}" target="_blank" rel="noopener noreferrer">View</a>
        </div>
        <button class="remove" aria-label="Remove item" title="Remove">×</button>
      </div>`;
  }).join("");
}

function wirePopup() {
  const itemsContainer = document.getElementById("items");
  const clearBtn = document.getElementById("clear-all");

  if (!itemsContainer) {
    console.error("[UnifiedCart] Missing #items container in popup.html");
    return;
  }
  if (!clearBtn) {
    console.warn("[UnifiedCart] Missing #clear-all button in popup.html");
  }

  // Delegate delete clicks
  itemsContainer.addEventListener("click", (e) => {
    const btn = e.target.closest(".remove");
    if (!btn) return;
    const id = btn.closest(".item")?.dataset.id;
    if (!id) return;
    removeItem(id).then(() => loadAndRender(itemsContainer));
  });

  // Clear all
  clearBtn?.addEventListener("click", () => {
    clearCart().then(() => loadAndRender(itemsContainer));
  });

  // Auto-refresh when cart changes
  chrome.storage?.onChanged?.addListener?.((changes, area) => {
    if (area === "sync" && changes.cart) loadAndRender(itemsContainer);
  });

  // Initial render
  loadAndRender(itemsContainer);
}

function loadAndRender(itemsContainer) {
  getCart().then((items) => renderItems(items, itemsContainer));
}

// Ensure DOM is ready (script is after body, but this is extra safe)
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wirePopup);
} else {
  wirePopup();
}

console.log("Unified Cart popup v0.1.7 loaded");