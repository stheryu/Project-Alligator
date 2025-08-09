// background.js — Unified Cart (MV3)
// v0.2.0 (optimistic updates + safe messaging)

(() => {
  const VERSION = "0.2.0";
  console.log(`[UnifiedCart] SW v${VERSION} starting`);

  const ENABLE_NOTIFICATIONS = false;
  const str = (x) => (x == null ? "" : String(x));

  // ---------------- In-memory cart (for instant UI) ----------------
  let CART = [];
  chrome.storage.sync.get({ cart: [] }, ({ cart }) => {
    CART = Array.isArray(cart) ? cart : [];
  });
  // Keep CART in sync if something else modifies storage (e.g., popup remove/clear)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.cart) {
      const v = changes.cart.newValue;
      CART = Array.isArray(v) ? v : [];
    }
  });

  // ---------------- Safe message helpers (avoid “receiving end” errors) ----------------
  function safeRuntimeSendMessage(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime?.lastError);
    } catch (_) {}
  }
  function safeTabsSendMessage(tabId, msg, opts = {}) {
    try {
      chrome.tabs.sendMessage(tabId, msg, opts, () => void chrome.runtime?.lastError);
    } catch (_) {}
  }

  // ---------------- tiny helpers ----------------
  function isTrackingImage(url = "") {
    const u = url.toLowerCase();
    return !u || u.startsWith("data:") || u.endsWith(".svg") || /p13n\.gif|pixel|1x1|spacer|beacon/.test(u);
  }
  function looksLikeNoise(item = {}) {
    const t = str(item.title).toLowerCase();
    const p = str(item.price).trim();
    return !p && (isTrackingImage(item.img) || /p13n|1×1|1x1|pixel/.test(t));
  }
  function sanitizeItem(raw = {}) {
    const item = {
      id:   str(raw.id || raw.link || ""),
      title:str(raw.title),
      brand:str(raw.brand),
      price:str(raw.price),
      img:  str(raw.img),
      link: str(raw.link),
    };
    if (item.img && item.img.length > 2048 && item.img.startsWith("data:")) item.img = "";
    return item;
  }

  // PDP guards (Amazon/Walmart/Zara)
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
    return true;
  }

  // ---------------- messages ----------------
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
        // 2) PDP guards
        if (!passesPDPGuards(item.link)) {
          console.log("[UnifiedCart] blocked by PDP guard:", item.link);
          try { sendResponse({ ok: true, ignored: true, reason: "guard" }); } catch {}
          return;
        }

        // 3) OPTIMISTIC update (instant)
        const keyId   = str(item.id);
        const keyLink = str(item.link);
        CART = CART.filter(it => str(it.id) !== keyId && str(it.link) !== keyLink);
        CART.push(item);

        // 3a) instant popup refresh
        safeRuntimeSendMessage({ action: "CART_UPDATED", items: CART, added: item, count: CART.length });

        // 3b) toast near toolbar (content script handles pos)
        const tabId = sender?.tab?.id;
        if (Number.isInteger(tabId) && tabId >= 0) {
          safeTabsSendMessage(tabId, { action: "SHOW_TOAST", text: "Gotcha!", pos: "top-right" }, { frameId: 0 });
        }

        // 3c) flash a ✓ badge
        try {
          chrome.action.setBadgeBackgroundColor({ color: "#058E3F" });
          chrome.action.setBadgeText({ text: "✓" });
          setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1400);
        } catch {}

        // 4) persist in the background (non-blocking)
        chrome.storage.sync.set({ cart: CART }, () => {
          // optional: second broadcast if you want to ensure popup reflects any final dedupe
          // safeRuntimeSendMessage({ action: "CART_UPDATED", items: CART, added: item, count: CART.length });

          if (ENABLE_NOTIFICATIONS) {
            try {
              chrome.notifications?.create?.({
                type: "basic",
                iconUrl: chrome.runtime.getURL("icons/icon48.png"),
                title: "Item Added",
                message: `${item.title || "Item"} added to your unified cart.`,
                silent: true,
              }, () => void chrome.runtime?.lastError);
            } catch {}
          }
        });

        try { sendResponse({ ok: true, saved: true, count: CART.length }); } catch {}
        return true; // async response
      }
    } catch (e) {
      console.error("[UnifiedCart] background error:", e);
      try { sendResponse({ ok: false, error: String(e) }); } catch {}
    }
  });

  // ---------------- Optional: webRequest assist (Amazon/eBay) ----------------
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
          safeTabsSendMessage(details.tabId, { action: "ADD_TRIGGERED", via: "webRequest", url: details.url }, { frameId: 0 });
        },
        { urls: ["*://*.amazon.com/*", "*://*.ebay.com/*"] }
      );
      console.log("[UnifiedCart] webRequest assist active (Amazon/eBay)");
    }
  } catch (e) {
    console.error("[UnifiedCart] webRequest listener setup error:", e);
  }
})();