// popup/popup.js
import { getCart, clearCart, removeItem } from "../utils/storage.js";

const safeText = (v) => (v == null ? "" : String(v));

function siteFromLink(link) {
  try {
    const { hostname } = new URL(link);
    const h = hostname.replace(/^www\./i, "");
    if (h.endsWith(".com")) {
      const parts = h.split(".");
      const base = parts[parts.length - 2] || parts[0];
      return base.charAt(0).toUpperCase() + base.slice(1);
    }
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
      const id = safeText(item.id);
      const img = safeText(item.img);
      const title = safeText(item.title || "Untitled item");
      const brand = safeText(item.brand || "");
      const price = safeText(item.price || "");
      const link = safeText(item.link || "#");
      const site = link && link !== "#" ? siteFromLink(link) : "View";

      return `
        <div class="item" role="link" tabindex="0"
             data-id="${id}" data-link="${link}" aria-label="Open on ${site}">
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
  // Ensure logo path works when packed
  const logoEl = document.querySelector(".brand-logo");
  if (logoEl) {
    if (chrome && chrome.runtime && chrome.runtime.getURL) {
      logoEl.src = chrome.runtime.getURL("icons/alligator_icon.png");
    } else {
      logoEl.src = "../icons/alligator_icon.png"; // dev fallback
    }
  }

  const itemsContainer = document.getElementById("items");
  const clearBtn = document.getElementById("clear-all");
  if (!itemsContainer) {
    console.error("[UnifiedCart] Missing #items container in popup.html");
    return;
  }

  const openLink = (url) => {
    if (!url || url === "#") return;
    try {
      window.open(url, "_blank", "noopener");
    } catch {}
  };

  // Delegated click: remove OR open card
  itemsContainer.addEventListener("click", (e) => {
    const removeBtn = e.target.closest(".remove");
    if (removeBtn) {
      const card = removeBtn.closest(".item");
      const id = card?.dataset.id;
      if (!id) return;
      e.stopPropagation();
      e.preventDefault();
      // optimistic UI
      card.remove();
      // real remove (fallback re-render on error)
      removeItem(id).catch(() => loadAndRender(itemsContainer));
      return;
    }
    // If user clicked the inner <a>, let default behavior run
    if (e.target.closest("a")) return;

    const card = e.target.closest(".item");
    if (card?.dataset.link) {
      openLink(card.dataset.link);
    }
  });

  // Keyboard access: Enter/Space on focused card opens link
  itemsContainer.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest(".item");
    if (!card?.dataset.link) return;
    e.preventDefault();
    openLink(card.dataset.link);
  });

  // Clear all — single (optimistic) handler
  clearBtn?.addEventListener("click", async () => {
    itemsContainer.innerHTML =
      '<div class="empty">No items yet. Add something to your cart and it will appear here.</div>';
    try {
      await clearCart();
    } finally {
      loadAndRender(itemsContainer);
    }
  });

  // Live refresh from background (optimistic broadcasts)
  if (chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.action === "CART_UPDATED" && Array.isArray(msg.items)) {
        renderItems(msg.items, itemsContainer);
      }
    });
  }

  // Storage fallback (covers changes from other contexts)
  if (chrome && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes.cart) loadAndRender(itemsContainer);
    });
  }

  // Initial render
  loadAndRender(itemsContainer);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wirePopup);
} else {
  wirePopup();
}

console.log("Alligator popup v0.2.0 loaded");