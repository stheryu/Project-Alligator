// content-scripts/walmartAddListener.js
(() => {
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Walmart]", ...a);

  // --- de-dupe per page ---
  let lastKey = "", lastAt = 0, lastUIClickAt = 0;
  function debounceSend(key, ms = 1800) {
    const now = Date.now();
    if (key === lastKey && now - lastAt < ms) return false;
    lastKey = key; lastAt = now; return true;
  }

  // ------- safe runtime + storage helpers -------
  function saveToStorageDirect(item, cb) {
    try {
      chrome.storage.sync.get({ cart: [] }, (res) => {
        let items = Array.isArray(res.cart) ? res.cart : [];
        const keyId = String(item.id || "");
        const keyLink = String(item.link || "");
        items = items.filter(it => String(it.id||"") !== keyId && String(it.link||"") !== keyLink);
        items.push(item);
        chrome.storage.sync.set({ cart: items }, () => cb && cb());
      });
    } catch (e) {
      log("storage fallback error:", e);
      cb && cb(e);
    }
  }

  function sendItemSafe(item) {
    try {
      const rt = (globalThis.chrome && chrome.runtime) || (globalThis.browser && browser.runtime);
      if (rt && typeof rt.sendMessage === "function") {
        rt.sendMessage({ action: "ADD_ITEM", item }, (_resp) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            log("sendMessage lastError, falling back:", chrome.runtime.lastError.message);
            saveToStorageDirect(item);
          }
        });
      } else {
        log("runtime.sendMessage unavailable, saving directly");
        saveToStorageDirect(item);
      }
    } catch (e) {
      log("sendItemSafe exception, saving directly:", e);
      saveToStorageDirect(item);
    }
  }

  // ------- tiny DOM utils -------
  const $   = (s) => document.querySelector(s);
  const txt = (s) => $(s)?.textContent?.trim() || "";
  const attr= (s,n)=> $(s)?.getAttribute(n) || "";

  // ------- JSON-LD parsing -------
  const normType = (t) => (Array.isArray(t) ? t : (t ? [t] : [])).map(v => String(v).toLowerCase());
  function findProductNode(node) {
    try {
      if (!node || typeof node !== "object") return null;
      if (normType(node["@type"]).includes("product")) return node;
      if (Array.isArray(node)) { for (const x of node) { const hit = findProductNode(x); if (hit) return hit; } }
      else {
        if (node["@graph"]) { const hit = findProductNode(node["@graph"]); if (hit) return hit; }
        for (const k of Object.keys(node)) { const hit = findProductNode(node[k]); if (hit) return hit; }
      }
    } catch {}
    return null;
  }
  function parseJSONLDProduct() {
    const scripts = Array.from(document.querySelectorAll('script[type*="ld+json"]'));
    for (const s of scripts) {
      try {
        const raw = (s.textContent || "").trim();
        if (!raw) continue;
        const json = JSON.parse(raw);
        const prod = findProductNode(json);
        if (prod) return prod;
      } catch {}
    }
    return null;
  }

  // ------- extractors -------
  function extractTitle() {
    return txt('h1[data-automation-id="product-title"]')
        || txt("h1[itemprop='name']")
        || attr('meta[property="og:title"]', "content")
        || txt("h1")
        || document.title;
  }

  function currencyToken(s) {
    if (!s) return "";
    const m = String(s).match(/[$€£]\s?\d[\d,]*(?:\.\d{2})?/);
    return m ? m[0] : "";
  }
  function formatCurrency(cur, price) {
    const sym = !cur || cur === "USD" ? "$" : cur;
    const n = Number(price);
    return Number.isFinite(n) ? `${sym} ${n.toFixed(2)}` : currencyToken(price);
  }

  function extractPrice() {
    try {
      const ld = parseJSONLDProduct();
      if (ld && ld.offers) {
        const offers = Array.isArray(ld.offers