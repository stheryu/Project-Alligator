// content-scripts/walmartAddListener.js
(() => {
  // Top frame only; also set all_frames:false in manifest for Walmart
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Walmart] (top)", ...a);

  // Is extension context alive? (avoids errors after extension reload)
  const HAS_EXT = !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);

  // --- page guards ---
  const isWalmartPDPPath = () => /^\/ip\//i.test(location.pathname);

  // --- safe send; allow storage fallback only on PDP (never on category/search) ---
  function saveToStorageDirect(item) {
    if (!isWalmartPDPPath()) {
      log("skip storage fallback: not a PDP", location.pathname);
      return;
    }
    if (!chrome?.storage?.sync) {
      log("skip storage fallback: chrome.storage unavailable (context invalidated)");
      return;
    }
    try {
      chrome.storage.sync.get({ cart: [] }, (res) => {
        let items = Array.isArray(res.cart) ? res.cart : [];
        const id = String(item.id || "");
        const link = String(item.link || "");
        items = items.filter(it => String(it.id||"") !== id && String(it.link||"") !== link);
        items.push(item);
        chrome.storage.sync.set({ cart: items });
      });
    } catch (e) { log("storage fallback error:", e); }
  }

  function sendItemSafe(item) {
    if (!HAS_EXT) {
      log("sendItemSafe: extension context invalidated — refresh the page and try again.");
      return;
    }
    try {
      chrome.runtime.sendMessage({ action: "ADD_ITEM", item }, () => {
        if (chrome.runtime?.lastError) {
          log("sendMessage lastError → fallback:", chrome.runtime.lastError.message);
          // Fallback allowed only on PDP
          saveToStorageDirect(item);
        }
      });
    } catch (e) {
      log("sendItemSafe exception → fallback:", e);
      // Fallback allowed only on PDP
      saveToStorageDirect(item);
    }
  }

  // --- extractors ---
  const $   = (s) => document.querySelector(s);
  const txt = (s) => $(s)?.textContent?.trim() || "";
  const attr= (s,n)=> $(s)?.getAttribute(n) || "";
  const token = (s) => (String(s).match(/[$€£]\s?\d[\d,]*(?:\.\d{2})?/) || [""])[0];

  const normT = (t) => (Array.isArray(t) ? t : (t ? [t] : [])).map(v => String(v).toLowerCase());
  function findProductNode(node) {
    try {
      if (!node || typeof node !== "object") return null;
      if (normT(node["@type"]).includes("product")) return node;
      if (Array.isArray(node)) { for (const x of node) { const hit = findProductNode(x); if (hit) return hit; } }
      else {
        if (node["@graph"]) { const hit = findProductNode(node["@graph"]); if (hit) return hit; }
        for (const k of Object.keys(node)) { const hit = findProductNode(node[k]); if (hit) return hit; }
      }
    } catch {}
    return null;
  }
  function parseLD() {
    const scripts = Array.from(document.querySelectorAll('script[type*="ld+json"]'));
    for (const s of scripts) {
      try {
        const raw = (s.textContent || "").trim(); if (!raw) continue;
        const json = JSON.parse(raw);
        const prod = findProductNode(json);
        if (prod) return prod;
      } catch {}
    }
    return null;
  }

  function extractTitle() {
    return txt('h1[data-automation-id="product-title"]')
        || txt("h1[itemprop='name']")
        || attr('meta[property="og:title"]', "content")
        || txt("h1")
        || document.title;
  }
  function extractPrice() {
    const ld = parseLD();
    if (ld?.offers) {
      const offers = Array.isArray(ld.offers) ? ld.offers : [ld.offers];
      for (const o of offers) {
        const p = o.price || o.lowPrice || o.highPrice || o?.priceSpecification?.price;
        if (p != null && p !== "") {
          const n = Number(p);
          return Number.isFinite(n) ? `$ ${n.toFixed(2)}` : token(p);
        }
      }
    }
    const mp = attr('meta[itemprop="price"]', "content")
            || attr('meta[property="product:price:amount"]', "content")
            || attr('meta[property="og:price:amount"]', "content");
    if (mp) {
      const n = Number(mp);
      return Number.isFinite(n) ? `$ ${n.toFixed(2)}` : token(mp);
    }
    const cand = [
      '[data-automation-id="ppd-new-price"] [aria-hidden="true"]',
      '[data-automation-id="product-price"]',
      '[data-testid="price"]'
    ].map(txt).find(Boolean);
    if (cand) return token(cand) || cand;
    return "";
  }
  function extractImage() {
    const og = attr('meta[property="og:image"]', "content");
    if (og) return og;
    const main = $('img[data-automation-id="main-image"]')
              || $('img[src*="walmartimages"]')
              || (document.querySelector("picture img") || document.querySelector("img"));
    return main?.getAttribute?.("src") || main?.src || "";
  }
  function extractBrand() {
    const ld = parseLD();
    if (ld?.brand) {
      if (typeof ld.brand === "string") return ld.brand;
      if (ld.brand.name) return ld.brand.name;
    }
    return txt('a[data-automation-id="brand-link"]') || txt("[data-testid='brandName']") || "";
  }
  function buildItem() {
    return {
      id: location.href,
      title: extractTitle(),
      brand: extractBrand(),
      price: extractPrice(),
      img: extractImage(),
      link: location.href
    };
  }

  // --- dual-shot scrape (quick + settled) ---
  let sentQuick = false, sentSettled = false;
  let lastKey = "", lastAt = 0;
  const debounce = (key, ms) => { const now = Date.now(); if (key === lastKey && now - lastAt < ms) return false; lastKey = key; lastAt = now; return true; };
  function settleThenScrape(ms = 900) {
    return new Promise((resolve) => {
      let resolved = false;
      const initial = buildItem();
      if (initial.price || initial.img) { resolved = true; return resolve(initial); }
      const timer = setTimeout(() => { if (!resolved) { resolved = true; obs.disconnect(); resolve(buildItem()); } }, ms);
      const obs = new MutationObserver(() => {
        if (resolved) return;
        const item = buildItem();
        if (item.price || item.img) { clearTimeout(timer); resolved = true; obs.disconnect(); resolve(item); }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    });
  }
  function sendQuick(reason = "ui-quick") {
    if (!isWalmartPDPPath()) return;  // <— local PDP guard
    if (sentQuick) return;
    const key = location.href;
    if (!debounce(key, 200)) return;
    const item = buildItem(); if (!item.title) return;
    log("ADD_ITEM", reason, item);
    sendItemSafe(item);
    sentQuick = true;
  }
  async function sendSettled(reason = "ui-settled") {
    if (!isWalmartPDPPath()) return;  // <— local PDP guard
    if (sentSettled) return;
    const key = location.href;
    if (!debounce(key, 600)) {}
    const item = await settleThenScrape(900); if (!item.title) return;
    log("ADD_ITEM", reason, item);
    sendItemSafe(item);
    sentSettled = true;
  }

  // --- button detection (tight) ---
  const BUTTON_SELECTORS = [
    '[data-automation-id="add-to-cart"]',
    'button[data-automation-id="add-to-cart"]',
    'button[data-testid="add-to-cart"]',
    'button[data-tl-id*="ProductPrimaryCTA"]',
    '[aria-label*="add to cart" i]',
    'button[id*="add-to-cart" i]'
  ];

  // positive: "add to cart", "buy now"; negative: noisy "add ..." actions
  const ADD_TEXT_POS_RE = /\badd to cart\b|\bbuy now\b/i;
  const ADD_TEXT_NEG_RE = /\b(add to list|add to registry|add address|add payment|add a card|add to favorites|add to wish|add to wishlist|add-on item)\b/i;

  function nodeLooksLikeAdd(node) {
    if (!node || node.nodeType !== 1) return false;

    // Direct selector hit first
    for (const sel of BUTTON_SELECTORS) {
      if (node.matches?.(sel)) {
        const s = (node.textContent || "").toLowerCase();
        return ADD_TEXT_NEG_RE.test(s) ? false : true;
      }
    }

    const s = [
      node.textContent || "",
      node.getAttribute?.("aria-label") || "",
      node.getAttribute?.("data-automation-id") || "",
      node.getAttribute?.("data-testid") || "",
      node.getAttribute?.("data-tl-id") || "",
      node.getAttribute?.("id") || "",
      node.getAttribute?.("name") || "",
      node.getAttribute?.("class") || ""
    ].join(" ").toLowerCase();

    if (s.includes("adding")) return false;
    if (ADD_TEXT_NEG_RE.test(s)) return false;
    return ADD_TEXT_POS_RE.test(s);
  }

  function findAddNodeInPath(e) {
    const path = (e.composedPath && e.composedPath()) || [];
    for (const n of path) if (nodeLooksLikeAdd(n)) return n;
    for (const sel of BUTTON_SELECTORS) {
      const cand = document.querySelector(sel);
      if (cand && nodeLooksLikeAdd(cand)) return cand;
    }
    return null;
  }

  function early(e) { if (findAddNodeInPath(e)) sendQuick("ui-quick"); }
  function late(e)  { if (findAddNodeInPath(e)) setTimeout(() => sendSettled("ui-settled"), 140); }

  // Only listen on PDPs to reduce noise
  ["mousedown","pointerdown","touchstart"].forEach(t => document.addEventListener(t, early, true));
  ["click","pointerup","touchend","submit","keydown"].forEach(t => document.addEventListener(t, late, true));

  // Respect background webRequest nudges only on PDPs
  chrome.runtime?.onMessage?.addListener?.((msg) => {
    if (msg?.action === "ADD_TRIGGERED" && isWalmartPDPPath()) {
      setTimeout(() => sendSettled("webRequest"), 150);
    }
  });

  // Debug helper
  window.__UC_WM_DEBUG = () => {
    const item = buildItem();
    const isPDP = isWalmartPDPPath();
    const buttons = BUTTON_SELECTORS.map(sel => !!document.querySelector(sel));
    console.log("[UnifiedCart-Walmart] DEBUG", { isPDP, buttons, href: location.href, item });
    return { isPDP, buttons, href: location.href, item };
  };

  log("loaded; gated to PDP; narrowed add matcher; fallback only on PDP");
})();