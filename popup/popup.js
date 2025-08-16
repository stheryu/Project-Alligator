// popup/popup.js
import { getCart, clearCart, removeItem } from "../utils/storage.js";

const hasChrome = !!(globalThis.chrome && chrome.runtime);
const safeText = (v) => (v == null ? "" : String(v));
const MODE_KEY = "shoppingMode";

// ---- Shopping mode helpers (persist + reflect) ----
function getMode() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get({ [MODE_KEY]: true }, (o) => resolve(!!o[MODE_KEY]));
    } catch {
      resolve(true);
    }
  });
}
function setMode(on) {
  return new Promise((resolve) => {
    try { chrome.storage.sync.set({ [MODE_KEY]: !!on }, resolve); }
    catch { resolve(); }
  });
}
function reflectMode(btn, on) {
  if (!btn) return;
  btn.setAttribute("aria-pressed", String(!!on));
  btn.title = `Shopping mode: ${on ? "On" : "Off"}`;
  btn.classList.toggle("is-off", !on);
}

// Site name from link
function siteFromLink(link) {
  try {
    const { hostname } = new URL(link);
    const h = hostname.replace(/^www\./i, "");
    const parts = h.split(".");
    const base = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return "View";
  }
}

function renderItems(items, itemsContainer) {
  if (!items || items.length === 0) {
    itemsContainer.innerHTML = '<div class="empty">No items yet.</div>';
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

async function loadAndRender(itemsContainer) {
  const items = await getCart();
  renderItems(items, itemsContainer);
}

function wirePopup() {
  // Logo path
  const logoEl = document.querySelector(".brand-logo");
  if (logoEl) {
    try {
      logoEl.src = hasChrome && chrome.runtime.getURL
        ? chrome.runtime.getURL("icons/alligator_icon.png")
        : "../icons/alligator_icon.png";
    } catch {
      logoEl.src = "../icons/alligator_icon.png";
    }
  }

  const itemsContainer = document.getElementById("items");
  const clearBtn = document.getElementById("clear-all");
  const toggleBtn = document.getElementById("shopping-toggle");
  if (!itemsContainer) {
    console.error("[UnifiedCart] Missing #items container in popup.html");
    return;
  }

  // ---- Initialize Shopping Mode toggle ----
  (async () => {
    const on = await getMode();
    reflectMode(toggleBtn, on);
  })();

  toggleBtn?.addEventListener("click", async () => {
    const currentlyOn = toggleBtn.getAttribute("aria-pressed") === "true";
    const next = !currentlyOn;
    reflectMode(toggleBtn, next);
    await setMode(next);

    // Optional: nudge background (not strictly needed, storage change propagates)
    try { chrome.runtime.sendMessage({ action: "SHOPPING_MODE_CHANGED", enabled: next }); } catch {}
  });

  const openLink = (url) => {
    if (!url || url === "#") return;
    try { window.open(url, "_blank", "noopener"); } catch {}
  };

  // Delegated click: remove OR open card
  itemsContainer.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    const removeBtn = target.closest(".remove");
    if (removeBtn) {
      const card = removeBtn.closest(".item");
      const id = card?.dataset.id;
      if (!id) return;
      e.stopPropagation();
      e.preventDefault();
      card.remove();
      removeItem(id).catch(() => loadAndRender(itemsContainer));
      return;
    }

    if (target.closest("a")) return; // let <a> work normally

    const card = target.closest(".item");
    if (card?.dataset.link) openLink(card.dataset.link);
  });

  // Keyboard access
  itemsContainer.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = (e.target instanceof Element) ? e.target.closest(".item") : null;
    if (!card?.dataset.link) return;
    e.preventDefault();
    openLink(card.dataset.link);
  });

  // Clear all
  clearBtn?.addEventListener("click", async () => {
    itemsContainer.innerHTML =
      '<div class="empty">No items yet. Add something to your cart and it will appear here.</div>';
    try { await clearCart(); }
    finally { await loadAndRender(itemsContainer); }
  });

  // Live refresh from background
  if (hasChrome && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.action === "CART_UPDATED" && Array.isArray(msg.items)) {
        renderItems(msg.items, itemsContainer);
      }
    });
  }

  // Storage fallback
  if (hasChrome && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes.cart) loadAndRender(itemsContainer);
      // If you want the button to react to mode changes made elsewhere while popup is open:
      if (area === "sync" && "shoppingMode" in changes) {
        reflectMode(toggleBtn, !!changes.shoppingMode.newValue);
      }
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