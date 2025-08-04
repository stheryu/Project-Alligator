// content-scripts/zaraAddListener.js
(() => {
  // Top-frame only
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Zara]", ...a);

  // --- two-shot control + debounce ---
  let sentQuick = false;
  let sentSettled = false;
  let lastKey = "", lastAt = 0;
  function debounceSend(key, ms = 2500) {
    const now = Date.now();
    if (key === lastKey && now - lastAt < ms) return false;
    lastKey = key; lastAt = now; return true;
  }

  // --- safe sender with storage fallback (handles SW sleeping or context loss) ---
  function saveToStorageDirect(item) {
    try {
      chrome.storage.sync.get({ cart: [] }, (res) => {
        let items = Array.isArray(res.cart) ? res.cart : [];
        const id = String(item.id || "");
        const link = String(item.link || "");
        items = items.filter(it => String(it.id||"") !== id && String(it.link||"") !== link);
        items.push(item);
        chrome.storage.sync.set({ cart: items });
      });
    } catch (e) { log("storage fallback error", e); }
  }
  function sendItemSafe(item) {
    try {
      if (chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ action: "ADD_ITEM", item }, () => {
          if (chrome.runtime?.lastError) {
            // This is where your "Extension context invalidated" was happening
            log("sendMessage lastError → fallback:", chrome.runtime.lastError.message);
            saveToStorageDirect(item);
          }
        });
      } else {
        saveToStorageDirect(item);
      }
    } catch (e) {
      log("sendItemSafe exception → fallback:", e);
      saveToStorageDirect(item);
    }
  }

  // ---------- helpers ----------
  const $   = (sel) => document.querySelector(sel);
  const txt = (sel) => (document.querySelector(sel)?.textContent || "").trim();
  const attr= (sel, name) => document.querySelector(sel)?.getAttribute(name) || "";

  const first = (a) => Array.isArray(a) ? a[0] : a;
  const normType = (t) => (Array.isArray(t) ? t : (t ? [t] : [])).map(v => String(v).toLowerCase());
  const currencyToken = (s) => (String(s).match(/[$€£]\s?\d[\d.,]*/) || [""])[0];

  function formatCurrency(cur, price) {
    const sym = !cur || cur === "USD" ? "$" : cur;
    const n = Number(price);
    return Number.isFinite(n) ? `${sym} ${n.toFixed(2)}` : currencyToken(price);
  }

  // JSON-LD product parser (handles arrays/@graph/nesting)
  function findProductNode(node) {
    try {
      if (!node || typeof n