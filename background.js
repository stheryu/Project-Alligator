// background.js — Unified Cart (MV3)
// v0.4.3  (SFCC acceptance loosened; brand inference; light "Arrivals" guard; A&F BFF; pending-nudge; MV3-safe types)

(() => {
  const VERSION = "0.4.3";
  const DEBUG = true; // turn off when done
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

  // ---------------- helpers ----------------
  function isTrackingImage(url = "") {
    const u = url.toLowerCase();
    return !u || u.startsWith("data:") || u.endsWith(".svg") || /p13n\.gif|pixel|1x1|spacer|beacon/.test(u);
  }
  function looksLikeNoise(item = {}) {
    const t = str(item.title).toLowerCase();
    const p = str(item.price).trim();
    return !p && (isTrackingImage(item.img) || /p13n|1×1|1x1|pixel/.test(t));
  }
  function inferBrandFromLink(link = "") {
    let h = "";
    try { h = new URL(link).hostname.toLowerCase(); } catch {}
    if (!h) return "";
    if (/\bamazon\.com$/.test(h)) return "Amazon";
    if (/\bebay\.com$/.test(h)) return "eBay";
    if (/\bwalmart\.com$/.test(h)) return "Walmart";
    if (/\bzara\.com$/.test(h)) return "Zara";
    if (/\bmango\.com$/.test(h)) return "Mango";
    if (/\bjcrewfactory\.com$/.test(h)) return "J.Crew Factory";
    if (/\bjcrew\.com$/.test(h)) return "J.Crew";
    if (/\bhollisterco\.com$/.test(h)) return "Hollister";
    if (/\babercrombie(kids)?\.com$/.test(h)) return "Abercrombie";
    return h.split(".").slice(-2, -1)[0]?.replace(/^\w/, c => c.toUpperCase()) || "";
  }
  function sanitizeItem(raw = {}) {
    const item = {
      id:   str(raw.id || raw.link || ""),
      pid:  str(raw.pid || ""),
      title:str(raw.title),
      brand:str(raw.brand),
      price:str(raw.price),
      img:  str(raw.img),
      link: str(raw.link),
    };
    if (!item.brand) item.brand = inferBrandFromLink(item.link);
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

  // >>> pending-nudge helpers (SFCC navigation-safe) <<<
  function retryTabNudge(tabId, payload) {
    const delays = [0, 200, 600, 1500]; // simple backoff
    for (const d of delays) {
      setTimeout(() => {
        safeTabsSendMessage(tabId, { action: "SFCC_NETWORK_NUDGE", data: payload }, { frameId: 0 });
      }, d);
    }
  }
  const PENDING_SFCC = new Map();
  function setPendingNudge(tabId, data) {
    PENDING_SFCC.set(tabId, data);
    setTimeout(() => {
      const cur = PENDING_SFCC.get(tabId);
      if (cur && cur.ts === data.ts) PENDING_SFCC.delete(tabId);
    }, 7000);
  }

  // ---------------- messages ----------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      if (msg?.action === "SFCC_QUERY_PENDING") {
        const tabId = sender?.tab?.id;
        const data = Number.isInteger(tabId) ? PENDING_SFCC.get(tabId) : null;
        try { sendResponse({ ok: true, data }); } catch {}
        return;
      }

      if (msg?.action === "PING") {
        try { sendResponse({ ok: true, version: VERSION }); } catch {}
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

        const source = msg.source || "unknown";
        const item = sanitizeItem(msg.item);

        // obvious noise (pixels etc)
        if (looksLikeNoise(item)) {
          if (DEBUG) log("ignore add: noise", item);
          try { sendResponse({ ok: true, ignored: true, reason: "noise" }); } catch {};
          return;
        }

        // For non-SFCC sources, enforce likely-PDP URL
        if (source !== "sfcc" && item.link && !isLikelyProductUrl(item.link)) {
          if (DEBUG) log("ignore add: non_pdp (non-sfcc)", item.link);
          try { sendResponse({ ok: true, ignored: true, reason: "non_pdp" }); } catch {};
          return;
        }

        // For SFCC: allow through even without pid/price, but drop obvious category/arrivals page if no pid
        if (source === "sfcc" && !item.pid) {
          const title = str(item.title).toLowerCase();
          if (/arrivals|new\s+(in|arrivals)|just\s+in|lookbook/.test(title)) {
            if (DEBUG) log("ignore add: sfcc_category_like_title", title);
            try { sendResponse({ ok: true, ignored: true, reason: "sfcc_category_like_title" }); } catch {};
            return;
          }
        }

        // Brand-specific PDP guards still apply (Amazon/Walmart/Zara)
        if (!passesPDPGuards(item.link)) {
          if (DEBUG) log("ignore add: guard", item.link);
          try { sendResponse({ ok: true, ignored: true, reason: "guard" }); } catch {};
          return;
        }

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

  // ---------------- webRequest assist (SFCC + eBay + Zara + Mango) ----------------
  try {
    if (chrome.webRequest?.onBeforeRequest?.addListener) {
      const recent = new Map();
      const shouldNotify = (tabId, ms = 1200) => {
        const t = Date.now(); const last = recent.get(tabId) || 0;
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
          if (rb.raw && rb.raw.length) {
            const first = rb.raw.find(p => p?.bytes);
            if (first?.bytes) return new TextDecoder("utf-8").decode(first.bytes);
          }
        } catch {}
        return "";
      }

      // ---------- SFCC (Demandware) ----------
      const RE_HOST_SFCC = /(\.|^)(jcrewfactory|jcrew|abercrombiekids|abercrombie|hollisterco|anf)\.com$/i;

      const SFCC_URL_RE  = /\/on\/demandware\.store\/.*\/(?:Cart-(?:Add|AddMultiple)Product|AddToCart|ProductList-AddProduct)\b/i;
      const OCAPI_ADD_RE = /\/(?:s\/-\/)?dw\/shop\/v\d+(?:_\d+)?\/baskets\/[^/]+\/items\b/i;
      // Sometimes /api/checkout/vX[.Y]/baskets/{id}/(items|line-items) with optional shipments
      const SCAPI_ADD_RE = /\/api\/checkout\/v\d+(?:\.\d+)?\/baskets\/[^/]+(?:\/shipments\/[^/]+)?\/(?:items|line-items)\b/i;

      // Abercrombie/Hollister BFF add intents
      const RE_AF_HOST    = /(\.|^)(abercrombie|abercrombiekids|hollisterco)\.com$/i;
      const RE_BFF_ADDURL = /\/api\/bff\/(cart|checkout|bag|basket|orders?|commerce|customer|product)\b/i;

      function parseSfccRequestBody(details) {
        let pid = null, quantity = 1;
        try {
          const rb = details.requestBody;
          if (!rb) return { pid, quantity };

          if (rb.formData) {
            const fd = rb.formData;
            pid = (fd.pid?.[0] || fd.product_id?.[0] || fd.productID?.[0] || fd.id?.[0] || fd.masterPid?.[0]) || null;
            quantity = Number(fd.quantity?.[0] || fd.qty?.[0] || fd.Qty?.[0] || 1);
            return { pid, quantity };
          }

          if (rb.raw && rb.raw.length) {
            const parts = rb.raw.filter(p => p?.bytes).map(p => new Uint8Array(p.bytes));
            if (parts.length) {
              const total = parts.reduce((n, u8) => n + u8.length, 0);
              const buf = new Uint8Array(total); let off = 0;
              for (const u8 of parts) { buf.set(u8, off); off += u8.length; }
              const text = new TextDecoder("utf-8").decode(buf);

              try {
                const json = JSON.parse(text);
                if (Array.isArray(json.items) && json.items.length) {
                  const it = json.items[0];
                  pid = it.product_id || it.pid || it.id || null;
                  quantity = Number(it.quantity || 1);
                  return { pid, quantity };
                }
                pid = json.pid || json.product_id || json.productID || json.id || json.masterPid || pid;
                quantity = Number(json.quantity || json.qty || quantity);
                return { pid, quantity };
              } catch {
                const kv = new URLSearchParams(text);
                pid = kv.get("pid") || kv.get("product_id") || kv.get("productID") || kv.get("id") || kv.get("masterPid") || pid;
                quantity = Number(kv.get("quantity") || kv.get("qty") || kv.get("Qty") || quantity);
                return { pid, quantity };
              }
            }
          }
        } catch {}
        return { pid, quantity };
      }

      chrome.webRequest.onBeforeRequest.addListener(
        (details) => {
          try {
            if (!SHOPPING_MODE) return;

            const { url, method, tabId } = details;
            const m = (method || "").toUpperCase();
            if (!(m === "POST" || m === "PUT" || m === "PATCH")) return;

            let host = "";
            try { host = new URL(url).hostname; } catch {}

            // Only watch the SFCC family of hosts to reduce noise
            if (!RE_HOST_SFCC.test(host)) return;

            if (DEBUG) log("SFCC observe", m, host, url);

            // 1) Standard SFCC adds
            let isAdd =
              SFCC_URL_RE.test(url) ||
              OCAPI_ADD_RE.test(url) ||
              SCAPI_ADD_RE.test(url);

            // 2) Abercrombie/Hollister BFF-style adds (customer/product/checkout endpoints are involved)
            if (!isAdd && RE_AF_HOST.test(host) && RE_BFF_ADDURL.test(url)) {
              const bodyStr = decodeBody(details);
              const looksLikeAdd =
                /\b(addToCart|addToBag|addItem|addLineItem|cartAdd|addCartEntry)\b/i.test(bodyStr) ||
                (/\b(product|productId|pid|sku|variant|id)\b/i.test(bodyStr) && /\b(qty|quantity)\b/i.test(bodyStr)) ||
                /[?&]page=mini\b/i.test(url); // mini-cart refresh after add
              if (looksLikeAdd) {
                isAdd = true;
                if (DEBUG) log("A&F BFF match", url, bodyStr ? bodyStr.slice(0, 180) : "");
              }
            }

            if (!isAdd) return;

            if (DEBUG) log("SFCC match", url);

            const { pid, quantity } = parseSfccRequestBody(details); // may be null → okay
            const payload = { url, pid, quantity: Number(quantity) || 1, ts: Date.now() };

            if (tabId >= 0) {
              setPendingNudge(tabId, payload);
              retryTabNudge(tabId, payload);
              if (DEBUG) log("SFCC nudge queued", { tabId, payload });
            }
          } catch (e) {
            if (DEBUG) log("SFCC handler error", e);
          }
        },
        // MV3-valid types only
        { urls: ["<all_urls>"], types: ["xmlhttprequest","ping","sub_frame","main_frame","other"] },
        ["requestBody"]
      );

      // ---------- eBay ----------
      chrome.webRequest.onBeforeRequest.addListener(
        (details) => {
          try {
            if (!SHOPPING_MODE) return;

            const method = (details.method || "").toUpperCase();
            if (!(method === "POST" || method === "PUT" || method === "PATCH")) return;

            const u = String(details.url || "");
            const host = (() => { try { return new URL(u).hostname; } catch { return ""; } })();

            if (/(\.|^)ebay\.com$/i.test(host)) {
              if (/\/(cart\/(add|ajax|addtocart)|AddToCart|shoppingcart|basket\/add)\b/i.test(u)) {
                const tabId = details.tabId;
                if (tabId >= 0 && shouldNotify(tabId)) {
                  log("webRequest assist (eBay) hit:", u);
                  safeTabsSendMessage(tabId, { action: "ADD_TRIGGERED", via: "webRequest", url: u }, { frameId: 0 });
                }
              }
            }
          } catch {}
        },
        { urls: ["*://*.ebay.com/*"], types: ["xmlhttprequest","ping","sub_frame","main_frame","other"] },
        ["requestBody"]
      );

      // ---------- Zara ----------
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

            if (/(\.|^)zara\.(com|net)$/i.test(host)) {
              const bodyStr = (() => { try { return decodeBody(details); } catch { return ""; } })();
              const hit = isZaraAddUrl(u) || hasAddIntentBody(bodyStr);
              if (hit) {
                const tabId = details.tabId;
                if (tabId >= 0) {
                  if (shouldNotify(tabId)) {
                    log("webRequest assist (Zara) hit:", u);
                    safeTabsSendMessage(tabId, { action: "ADD_TRIGGERED", via: "webRequest", url: u }, { frameId: 0 });
                  }
                } else {
                  // sandboxed subframe
                  log("webRequest assist (Zara) broadcast (tabId=-1):", u);
                  safeRuntimeSendMessage({ action: "ADD_TRIGGERED_BROADCAST", host: "zara", url: u });
                }
              }
            }
          } catch {}
        },
        { urls: ["*://*.zara.com/*", "*://*.zara.net/*"], types: ["xmlhttprequest","ping","sub_frame","main_frame","other"] },
        ["requestBody"]
      );

      // ---------- Mango ----------
      chrome.webRequest.onBeforeRequest.addListener(
        (details) => {
          try {
            if (!SHOPPING_MODE) return;

            const method = (details.method || "").toUpperCase();
            if (!(method === "POST" || method === "PUT" || method === "PATCH")) return;

            const u = String(details.url || "");
            const host = (() => { try { return new URL(u).hostname; } catch { return ""; } })();

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
            }
          } catch {}
        },
        { urls: ["*://*.mango.com/*", "*://shop.mango.com/*"], types: ["xmlhttprequest","ping","sub_frame","main_frame","other"] },
        ["requestBody"]
      );

      log("webRequest assist active (SFCC/eBay/Zara/Mango)");
    }
  } catch (e) {
    console.error("[UnifiedCart] webRequest listener setup error:", e);
  }

  log(`SW v${VERSION} ready`);
})();