// content-scripts/bloomingdalesAddListener.js
(() => {
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Bloomies]", ...a);
  const HAS_EXT = !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);

  // ---- tiny helpers ----
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const txt = (s) => ($(s)?.textContent || "").trim();
  const attr = (s, n) => $(s)?.getAttribute(n) || "";
  const first = (a) => (Array.isArray(a) ? a[0] : a);
  const lower = (v) => (typeof v === "string" ? v : String(v || "")).toLowerCase();
  const token = (s) => (String(s).match(/[$€£]\s?\d[\d.,]+/) || [""])[0];
  const looksLikePixel = (u = "") => {
    const x = String(u).toLowerCase();
    return !x || x.startsWith("data:") || x.endsWith(".svg") || /pixel|1x1|spacer|beacon/.test(x);
  };

  // ---- JSON-LD ----
  const normT = (t) => (Array.isArray(t) ? t : (t ? [t] : [])).map((v) => String(v).toLowerCase());
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
    for (const s of $$('script[type*="ld+json"]')) {
      try {
        const json = JSON.parse((s.textContent || "").trim());
        const prod = findProductNode(json);
        if (prod) return prod;
      } catch {}
    }
    return null;
  }

  // ---- PDP heuristic (Bloomingdale’s) ----
  function isPDP() {
    try {
      const ld = parseLD();
      if (ld) return true;

      // Bloomingdale's PDP URLs typically include /shop/product/
      const path = location.pathname.toLowerCase();
      const hasProductPath = /\/shop\/product\//.test(path);

      // Strong DOM hints
      const ogType = (attr('meta[property="og:type"]', 'content') || "").toLowerCase() === "product";
      const hasTitle = !!$("h1, [data-testid*='product-title']");
      const hasAdd = !!closestAddButton(document.body);

      return ogType || ld || (hasProductPath && hasTitle && hasAdd);
    } catch { return false; }
  }

  // ---- field extractors ----
  function extractTitle() {
    return (
      attr('meta[property="og:title"]', 'content') ||
      txt("h1") ||
      document.title
    );
  }
  function extractBrand() {
    const ld = parseLD();
    if (ld?.brand) return typeof ld.brand === "string" ? ld.brand : (ld.brand.name || "");
    // many pages have brand near title/breadcrumb
    return (
      txt('[data-testid*="brand"], [class*="Brand"] a') ||
      attr('meta[property="og:site_name"]', 'content') ||
      "Bloomingdale's"
    );
  }
  function extractImage() {
    const og = attr('meta[property="og:image"]', 'content');
    if (og && !looksLikePixel(og)) return og;

    const ld = parseLD();
    if (ld?.image) {
      const v = first(Array.isArray(ld.image) ? ld.image : [ld.image]);
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
    const mp =
      attr('meta[itemprop="price"]', 'content') ||
      attr('meta[property="product:price:amount"]', 'content') ||
      attr('meta[property="og:price:amount"]', 'content');
    if (mp) {
      const n = Number(mp);
      return Number.isFinite(n) ? `$ ${n.toFixed(2)}` : token(mp);
    }
    // visible fallback
    const cand = $$('[class*="price"], [data-testid*="price"], span, div')
      .map((el) => el.textContent && el.textContent.trim())
      .filter(Boolean)
      .find((t) => /[$€£]\s?\d/.test(t));
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

  // ---- safe send ----
  function sendItemSafe(item) {
    if (!HAS_EXT) { log("context invalidated — refresh page"); return; }
    try {
      chrome.runtime.sendMessage({ action: "ADD_ITEM", item }, () => {
        if (chrome.runtime?.lastError) log("sendMessage lastError", chrome.runtime.lastError.message);
      });
    } catch (e) { log("sendMessage exception", e); }
  }

  // ---- add button targeting (tight) ----
  // Try a set of Bloomingdale’s-specific selectors first, then a textual fallback.
  const ADD_SEL = [
    'button#add-to-bag',
    'button[name="addToBag"]',
    '[data-testid*="add-to-bag"]',
    '[aria-label*="add to bag" i]',
    'button.add-to-bag',
    'button:has([data-testid*="add-to-bag"])'
  ].join(",");

  const NEG = /\b(wish(?:list)?|favorites?|registry|newsletter|subscribe|gift\s*card|apply|paypal|apple\s*pay|google\s*pay|klarna|afterpay)\b/i;
  const POS = /\b(add(?:\s+to)?\s*(?:bag|cart)|buy\s+now|purchase)\b/i;

  function isVariantUI(node) {
    if (!node || node.nodeType !== 1) return false;
    const tag = node.tagName;
    if (tag === "SELECT" || tag === "OPTION") return true;
    const role = lower(node.getAttribute?.("role"));
    if (role === "listbox" || role === "option" || role === "radiogroup" || role === "radio") return true;
    const cls = lower(node.className);
    const name = lower(node.getAttribute?.("name"));
    const id = lower(node.id);
    if (/\b(size|sizes|swatch|variant|variation|colour|color|fit)\b/.test(cls)) return true;
    if (/\b(size|variant|swatch|colour|color|fit)\b/.test(name)) return true;
    if (/\b(size|variant|swatch|colour|color|fit)\b/.test(id)) return true;
    return false;
  }

  function looksLikeAdd(el) {
    if (!el || el.nodeType !== 1) return false;

    if (el.matches?.(ADD_SEL)) return true;

    const s = [
      el.innerText || el.textContent || "",
      el.getAttribute?.("aria-label") || "",
      el.getAttribute?.("data-testid") || "",
      el.getAttribute?.("id") || "",
      el.getAttribute?.("name") || "",
      el.getAttribute?.("class") || ""
    ].join(" ").toLowerCase();

    if (s.includes("adding")) return false;
    if (NEG.test(s)) return false;
    return POS.test(s);
  }

  function closestAddButton(start) {
    let el = start && start.nodeType === 1 ? start : start?.parentElement || null;
    for (let i = 0; i < 10 && el; i++) {
      if (isVariantUI(el)) return null; // ignore size/swatch UI
      if (looksLikeAdd(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  // ---- dual-shot ----
  let sentQuick = false, sentSettled = false, lastAt = 0, lastKey = "";
  const debounce = (key, ms) => { const now = Date.now(); if (key===lastKey && now-lastAt<ms) return false; lastKey=key; lastAt=now; return true; };
  function settleThenScrape(ms=900){
    return new Promise((resolve)=>{
      let done=false; const initial=buildItem();
      if (initial.price || initial.img){ done=true; return resolve(initial); }
      const timer=setTimeout(()=>{ if(!done){ done=true; obs.disconnect(); resolve(buildItem()); }}, ms);
      const obs=new MutationObserver(()=>{
        if(done) return; const item=buildItem();
        if(item.price || item.img){ clearTimeout(timer); done=true; obs.disconnect(); resolve(item); }
      });
      obs.observe(document.documentElement,{childList:true,subtree:true,attributes:true});
    });
  }

  function sendQuick(){
    if (!isPDP() || sentQuick) return;
    if (!debounce(location.href,200)) return;
    const item = buildItem();
    if (!item.title) return;
    log("ADD_ITEM quick", item);
    sendItemSafe(item);
    sentQuick = true;
  }
  async function sendSettled(){
    if (!isPDP() || sentSettled) return;
    const item = await settleThenScrape();
    if (!item.title) return;
    log("ADD_ITEM settled", item);
    sendItemSafe(item);
    sentSettled = true;
  }

  // ---- wire clicks/keys (only when real add button is involved) ----
  document.addEventListener("click", (e) => {
    const btn = closestAddButton(e.target);
    if (!btn) return;
    sendQuick();
    setTimeout(sendSettled, 200);
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const btn = closestAddButton(e.target);
    if (!btn) return;
    sendQuick();
    setTimeout(sendSettled, 200);
  }, true);

  log("loaded", { href: location.href, isPDP: isPDP() });
})();