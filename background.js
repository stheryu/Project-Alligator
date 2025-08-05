// background.js — Unified Cart (MV3)
// Version 0.1.21 — broadcasts CART_UPDATED for instant popup refresh.

(() => {
  const VERSION = "0.1.21";
  console.log(`Unified Cart SW v${VERSION} starting`);

  // Keep notifications off unless you’ve packaged icons in /icons
  const ENABLE_NOTIFICATIONS = false;

  // ---------- utils ----------
  const str = (x) => (x == null ? "" : String(x));
  function isTrackingImage(url = "") {
    const u = url.toLowerCase();
    return !u || u.startsWith("data:") || u.endsWith(".svg") || /p13n\.gif|pixel|1x1|spacer|beacon/.test(u);
  }
  function looksLikeNoise(item = {}) {
    const t = str(item.title).toLowerCase();
    const p = str(item.price).trim();
    return !p && (isTrackingImage(item.img) || /p13n|1×1|1x1|pixel/.test(t));
  }
  function notifyAdded(item) {
    if (!ENABLE_NOTIFICATIONS) return;
    try {
      const iconUrl = chrome.runtime.getURL("icons/icon48.png");
      chrome.notifications?.create?.({
        type: "basic",
        iconUrl,
        title: "Item Added",
        message: `${item.title || "Item"} added to your unified cart.`,
        silent: true
      });
    } catch (e) {
      console.warn("[UnifiedCart] notify error:", e);
    }
  }
  function sanitizeItem(raw = {}) {
    const item = {
      id:   str(raw.id || raw.link || ""),
      title:str(raw.title),
      brand:str(raw.brand),
      price:str(raw.price),
      img:  str(raw.img),
      link: str(raw.link)
    };
    if (item.img && item.img.length > 2048 && item.img.startsWith("data:")) item.img = "";
    return item;
  }

  // ---------- PDP guards ----------
  function isAmazonPDP(link) {
    try {
      const { hostname, pathname } = new URL(link);
      if (!/(\.|^)amazon\.com$/i.test(hostname)) return true;
      return /\/(dp|gp\/product)\/[A-Z0-9]{10}/i.test(pathname);
    } catch { return true; }
  }
  function isWalmartPDP(link) {
    try {
      const { hostname, pathname } = new URL(link);
      if (!/(\.|^)walmart\.com$/i.test(hostname)) return true;
      return /^\/ip\//i.test(pathname);
    } catch { return true; }
  }
  function isZaraPDP(link) {
    try {
      const { hostname, pathname } = new URL(link);
      if (!/(\.|^)zara\.com$/i.test(hostname)) return true;
      return /-p\d+(?:\.html|$)/i.test(pathname);
    } catch { return true; }
  }
  function passesPDPGuards(link) {
    const L = str(link).toLowerCase();
    if (!L) return true;
    if (L.includes(".amazon.com"))  return isAmazonPDP(link);
    if (L.includes(".walmart.com")) return isWalmartPDP(link);
    if (L.includes(".zara.com"))    return isZaraPDP(link);
    return true; // Shopbop/eBay fine
  }

  // ---------- messages ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      if (msg?.action === "PING") {
        sendResponse({ ok: true, version: VERSION });
        return; // sync
      }

      if (msg?.action === "ADD_ITEM" && msg.item) {
        const item = sanitizeItem(msg.item);

        // 1) noise filter
        if (looksLikeNoise(item)) {
          console.log("[UnifiedCart] ignored noise item", item);
          try { sendResponse({ ok: true, ignored: true, reason: "noise" }); } catch {}
          return;
        }
        // 2) PDP guards (Amazon/Walmart/Zara)
        if (!passesPDPGuards(item.link)) {
          console.log("[UnifiedCart] blocked by PDP guard:", item.link);
          try { sendResponse({ ok: true, ignored: true, reason: "guard" }); } catch {}
          return;
        }

        // 3) save + broadcast
        chrome.storage.sync.get({ cart: [] }, ({ cart }) => {
          let items = Array.isArray(cart) ? cart : [];
          const keyId   = str(item.id);
          const keyLink = str(item.link);
          items = items.filter(it => str(it.id) !== keyId && str(it.link) !== keyLink);
          items.push(item);

          chrome.storage.sync.set({ cart: items }, () => {
            // Instant UI update for popup
            try {
              chrome.runtime.sendMessage({ action: "CART_UPDATED", items, added: item, count: items.length });
            } catch (e) {
              // If popup is closed or context is gone, ignore.
            }

            notifyAdded(item);
            try { sendResponse({ ok: true, saved: true, count: items.length }); } catch {}
          });
        });

        return true; // async
      }
    } catch (e) {
      console.error("[UnifiedCart] background error:", e);
      try { sendResponse({ ok: false, error: String(e) }); } catch {}
    }
  });

  // Optional: webRequest assist (Amazon/eBay)
  try {
    if (chrome.webRequest?.onBeforeRequest?.addListener) {
      const recent = new Map();
      const shouldNotify = (tabId, ms = 1200) => {
        const now = Date.now();
        const last = recent.get(tabId) || 0;
        if (now - last < ms) return false;
        recent.set(tabId, now);
        return true;
      };
      chrome.webRequest.onBeforeRequest.addListener(
        (details) => {
          if (details.tabId < 0) return;
          const u = String(details.url || "").toLowerCase();
          if (!/(cart|bag|basket|add|checkout)/.test(u)) return;
          if (!shouldNotify(details.tabId)) return;
          chrome.tabs.sendMessage(details.tabId, { action: "ADD_TRIGGERED", via: "webRequest", url: details.url }, { frameId: 0 });
        },
        { urls: ["*://*.amazon.com/*", "*://*.ebay.com/*"] }
      );
      console.log("[UnifiedCart] webRequest assist active (Amazon/eBay)");
    }
  } catch (e) {
    console.error("[UnifiedCart] webRequest listener setup error:", e);
  }
})();