// background.js — Unified Cart (MV3)
// v0.4.7 (MV3-safe webRequest; SFCC/eBay/Zara/Mango/UNIQLO; J.Crew GraphQL + hotness; A&F BFF)

(() => {
  const VERSION = "0.4.7";
  // at the top of background.js
  const DEBUG = true; // flip to false to quiet non-error logs
  const log      = DEBUG ? (...a) => console.log("[UnifiedCart]", ...a) : () => {};
const logWarn  = DEBUG ? (...a) => console.warn("[UnifiedCart]", ...a) : () => {};
const logError = (...a) => console.error("[UnifiedCart]", ...a); // keep errors always-on
  const str = (x) => (x == null ? "" : String(x));
  const ENABLE_NOTIFICATIONS = false;

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

  // ---------------- Brand & price normalization (lenient) ----------------
  const USD_HOSTS = /(\.|^)(jcrewfactory|jcrew|abercrombiekids|abercrombie|hollisterco|anf|uniqlo)\.com$/i;
  const CURRENCY_HINT = /[$€£¥₹]|usd|eur|gbp|cad|aud|chf|sek|nok|dkk|inr/i;

  function normalizePrice(raw, link) {
    let s = str(raw).trim();
    if (!s) return "";
    if (CURRENCY_HINT.test(s)) return s;
    let symbol = "$";
    try {
      const host = new URL(String(link || "")).hostname;
      if (!USD_HOSTS.test(host)) symbol = "$";
    } catch {}
    return symbol + s.replace(/\s+/g, "");
  }

  const BRAND_CANON = {
    "jcrew": "J.Crew",
    "j.crew": "J.Crew",
    "jcrew factory": "J.Crew Factory",
    "jcrewfactory": "J.Crew Factory",
    "abercrombie": "Abercrombie",
    "abercrombie & fitch": "Abercrombie & Fitch",
    "abercrombiekids": "Abercrombie Kids",
    "abercrombie kids": "Abercrombie Kids",
    "hollister": "Hollister",
    "hollisterco": "Hollister",
    "uniqlo": "Uniqlo"
  };

  function inferBrandFromLink(link) {
    try {
      const host = new URL(String(link || "")).hostname.toLowerCase();
      if (host.endsWith("jcrew.com")) return "J.Crew";
      if (host.endsWith("jcrewfactory.com")) return "J.Crew Factory";
      if (host.endsWith("abercrombie.com")) return "Abercrombie";
      if (host.endsWith("abercrombiekids.com")) return "Abercrombie Kids";
      if (host.endsWith("hollisterco.com")) return "Hollister";
      if (host.endsWith("anf.com")) return "Abercrombie";
      if (host.endsWith("uniqlo.com")) return "Uniqlo";
    } catch {}
    return "";
  }

  function canonBrand(raw, link) {
    const v = str(raw).trim();
    if (!v) return inferBrandFromLink(link);
    const low = v.toLowerCase();
    if (BRAND_CANON[low]) return BRAND_CANON[low];
    return v.replace(/\b\w/g, c => c.toUpperCase());
  }

  // ---------------- tiny helpers ----------------
  function isTrackingImage(url = "") {
    const u = str(url).toLowerCase();
    return !u || u.startsWith("data:") || u.endsWith(".svg") || /p13n\.gif|pixel|1x1|spacer|beacon/.test(u);
  }

  // Be lenient so legacy sites still add: only drop if *no useful data at all*
  function looksLikeNoise(item = {}) {
    const noTitle = !str(item.title).trim();
    const noLink  = !str(item.link).trim();
    const noiseImg = isTrackingImage(item.img);
    return noTitle && (noLink || noiseImg);
  }

  function sanitizeItem(raw = {}) {
    const link = str(raw.link);
    const item = {
      id:   str(raw.id || link || ""),
      pid:  str(raw.pid || ""),
      title:str(raw.title),
      brand: canonBrand(raw.brand, link),
      price: normalizePrice(raw.price, link),
      img:  str(raw.img),
      link
    };
    if (!item.brand) item.brand = inferBrandFromLink(link);
    if (item.img && item.img.length > 2048 && item.img.startsWith("data:")) item.img = "";
    return item;
  }

  // ---------- PDP guards (Amazon/Walmart/Zara only; others pass) ----------
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

  // ---------- Obvious non-PDP URL filter (gentle) ----------
  function isLikelyProductUrl(link) {
    try {
      const { hostname, pathname } = new URL(String(link || ""));
      const host = hostname.toLowerCase();
      const p = pathname.toLowerCase();

      if (p.includes("/collections/") && !p.includes("/products/")) return false; // Shopify
      if (/(\.|^)theoutnet\.com$/.test(host)) {
        if (/\/shop(\/|$)/.test(p) && !/\/product(\/|$)/.test(p)) return false;
      }
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
  const PENDING_SFCC = new Map();
  function retryTabNudge(tabId, payload) {
    const delays = [0, 200, 600, 1500];
    for (const d of delays) {
      setTimeout(() => {
        safeTabsSendMessage(tabId, { action: "SFCC_NETWORK_NUDGE", data: payload }, { frameId: 0 });
      }, d);
    }
  }
  function setPendingNudge(tabId, data) {
    PENDING_SFCC.set(tabId, data);
    setTimeout(() => {
      const cur = PENDING_SFCC.get(tabId);
      if (cur && cur.ts === data.ts) PENDING_SFCC.delete(tabId);
    }, 7000);
  }

  // General-purpose “ADD_TRIGGERED” retry (used by UNIQLO/eBay/Zara/Mango)
  function retryAddTriggered(tabId, url) {
    const delays = [0, 200, 600, 1500];
    for (const d of delays) {
      setTimeout(() => {
        safeTabsSendMessage(tabId, { action: "ADD_TRIGGERED", via: "webRequest", url }, { frameId: 0 });
      }, d);
    }
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
        if (!SHOPPING_MODE) { try { sendResponse({ ok: true, ignored: true, reason: "mode_off" }); } catch {}; return; }
        const tabId = sender?.tab?.id;
        if (Number.isInteger(tabId) && shouldNudge(tabId)) {
          safeTabsSendMessage(tabId, { action: "ADD_TRIGGERED", via: msg.via || "inpage", url: msg.url }, { frameId: 0 });
        }
        try { sendResponse({ ok: true }); } catch {}
        return;
      }

      if (msg?.action === "ADD_ITEM" && msg.item) {
        if (!SHOPPING_MODE) { try { sendResponse({ ok: true, ignored: true, reason: "mode_off" }); } catch {}; return; }

        const item = sanitizeItem(msg.item);
        if (looksLikeNoise(item)) { try { sendResponse({ ok: true, ignored: true, reason: "noise" }); } catch {}; return; }
        if (item.link && !isLikelyProductUrl(item.link) && msg.source !== "sfcc") {
          try { sendResponse({ ok: true, ignored: true, reason: "non_pdp" }); } catch {}; return;
        }
        if (!passesPDPGuards(item.link)) { try { sendResponse({ ok: true, ignored: true, reason: "guard" }); } catch {}; return; }

        const keyId = str(item.id);
        const keyLink = str(item.link);
        const key = (keyId || keyLink).toLowerCase();

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

        chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
          if (msg && msg.action === "INJECT_INPAGE_HOOK" && sender?.tab?.id) {
             chrome.scripting.executeScript({
              target: { tabId: sender.tab.id, allFrames: true },
              files: ["Inpage/pageHook.inpage.js"],
              world: "MAIN"
            }).then(() => {
            sendResponse({ ok: true });
            }).catch((err) => {
            console.warn("[UnifiedCart] executeScript failed", err);
            sendResponse({ ok: false, error: String(err) });
            });
        return true; // keep the channel open for async sendResponse
      }
  });

  // ---------------- webRequest assist (SFCC + eBay + Zara + Mango + UNIQLO) ----------------
  try {
    if (chrome.webRequest?.onBeforeRequest?.addListener) {

      function decodeBody(details) {
        try {
          const rb = details.requestBody;
          if (!rb) return "";
          if (rb.formData) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(rb.formData)) {
              params.set(k, Array.isArray(v) ? v[0] : v);
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

      // ---------- SFCC (Demandware) + A&F BFF + J.Crew GraphQL ----------
      const RE_HOST_SFCC = /(\.|^)(jcrewfactory|jcrew|abercrombiekids|abercrombie|hollisterco|anf)\.com$/i;
      const SFCC_URL_RE  = /\/on\/demandware\.store\/.*\/(?:Cart-(?:Add|AddMultiple)Product|AddToCart|ProductList-AddProduct)\b/i;
      const OCAPI_ADD_RE = /\/(?:s\/-\/)?dw\/shop\/v\d+(?:_\d+)?\/baskets\/[^/]+\/items\b/i;
      const SCAPI_ADD_RE = /\/api\/checkout\/v\d+(?:\.\d+)?\/baskets\/[^/]+(?:\/shipments\/[^/]+)?\/(?:items|line-items)\b/i;

      const RE_AF_HOST    = /(\.|^)(abercrombie|abercrombiekids|hollisterco)\.com$/i;
      const RE_BFF_ADDURL = /\/api\/bff\/(cart|checkout|bag|basket|orders?|commerce)\b/i;

      const RE_JCREW_HOST    = /(\.|^)jcrew\.com$/i;
      const RE_JCREW_GRAPHQL = /\/checkout-api\/graphql\b/i;
      const RE_JCREW_HOT_ADD = /\/hotness\/api\/hotness\?[^#]*\btype=addtobag\b/i;

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
            const first = rb.raw.find(p => p?.bytes);
            if (first?.bytes) {
              const text = new TextDecoder("utf-8").decode(first.bytes);
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

            if (!RE_HOST_SFCC.test(host)) return;

            if (DEBUG) log("SFCC observe", m, host, url);

            let isAdd =
              SFCC_URL_RE.test(url) ||
              OCAPI_ADD_RE.test(url) ||
              SCAPI_ADD_RE.test(url);

            // A&F/Hollister BFF cart mutations
            if (!isAdd && RE_AF_HOST.test(host) && RE_BFF_ADDURL.test(url)) {
              const bodyStr = decodeBody(details);
              const looksLikeAdd =
                /\b(addToCart|addToBag|addItem|addLineItem|cartAdd|addCartEntry)\b/i.test(bodyStr) ||
                (/\b(product|productId|pid|sku|variant|id)\b/i.test(bodyStr) && /\b(qty|quantity)\b/i.test(bodyStr)) ||
                /[?&]page=mini\b/i.test(url);
              if (looksLikeAdd) {
                isAdd = true;
                if (DEBUG) log("A&F BFF match", url);
              }
            }

            // J.Crew GraphQL cart mutations / hotness beacon
            if (!isAdd && RE_JCREW_HOST.test(host) && RE_JCREW_GRAPHQL.test(url)) {
              const bodyStr = decodeBody(details);
              if (/\b(addToBag|addToCart|addItem|addLineItem|addCartEntry|createBasket)\b/i.test(bodyStr)) {
                isAdd = true;
                if (DEBUG) log("J.Crew GraphQL match", url);
              }
            }
            if (!isAdd && RE_JCREW_HOST.test(host) && RE_JCREW_HOT_ADD.test(url)) {
              isAdd = true; if (DEBUG) log("J.Crew hotness add signal", url);
            }

            if (!isAdd) return;

            if (DEBUG) log("SFCC match", url);

            const { pid, quantity } = parseSfccRequestBody(details);
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
        { urls: ["*://*.jcrew.com/*","*://*.jcrewfactory.com/*","*://*.abercrombie.com/*","*://*.abercrombiekids.com/*","*://*.hollisterco.com/*","*://*.anf.com/*"], types: ["xmlhttprequest","ping","sub_frame","main_frame","other"] },
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
                if (tabId >= 0 && shouldNudge(tabId)) {
                  log("webRequest assist (eBay) hit:", u);
                  retryAddTriggered(tabId, u);
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
                  if (shouldNudge(tabId)) {
                    log("webRequest assist (Zara) hit:", u);
                    retryAddTriggered(tabId, u);
                  }
                } else {
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
              if (shouldNudge(tabId) && (/graphql|api\/graphql|\/gateway/i.test(u) || /\/carts?\/(?:current|[a-z0-9-]+)\/entries\b/i.test(u))) {
                log("webRequest assist (Mango) hit:", u);
                retryAddTriggered(tabId, u);
              }
            }
          } catch {}
        },
        { urls: ["*://*.mango.com/*", "*://shop.mango.com/*"], types: ["xmlhttprequest","ping","sub_frame","main_frame","other"] },
        ["requestBody"]
      );

     // ---------- UNIQLO (incl. elgnisolqinu/fastretailing; SW-safe) ----------
const RE_UNIQLO_HOST       = /(\.|^)(uniqlo|elgnisolqinu|fastretailing)\.com$/i;
const RE_UNIQLO_ADD_PATH   = /\/(?:(?:api\/(?:commerce|internal)\/[^/]+\/)?cart(?:s)?|basket|bag)\/(?:add|add-item|addItem|items?|lines|line-items|insert|insert-or-update)\b/i;
const RE_UNIQLO_GRAPHQL    = /\/graphql\b/i;
const RE_UNIQLO_GQL_TOKENS = /\b(addToCart|addBagItem|addToBasket|addCartItem|addItemToCart|cartLinesAdd|cartAdd)\b/i;

function decodeBody(req) {
  try {
    if (req.requestBody?.formData) return JSON.stringify(req.requestBody.formData);
    const raw = req.requestBody?.raw?.[0]?.bytes;
    if (raw) return new TextDecoder("utf-8").decode(raw);
  } catch {}
  return "";
}

function nudgeUniqloTabsAny(tabIdMaybe) {
  const send = (id) => safeTabsSendMessage(id, { action: "ADD_TRIGGERED_BROADCAST", host: "uniqlo" }, { frameId: 0 });
  if (typeof tabIdMaybe === "number" && tabIdMaybe >= 0) { send(tabIdMaybe); return; }
  try {
    chrome.tabs.query({ url: ["*://*.uniqlo.com/*"] }, (tabs) => {
      for (const t of tabs || []) send(t.id);
    });
  } catch {}
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      if (!SHOPPING_MODE) return;

      const method = (details.method || "").toUpperCase();
      if (!(method === "POST" || method === "PUT" || method === "PATCH")) return;

      const url = String(details.url || "");
      let host = "";
      try { host = new URL(url).hostname; } catch {}
      if (!RE_UNIQLO_HOST.test(host)) return;

      // Path hit OR GraphQL op-name in body
      let isAdd = RE_UNIQLO_ADD_PATH.test(url);
      if (!isAdd && RE_UNIQLO_GRAPHQL.test(url)) {
        const bodyStr = decodeBody(details);
        if (RE_UNIQLO_GQL_TOKENS.test(bodyStr)) isAdd = true;
      }
      if (!isAdd) return;

      log("webRequest assist (UNIQLO) hit:", url, "tabId:", details.tabId);
      nudgeUniqloTabsAny(details.tabId);       // <- handles tabId === -1 too
      // optional: keep your old retry pattern as a secondary nudge
      // if (details.tabId >= 0 && shouldNudge(details.tabId)) retryAddTriggered(details.tabId, url);
    } catch {}
  },
  { urls: ["*://*.uniqlo.com/*"], types: ["xmlhttprequest", "ping"] },
  ["requestBody"]
);

      log("webRequest assist active (SFCC/eBay/Zara/Mango/UNIQLO)");
    }
  } catch (e) {
    console.error("[UnifiedCart] webRequest listener setup error:", e);
  }

  log(`SW v${VERSION} ready`);
})();