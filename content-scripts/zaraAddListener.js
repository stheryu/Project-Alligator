// content-scripts/zaraAddListener.js
(() => {
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Zara] (top)", ...a);

  // Is the extension context alive?
  const HAS_EXT = !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);

  // --- safe send (guards for invalid context) ---
  function saveToStorageDirect(item) {
    // If the extension context is invalidated (after reload),
    // chrome.storage is not available — so just no-op to avoid throwing.
    if (!chrome?.storage?.sync) {
      log("storage fallback skipped: chrome.storage unavailable (context invalidated)");
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
          saveToStorageDirect(item);
        }
      });
    } catch (e) {
      log("sendItemSafe exception → fallback:", e);
      saveToStorageDirect(item);
    }
  }

  // --- extractors (OG/JSON-LD/meta) ---
  const attr  = (sel, n) => document.querySelector(sel)?.getAttribute(n) || "";
  const txt   = (sel) => (document.querySelector(sel)?.textContent || "").trim();
  const first = (a) => Array.isArray(a) ? a[0] : a;
  const token = (s) => (String(s).match(/[$€£]\s?\d[\d.,]*/) || [""])[0];
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
    return attr('meta[property="og:title"]', 'content') || txt("h1") || document.title;
  }
  function extractImage() {
    const og = attr('meta[property="og:image"]', 'content');
    if (og) return og;
    const ld = parseLD();
    if (ld?.image) {
      const im = first(ld.image);
      if (typeof im === "string") return im;
      if (im && typeof im === "object" && im.url) return im.url;
    }
    const el = document.querySelector("picture img") || document.querySelector("img");
    return el?.getAttribute("src") || el?.src || "";
  }
  function extractPrice() {
    const ld = parseLD();
    if (ld?.offers) {
      const offers = Array.isArray(ld.offers) ? ld.offers : [ld.offers];
      for (const o of offers) {
        const p = o.price || o.lowPrice || o.highPrice || o.priceSpecification?.price;
        const cur = o.priceCurrency || "USD";
        if (p != null && p !== "") {
          const n = Number(p);
          return Number.isFinite(n) ? `$ ${n.toFixed(2)}` : token(p);
        }
      }
    }
    const mp = attr('meta[itemprop="price"]','content')
             || attr('meta[property="product:price:amount"]','content')
             || attr('meta[property="og:price:amount"]','content');
    if (mp) {
      const n = Number(mp);
      return Number.isFinite(n) ? `$ ${n.toFixed(2)}` : token(mp);
    }
    return "";
  }
  function extractBrand() {
    const ld = parseLD();
    if (ld?.brand) {
      if (typeof ld.brand === "string") return ld.brand;
      if (ld.brand.name) return ld.brand.name;
    }
    return "ZARA";
  }
  function productKey() {
    const canon = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || "";
    const ld = parseLD();
    return ld?.sku || ld?.mpn || canon || (location.pathname + location.search) || location.href;
  }
  function buildItem() {
    const ld = parseLD();
    const sku = ld?.sku || ld?.mpn || "";
    return {
      id: sku || productKey(),
      title: extractTitle(),
      brand: extractBrand(),
      price: extractPrice(),
      img: extractImage(),
      link: location.href
    };
  }

  // --- dual-shot (quick + settled) ---
  let sentQuick = false, sentSettled = false;
  let lastKey = "", lastAt = 0, curKey = null;
  const debounce = (key, ms) => { const now = Date.now(); if (key === lastKey && now - lastAt < ms) return false; lastKey = key; lastAt = now; return true; };

  function resetForKey(newKey) {
    if (newKey && newKey !== curKey) {
      curKey = newKey; sentQuick = false; sentSettled = false; lastKey = ""; lastAt = 0;
      log("product change → reset", newKey);
    }
  }
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
    if (sentQuick) return;
    const key = productKey(); resetForKey(key);
    if (!debounce(key, 200)) return;
    const item = buildItem(); if (!item.title) return;
    log("ADD_ITEM", reason, item);
    sendItemSafe(item);
    sentQuick = true;
  }
  async function sendSettled(reason = "ui-settled") {
    if (sentSettled) return;
    const key = productKey(); resetForKey(key);
    if (!debounce(key, 600)) {}
    const item = await settleThenScrape(900); if (!item.title) return;
    log("ADD_ITEM", reason, item);
    sendItemSafe(item);
    sentSettled = true;
  }

  // --- button detection (not "Adding") ---
  const ADD_RE = /\badd to (bag|cart)\b|\bbuy now\b|\badd\b(?!ing)/i;
  function looksLikeAdd(node) {
    if (!node || node.nodeType !== 1) return false;
    const s = [
      node.textContent || "",
      node.getAttribute?.("aria-label") || "",
      node.getAttribute?.("data-qa") || "",
      node.getAttribute?.("data-testid") || "",
      node.getAttribute?.("id") || "",
      node.getAttribute?.("name") || "",
      node.getAttribute?.("class") || ""
    ].join(" ").toLowerCase();
    if (s.includes("adding")) return false;
    return ADD_RE.test(s);
  }
  function findAdd(e) {
    const path = (e.composedPath && e.composedPath()) || [];
    for (const n of path) if (looksLikeAdd(n)) return n;
    for (const n of document.querySelectorAll('button, [role="button"]')) if (looksLikeAdd(n)) return n;
    return null;
  }

  function earlyHandler(e) { if (findAdd(e)) sendQuick("ui-quick"); }
  function lateHandler(e)  { if (findAdd(e)) setTimeout(() => sendSettled("ui-settled"), 140); }

  ["mousedown","pointerdown","touchstart"].forEach(t => document.addEventListener(t, earlyHandler, true));
  ["click","pointerup","touchend","submit","keydown"].forEach(t => document.addEventListener(t, lateHandler, true));

  log("loaded");
})();