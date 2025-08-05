// content-scripts/netaporterAddListener.js
(() => {
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-NetAPorter]", ...a);
  const HAS_EXT = !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);

  // --- helpers ---
  const $   = (s) => document.querySelector(s);
  const txt = (s) => ($(s)?.textContent || "").trim();
  const attr= (s,n)=> $(s)?.getAttribute(n) || "";
  const token = (s) => (String(s).match(/[$€£]\s?\d[\d.,]+/) || [""])[0];
  const normT = (t) => (Array.isArray(t) ? t : (t ? [t] : [])).map(v => String(v).toLowerCase());
  const first= (a) => Array.isArray(a) ? a[0] : a;

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
        const json = JSON.parse((s.textContent || "").trim());
        const prod = findProductNode(json);
        if (prod) return prod;
      } catch {}
    }
    return null;
  }

  // Net-a-Porter PDPs usually include /shop/product/ in the canonical path
  const isPDP = () => /\/shop\/product\//i.test(location.pathname) || !!parseLD();

  function extractTitle() {
    return attr('meta[property="og:title"]','content') || txt("h1") || document.title;
  }
  function extractBrand() {
    const ld = parseLD();
    if (ld?.brand) return typeof ld.brand === "string" ? ld.brand : (ld.brand.name || "");
    // Many pages have brand near/inside the title region or breadcrumb
    return txt('[data-testid*="brand"], a[href*="/shop/designer/"]') || "";
  }
  function extractImage() {
    const og = attr('meta[property="og:image"]','content');
    if (og) return og;
    const ld = parseLD();
    if (ld?.image) {
      const v = first(ld.image);
      if (typeof v === "string") return v;
      if (v && typeof v === "object" && v.url) return v.url;
    }
    const img = document.querySelector("picture img, img");
    return img?.getAttribute("src") || img?.src || "";
  }
  function extractPrice() {
    const ld = parseLD();
    if (ld?.offers) {
      const offers = Array.isArray(ld.offers) ? ld.offers : [ld.offers];
      for (const o of offers) {
        const p = o.price || o.lowPrice || o.highPrice || o?.priceSpecification?.price;
        if (p != null && p !== "") {
          const n = Number(p);
          const cur = o.priceCurrency || "USD";
          return Number.isFinite(n) ? `${cur === "USD" ? "$" : cur} ${n.toFixed(2)}` : token(p);
        }
      }
    }
    const mp = attr('meta[itemprop="price"]','content') ||
               attr('meta[property="product:price:amount"]','content') ||
               attr('meta[property="og:price:amount"]','content');
    if (mp) {
      const n = Number(mp);
      return Number.isFinite(n) ? `$ ${n.toFixed(2)}` : token(mp);
    }
    // Fallback: visible
    const cand = Array.from(document.querySelectorAll('[class*="price"], [data-testid*="price"], span, div'))
      .map(el => el.textContent && el.textContent.trim())
      .filter(Boolean)
      .find(t => /[$€£]\s?\d/.test(t));
    return cand ? token(cand) : "";
  }

  function buildItem() {
    const ld = parseLD();
    const sku = ld?.sku || ld?.mpn || "";
    return {
      id: sku || location.href,
      title: extractTitle(),
      brand: extractBrand(),
      price: extractPrice(),
      img: extractImage(),
      link: location.href
    };
  }

  function sendItemSafe(item) {
    if (!HAS_EXT) { log("context invalidated — refresh page"); return; }
    try {
      chrome.runtime.sendMessage({ action: "ADD_ITEM", item }, () => {
        if (chrome.runtime?.lastError) log("sendMessage lastError", chrome.runtime.lastError.message);
      });
    } catch (e) {
      log("sendMessage exception", e);
    }
  }

  // Dual shot
  let sentQuick = false, sentSettled = false, lastAt = 0, lastKey = "";
  const debounce = (key, ms) => { const now = Date.now(); if (key===lastKey && now-lastAt<ms) return false; lastKey=key; lastAt=now; return true; };
  function settleThenScrape(ms=900) {
    return new Promise((resolve) => {
      let done=false;
      const initial = buildItem();
      if (initial.price || initial.img) { done=true; return resolve(initial); }
      const timer = setTimeout(() => { if (!done){ done=true; obs.disconnect(); resolve(buildItem()); }}, ms);
      const obs = new MutationObserver(() => {
        if (done) return;
        const item = buildItem();
        if (item.price || item.img) { clearTimeout(timer); done=true; obs.disconnect(); resolve(item); }
      });
      obs.observe(document.documentElement, { childList:true, subtree:true, attributes:true });
    });
  }
  function sendQuick()   { if (!isPDP() || sentQuick) return; if (!debounce(location.href,200)) return; const item = buildItem(); if (!item.title) return; log("ADD_ITEM quick", item); sendItemSafe(item); sentQuick = true; }
  async function sendSettled(){ if (!isPDP() || sentSettled) return; if (!debounce(location.href,600)){} const item = await settleThenScrape(); if (!item.title) return; log("ADD_ITEM settled", item); sendItemSafe(item); sentSettled = true; }

  // Button detection
  const POS = /\badd to bag\b|\badd to cart\b|\bbuy now\b/i;
  const NEG = /\b(add to wish|wishlist|favorites|list|registry|add address|add payment)\b/i;
  function looksLikeAdd(node) {
    if (!node || node.nodeType !== 1) return false;
    const s = [
      node.textContent || "",
      node.getAttribute?.("aria-label") || "",
      node.getAttribute?.("data-testid") || "",
      node.getAttribute?.("id") || "",
      node.getAttribute?.("name") || "",
      node.getAttribute?.("class") || ""
    ].join(" ").toLowerCase();
    if (s.includes("adding")) return false;
    if (NEG.test(s)) return false;
    return POS.test(s);
  }
  function pathHasAdd(e){
    const path = (e.composedPath && e.composedPath()) || [];
    for (const n of path) if (looksLikeAdd(n)) return true;
    return false;
  }

  ["mousedown","pointerdown","touchstart"].forEach(t => document.addEventListener(t, e => { if (pathHasAdd(e)) sendQuick(); }, true));
  ["click","pointerup","touchend","submit","keydown"].forEach(t => document.addEventListener(t, e => { if (pathHasAdd(e)) setTimeout(sendSettled, 140); }, true));

  log("loaded", { href: location.href, isPDP: isPDP() });
})();