// popup/popup.js
import { getCart, clearCart, removeItem } from "../utils/storage.js";

const itemsContainer = document.getElementById("items");
const clearBtn = document.getElementById("clear-all");

function renderItems(items) {
  if (!items || items.length === 0) {
    itemsContainer.innerHTML =
      '<div class="empty">No items yet. Add something to your cart and it will appear here.</div>';
    return;
  }
  itemsContainer.innerHTML = items
    .map(
      (item) => `
      <div class="item" data-id="${String(item.id)}">
        <img src="${item.img || ""}" alt="${item.title || "Item"}" />
        <div class="details">
          <strong>${item.title || "Untitled item"}</strong>
          <p>${item.brand || ""}</p>
          <p>${item.price || ""}</p>
          <a href="${item.link || "#"}" target="_blank" rel="noreferrer">View</a>
        </div>
        <button class="remove" aria-label="Remove item" title="Remove">×</button>
      </div>`
    )
    .join("");
}

// Delete handler (delegation)
itemsContainer.addEventListener("click", (e) => {
  const btn = e.target.closest(".remove");
  if (!btn) return;
  const id = btn.closest(".item")?.dataset.id;
  if (!id) return;
  removeItem(id).then(loadAndRender);
});

function loadAndRender() {
  getCart().then(renderItems);
}

clearBtn.addEventListener("click", () => {
  clearCart().then(loadAndRender);
});

// Auto-refresh when cart changes (if popup is open)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.cart) loadAndRender();
});

console.log("Unified Cart popup v0.1.6 loaded");
loadAndRender();