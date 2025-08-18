// background.js — Unified Cart (MV3)
// v0.3.6  (Zara: PUT/PATCH + body sniff + broadcast fallback; keeps prior behavior)

(() => {
  const VERSION = "0.3.6";
  const DEBUG = false;
  const log = (...a) => { if (DEBUG) try { console.log("[UnifiedCart]", ...a); } catch {} };

  const ENABLE_NOTIFICATIONS = false;
  const str = (x) => (x == null ? "" : String(x));

  // ---------------- In-memory cart (for instant UI) ----------------
  let CART = [];
  chrome.storage.sync.get({ cart: [] }, ({ cart }) => { CART = Array.isArray(cart) ? cart : []; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.cart) CART = Array.isArray(changes.cart.newValue) ? changes.cart.newValue : [];
  });

  // --- Shopping mode flag (persisted in storage) ---
  let SHOPPING_MODE = true;
  chrome.storage.sync.get({ shoppingMode: true }, ({ shoppingMode }) => { SHOPPING_MODE = !!shoppingMode; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.shoppingMode) SHOPPING_MODE = !!changes.shoppingMode.newValue;
  });

  // ---------------- Safe message helpers ----------------
  function safeRuntimeSendMessage(msg) {
    try { chrome.runtime.sendMessage(msg, () => void chrome.runtime?.lastError); } catch {}
  }
  function safeTabsSendMessage(tabId, msg, opts = {}) {
    try { chrome.tabs.sendMessage(tabId, msg, opts, () => void chrome.runtime?.lastError); } catch {}
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

  // ---------- PDP guards (Amazon/Walmart/Zara only) ----------
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

  // ---------- Obvious non-PDP URL filter ----------
  function isLikelyProductUrl(link) {
    try {
      const { hostname, pathname } = new URL(String(link || ""));
      const host = hostname.toLowerCase();
      const p = pathname.toLowerCase();

      if (p.includes("/collections/") && !p.includes("/products/")) return false; // Shopify
      if (/(\.|^)theoutnet\.com$/.test(host)) {
        if (/\/shop(\/|$)/.test(p) && !/\/product(\/|$)/.test(p)) return false;
      }
      if (/\/(collection|collections|category|categories|catalog|shop)(\/|$)/.test(p)
          && !/\/(product|products|pdp|item)\b/.test(p)) return false;

      return true;
    } catch { return true; }
  }

  // ---------------- duplicate/toast/nudge throttles ----------------
  const RECENT_WINDOW_MS = 1500;
  const recentKeyTime = new Map();
  const recentToastByTab = new Map();
  const recentNudgeByTab = new Map();

  const now = () => Date.now();
  function seenRecently(map, key, ms = RECENT_WINDOW_MS) {
    const t = now(); const last = map.get(key) || 0;
    if (t - last < ms) return true;
    map.set(key, t); return false;
  }
  function shouldNudge(tabId, ms = 1200) {
    const t = now(); const last = recentNudgeByTab.get(tabId) || 0;
    if (t - last < ms) return false;
    recentNudgeByTab.set(tabId, t); return true;
  }

  // ---------------- messages ----------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      if (msg?.action === "PING") {
        sendResponse({ ok: true, version: VERSION });
        return;
      }

      if (msg?.action === "PAGE_ADD_EVENT") {
        if (!SHOPPING_MODE) { try { sendResponse({ ok: true, ignored: true, reason: "mode_off" }); } catch {} ; return; }
        const tabId = sender?.tab?.id;
        if (Number.isInteger(tabId) && shouldNudge(tabId)) {
          safeTabsSendMessage(tabId, { action: "ADD_TRIGGERED", via: msg.via || "inpage", url: msg.url }, { frameId: 0 });
        }
        try { sendResponse({ ok: true }); } catch {}
        return;
      }

      if (msg?.action === "ADD_ITEM" && msg.item) {
        if (!SHOPPING_MODE) { try { sendResponse({ ok: true, ignored: true, reason: "mode_off" }); } catch {} ; return; }

        const item = sanitizeItem(msg.item);

        if (looksLikeNoise(item)) { try { sendResponse({ ok: true, ignored: true, reason: "noise" }); } catch {}; return; }
        if (item.link && !isLikelyProductUrl(item.link)) { try { sendResponse({ ok: true, ignored: true, reason: "non_pdp" }); } catch {}; return; }
        if (!passesPDPGuards(item.link)) { try { sendResponse({ ok: true, ignored: true, reason: "guard" }); } catch {}; return; }

        const keyId   = str(item.id);
        const keyLink = str(item.link);
        const key     = (keyId || keyLink).toLowerCase();

        CART = CART.filter(it =>
          str(it.id).toLowerCase()   !== keyId.toLowerCase() &&
          str(it.link).toLowerCase() !== keyLink.toLowerCase()
        );
        CART.push(item);

        safeRuntimeSendMessage({ action: "CART_UPDATED", items: CART, added: item, count: CART.length });

        const tabId = sender?.tab?.id;
        const shouldToast = Number.isInteger(tabId) &&
                            !seenRecently(recentKeyTime, key) &&
                            !seenRecently(recentToastByTab, tabId);
        if (shouldToast) {
          safeTabsSendMessage(tabId, { action: "SHOW_TOAST", text: "Gotcha!", pos: "top-right" }, { frameId: 0 });
          try {
            chrome.action.setBadgeBackgroundColor({ color: "#058E3F" });
            chrome.action.setBadgeText({ text: "✓" });
            setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1400);
          } catch {}
        }

        chrome.storage.sync.set({ cart: CART }, () => {
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
        return;
      }
    } catch (e) {
      console.error("[UnifiedCart] background error:", e);
      try { sendResponse({ ok: false, error: String(e) }); } catch {}
    }
  });

  // ---------------- webRequest assist (eBay + Zara + Mango) ----------------
  try {
    if (chrome.webRequest?.onBeforeRequest?.addListener) {
      const recent = new Map();
      const shouldNotify = (tabId, ms = 1200) => {
        const t = now(); const last = recent.get(tabId) || 0;
        if (t - last < ms) return false;
        recent.set(tabId, t); return true;
      };

      function decodeBody(details) {
        try {
          const rb = details.requestBody;
          if (!rb) return "";
          if (rb.formData) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(rb.formData)) {
              const val = Array.isArray(v) ? v[0] : v;
              params.set(k, val);
            }
            return params.toString();
          }
          if (rb.raw && rb.raw.length && rb.raw[0].bytes) {
            return new TextDecoder("utf-8").decode(rb.raw[0].bytes);
          }
        } catch {}
        return "";
      }

      const isZaraAddUrl = (url) =>
        /\/api\/commerce\/bag(\/items)?\b/i.test(url) ||
        /\/api\/commerce\/cart(\/items|\/add)?\b/i.test(url) ||
        /\/bag\/(add|add-item|addItem)\b/i.test(url) ||
        /\/carts?\/(?:current|[a-z0-9-]+)\/entries\b/i.test(url);

      const hasAddIntentBody = (bodyStr) =>
        /\b(addToCart|addBagItem|addItemToCart|addItem|cartAdd|addCartEntry)\b/i.test(bodyStr) ||
        (/\b(product|productCode|sku|variant|style|pid)\b/i.test(bodyStr) && /\b(qty|quantity)\b/i.test(bodyStr));

      chrome.webRequest.onBeforeRequest.addListener(
        (details) => {
          try {
            if (!SHOPPING_MODE) return;

            const method = (details.method || "").toUpperCase();
            if (!(method === "POST" || method === "PUT" || method === "PATCH")) return;

            const u = String(details.url || "");
            const host = (() => { try { return new URL(u).hostname; } catch { return ""; } })();

            // eBay (kept)
            if (/(\.|^)ebay\.com$/i.test(host)) {
              if (/\/(cart\/(add|ajax|addtocart)|AddToCart|shoppingcart|basket\/add)\b/i.test(u)) {
                const tabId = details.tabId;
                if (tabId >= 0 && shouldNotify(tabId)) {
                  log("webRequest assist (eBay) hit:", u);
                  safeTabsSendMessage(tabId, { action: "ADD_TRIGGERED", via: "webRequest", url: u }, { frameId: 0 });
                }
              }
              return;
            }

            // Zara
            if (/(\.|^)zara\.(com|net)$/i.test(host)) {
              const bodyStr = decodeBody(details);
              const hit = isZaraAddUrl(u) || hasAddIntentBody(bodyStr);
              if (hit) {
                const tabId = details.tabId;
                if (tabId >= 0) {
                  if (shouldNotify(tabId)) {
                    log("webRequest assist (Zara) hit:", u);
                    safeTabsSendMessage(tabId, { action: "ADD_TRIGGERED", via: "webRequest", url: u }, { frameId: 0 });
                  }
                } else {
                  // Fallback: sandboxed frame (tabId = -1) → broadcast to all CS listeners
                  log("webRequest assist (Zara) broadcast (tabId=-1):", u);
                  safeRuntimeSendMessage({ action: "ADD_TRIGGERED_BROADCAST", host: "zara", url: u });
                }
              }
              return;
            }

            // Mango (works for you already; keep simple)
            if (/(\.|^)mango\.com$/i.test(host) || /(\.|^)shop\.mango\.com$/i.test(host)) {
              const tabId = details.tabId;
              if (tabId < 0) {
                safeRuntimeSendMessage({ action: "ADD_TRIGGERED_BROADCAST", host: "mango", url: u });
                return;
              }
              if (shouldNotify(tabId) && (/graphql|api\/graphql|\/gateway/i.test(u) || /\/carts?\/(?:current|[a-z0-9-]+)\/entries\b/i.test(u))) {
                log("webRequest assist (Mango) hit:", u);
                safeTabsSendMessage(tabId, { action: "ADD_TRIGGERED", via: "webRequest", url: u }, { frameId: 0 });
              }
              return;
            }
          } catch {}
        },
        {
          urls: [
            "*://*.ebay.com/*",
            "*://*.zara.com/*",
            "*://*.zara.net/*",   // (safe) cover API host, if used
            "*://*.mango.com/*",
            "*://shop.mango.com/*"
          ],
          types: ["xmlhttprequest", "ping", "sub_frame", "main_frame", "other"]
        },
        ["requestBody"]  // <— allow reading POST bodies for GraphQL / JSON
      );

      log("webRequest assist active (eBay/Zara/Mango)");
    }
  } catch (e) {
    console.error("[UnifiedCart] webRequest listener setup error:", e);
  }

  log(`SW v${VERSION} ready`);
})();