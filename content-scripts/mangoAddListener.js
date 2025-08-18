// content-scripts/mangoAddListener.js
// Mango: listen for background nudges (webRequest) + strict Add CTA fallback.
// No variant/size clicks, top-frame only.

(() => {
  if (window.top !== window) return;
  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Mango]", ...a);

  // ---------- utils ----------
  const $ = (s) => document.querySelector(s);
  const attr = (s, n) => $(s)?.getAttribute(n) || "";
  const first = (v) => (Array.isArray(v) ? v[0] : v);

  // PDP check: JSON-LD product OR og:type=product OR obvious PDP form/selectors
  function isPDP() {
    try {
      const ogt = attr('meta[property="og:type"]', 'content') || "";
      if (/product/i.test(ogt)) return true;
      if (parseLD()) return true;
      if (
        document.querySelector('form[action*="cart"] [name="quantity"]') ||
        document.querySelector('[data-testid*="add"],[data-test*="add"],[data-qa*="add"]')
      ) return true;
      // cheap path hint: /p/ in Mango PDPs
      if (/\/p\//i.test(location.pathname)) return true;
    } catch {}
    return false;
  }

  // ---------- JSON-LD helpers ----------
  function findProduct(node) {
    try {
      if (!node || typeof node !== "object") return null;
      const t = node["@type"];
      const isProd = Array.isArray(t)
        ? t.map(String).map(s => s.toLowerCase()).includes("product")
        : String(t || "").toLowerCase() === "product";
      if (isProd) return node;
      if (Array.isArray(node)) {
        for (const x of node) { const hit = findProduct(x); if (hit) return hit; }
      } else {
        if (node["@graph"]) { const hit = findProduct(node["@graph"]); if (hit) return hit; }
        for (const k of Object.keys(node)) { const hit = findProduct(node[k]); if (hit) return hit; }
      }
    } catch {}
    return null;
  }
  function parseLD() {
    for (const s of document.querySelectorAll('script[type*="ld+json"]')) {
      try { const j = JSON.parse(s.textContent || ""); const p = findProduct(j); if (p) return p; } catch {}
    }
    return null;
  }

  // ---------- field extractors ----------
  function extractTitle() {
    return (
      attr('meta[property="og:title"]', 'content') ||
      document.querySelector("h1")?.textContent?.trim() ||
      document.title
    );
  }
  function extractImage() {
    const og = attr('meta[property="og:image"]', 'content') || attr('meta[property="og:image:secure_url"]', 'content');
    if (og) return og;
    const ld = parseLD(); const im = ld?.image && first(ld.image);
    if (im) return typeof im === "string" ? im : (im.url || "");
    const img = document.querySelector("picture img, img");
    return img?.getAttribute("src") || img?.src || "";
  }
  function token(s) { return (String(s).match(/[$€£]\s?\d[\d.,]*/) || [""])[0]; }
  function extractPrice() {
    const ld = parseLD();
    if (ld?.offers) {
      const arr = Array.isArray(ld.offers) ? ld.offers : [ld.offers];
      for (const o of arr) {
        const p = o.price || o.lowPrice || o.highPrice || o?.priceSpecification?.price;
        if (p != null && p !== "") {
          const n = Number(p); if (Number.isFinite(n)) return `$ ${n.toFixed(2)}`;
          const t = token(p); if (t) return t;
        }
      }
    }
    const metaP =
      attr('meta[property="product:price:amount"]', 'content') ||
      attr('meta[itemprop="price"]', 'content');
    if (metaP) { const n = Number(metaP); return Number.isFinite(n) ? `$ ${n.toFixed(2)}` : token(metaP); }

    const guess = Array.from(document.querySelectorAll('[class*="price"],[data-testid*="price"],span,div'))
      .map(el => el.textContent && el.textContent.trim())
      .find(t => /[$€£]\s?\d/.test(t || ""));
    return guess ? token(guess) : "";
  }
  function extractBrand() {
    const ld = parseLD();
    if (ld?.brand) {
      if (typeof ld.brand === "string") return ld.brand;
      if (ld.brand.name) return ld.brand.name;
    }
    return "MANGO";
  }
  function extractId() {
    const ld = parseLD();
    if (ld?.sku) return String(ld.sku);
    const canon = attr('link[rel="canonical"]', 'href') || "";
    return canon || location.href;
  }
  function buildItem() {
    return {
      id: extractId(),
      title: extractTitle(),
      brand: extractBrand(),
      price: extractPrice(),
      img: extractImage(),
      link: location.href
    };
  }

  // ---------- sending ----------
  function sendItemSafe(item) {
    try {
      if (!chrome?.runtime?.id) return;
      chrome.runtime.sendMessage({ action: "ADD_ITEM", item }, () => void chrome.runtime?.lastError);
    } catch {}
  }

  function settleThenScrape(ms = 900) {
    return new Promise((resolve) => {
      let done = false;
      const initial = buildItem();
      if (initial.price || initial.img) { done = true; return resolve(initial); }
      const t = setTimeout(() => { if (!done) { done = true; obs.disconnect(); resolve(buildItem()); } }, ms);
      const obs = new MutationObserver(() => {
        if (done) return;
        const it = buildItem();
        if (it.price || it.img) { clearTimeout(t); done = true; obs.disconnect(); resolve(it); }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    });
  }

  // ---------- react to background nudges (preferred path) ----------
  let lastSentAt = 0;
  chrome.runtime?.onMessage?.addListener?.(async (m) => {
    if (!m) return;
    if (m.action !== "ADD_TRIGGERED" && m.action !== "ADD_TRIGGERED_BROADCAST") return;
    if (!isPDP()) return;
    const now = Date.now(); if (now - lastSentAt < 1200) return;
    const item = await settleThenScrape(1000);
    if (!item.title) return;
    lastSentAt = now;
    log("ADD_ITEM via nudge", item);
    sendItemSafe(item);
  });

  // ---------- strict CTA fallback (only if webRequest misses) ----------
  const ADD_TXT = /\badd to (bag|cart)\b/i;
  const BTN_SEL = [
    "button", "[role=button]", "a[role=button]", "input[type=submit]",
    "[data-testid*='add']",
    "[data-test*='add']",
    "[data-qa*='add']",
    "#add-to-bag", "#addToBagButton", "#add-to-cart"
  ].join(",");

  const looksLikeAdd = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const s = [
      el.textContent || "",
      el.getAttribute?.("aria-label") || "",
      el.getAttribute?.("data-testid") || "",
      el.getAttribute?.("data-test") || "",
      el.getAttribute?.("data-qa") || "",
      el.id || "", el.name || "", el.className || ""
    ].join(" ").toLowerCase();
    if (s.includes("adding")) return false;
    return ADD_TXT.test(s);
  };

  function onClick(e) {
    if (!isPDP()) return;
    const btn = e.target?.closest?.(BTN_SEL);
    if (!btn || !looksLikeAdd(btn)) return;
    const now = Date.now();
    if (now - lastSentAt < 1200) return; // dedupe with nudges
    lastSentAt = now;
    setTimeout(async () => {
      const item = await settleThenScrape(900);
      if (!item.title) return;
      log("ADD_ITEM via click-fallback", item);
      sendItemSafe(item);
    }, 120);
  }

  window.addEventListener("click", onClick, true);
  log("wired", { href: location.href, pdp: isPDP() });
})();