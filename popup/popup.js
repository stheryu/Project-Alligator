// popup/popup.js
import { getCart, clearCart, removeItem } from "../utils/storage.js";

const safeText = (v) => (v == null ? "" : String(v));

// Convert a link to a readable site label.
// If hostname ends with .com, use the label right before ".com" (e.g., www.zara.com -> "Zara").
// Otherwise, fall back to the second-level label (co.uk etc.).
function siteFromLink(link) {
  try {
    const { hostname } = new URL(link);
    const h = hostname.replace(/^www\./i, "");
    if (h.endsWith(".com")) {
      const parts = h.split(".");
      const base = parts[parts.length - 2] || parts[0];
      return base.charAt(0).toUpperCase() + base.slice(1);
    }
    // Handle e.g. shop.domain.co.uk -> "domain"
    const parts = h.split(".");
    if (parts.length >= 2) {
      const base = parts[parts.length - 2];
      return base.charAt(0).toUpperCase() + base.slice(1);
    }
    return h.charAt(0).toUpperCase() + h.slice(1);
  } catch {
    return "View";
  }
}

function renderItems(items, itemsContainer) {
  if (!items || items.length === 0) {
    itemsContainer.innerHTML =
      '<div class="empty">No items yet. Add something to your cart and it will appear here.</div>';
    return;
  }
  itemsContainer.innerHTML = items
    .map((item) => {
      const id    = safeText(item.id);
      const img   = safeText(item.img);
      const title = safeText(item.title || "Untitled item");
      const brand = safeText(item.brand || "");
      const price = safeText(item.price || "");
      const link  = safeText(item.link || "#");
      const site  = link && link !== "#" ? siteFromLink(link) : "View";
      return `
        <div class="item" role="listitem" data-id="${id}">
          <img src="${img}" alt="${title}" loading="lazy" />
          <div class="details">
            <strong title="${title}">${title}</strong>
            <p>${brand}</p>
            <p>${price}</p>
            <a href="${link}" target="_blank" rel="noopener noreferrer" title="${link}">${site}</a>
          </div>
          <button class="remove" aria-label="Remove item" title="Remove">×</button>
        </div>`;
    })
    .join("");
}

function loadAndRender(itemsContainer) {
  getCart().then((items) => renderItems(items, itemsContainer));
}

function wirePopup() {
  const itemsContainer = document.getElementById("items");
  const clearBtn = document.getElementById("clear-all");

  if (!itemsContainer) {
    console.error("[UnifiedCart] Missing #items container in popup.html");
    return;
  }

  // Delete (delegation)
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

  // Instant refresh when background broadcasts a change
  chrome.runtime?.onMessage?.addListener?.((msg) => {
    if (msg?.action === "CART_UPDATED" && Array.isArray(msg.items)) {
      renderItems(msg.items, itemsContainer);
    }
  });

  // Fallback: refresh on storage changes (still useful if popup opens after a save)
  chrome.storage?.onChanged?.addListener?.((changes, area) => {
    if (area === "sync" && changes.cart) loadAndRender(itemsContainer);
  });

  // Initial render
  loadAndRender(itemsContainer);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wirePopup);
} else {
  wirePopup();
}

console.log("Unified Cart popup v0.1.8 loaded");