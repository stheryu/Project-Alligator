// content-scripts/bloomingdalesAddListener.js
(() => {
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Bloomingdales]", ...a);
  const HAS_EXT = !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);

  // UI-click fallback is OFF by default to avoid swatch false positives.
  const ENABLE_UI_TRIGGER = false;

  // ---- tiny helpers ----
  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const txt  = (s) => ($(s)?.textContent || "").trim();
  const attr = (s,n) => $(s)?.getAttribute(n) || "";
  const first= (a) => Array.isArray(a) ? a[0] : a;
  const lower= (v) => (typeof v === "string" ? v : String(v || "")).toLowerCase();
  const token= (s) => (String(s).match(/[$€£]\s?\d[\d.,]+/) || [""])[0];
  const looksLikePixel = (u="") => {
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
      if (parseLD()) return true;
      const ogType = (attr('meta[property="og:type"]','content') || "").toLowerCase();
      if (ogType === "product") return true;
      const path = location.pathname.toLowerCase();
      const hasProductPath = /\/shop\/product\//.test(path);
      const hasTitle = !!$("h1, [data-testid*='product-title']");
      return hasProductPath && hasTitle;
    } catch { return false; }
  }

  // ---- field extractors ----
  function extractTitle() {
    return attr('meta[property="og:title"]', 'content') || txt("h1") || document.title;
  }
  function extractBrand() {
    const ld = parseLD();
    if (ld?.brand) return typeof ld.brand === "string" ? ld.brand : (ld.brand.name || "");
    return txt('[data-testid*="brand"], [class*="Brand"] a') || attr('meta[property="og:site_name"]','content') || "Bloomingdale's";
  }
  function extractImage() {
    const og = attr('meta[property="og:image"]','content');
    if (og && !looksLikePixel(og)) return og;
    const ld = parseLD();
    if (ld?.image) {
      const v = first(Array.isArray(ld.image) ? ld.image : [ld.image]);
      if (typeof v === "string") return v;
      if (v && typeof v === "object" && v.url) return v.url;
    }
    const el = document.querySelector("picture img, img");
    return el?.getAttribute("src") || el?.src || "";
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
      attr('meta[itemprop="price"]','content') ||
      attr('meta[property="product:price:amount"]','content') ||
      attr('meta[property="og:price:amount"]','content');
    if (mp) {
      const n = Number(mp);
      return Number.isFinite(n) ? `$ ${n.toFixed(2)}` : token(mp);
    }
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

  // ---- strict add button selectors ----
  const ADD_SEL = [
    'button#add-to-bag',
    'button[name="addToBag"]',
    '[data-testid="add-to-bag"]',
    '[data-testid*="add-to-bag"]',
    'button.add-to-bag',
    // fallback: product form submit inside the PDP form
    'form[action*="add"] button[type="submit"]'
  ].join(",");

  function isVariantUI(node) {
    if (!node || node.nodeType !== 1) return false;
    const tag = node.tagName;
    if (tag === "SELECT" || tag === "OPTION") return true;
    const role = lower(node.getAttribute?.("role"));
    if (role === "listbox" || role === "option" || role === "radiogroup" || role === "radio") return true;
    const cls = lower(node.className);
    const name = lower(node.getAttribute?.("name"));
    const id   = lower(node.id);
    if (/\b(size|sizes|swatch|variant|variation|colour|color|fit)\b/.test(cls)) return true;
    if (/\b(size|variant|swatch|variation|colour|color|fit)\b/.test(name)) return true;
    if (/\b(size|variant|swatch|variation|colour|color|fit)\b/.test(id)) return true;
    return false;
  }

  function closestAddButton(start) {
    let el = start && start.nodeType === 1 ? start : start?.parentElement || null;
    for (let i = 0; i < 8 && el; i++) {
      if (isVariantUI(el)) return null;   // ignore size/color controls
      if (el.matches?.(ADD_SEL)) return el;
      el = el.parentElement;
    }
    return null;
  }

  // ---- dual-shot on *real* add button ----
  let sentQuick=false, sentSettled=false, lastKey="", lastAt=0;
  const debounce=(k,ms)=>{const now=Date.now();if(k===lastKey&&now-lastAt<ms)return false;lastKey=k;lastAt=now;return true;};

  function settleThenScrape(ms=900){
    return new Promise((resolve)=>{
      let done=false; const initial=buildItem();
      if (initial.price || initial.img){ done=true; return resolve(initial); }
      const timer=setTimeout(()=>{ if(!done){ done=true; obs?.disconnect?.(); resolve(buildItem()); }}, ms);
      const obs=new MutationObserver(()=>{
        if(done) return;
        const item=buildItem();
        if(item.price || item.img){ clearTimeout(timer); done=true; obs.disconnect(); resolve(item); }
      });
      obs.observe(document.documentElement,{childList:true,subtree:true,attributes:true});
    });
  }

  function sendQuick(){
    if(!isPDP() || sentQuick) return;
    if(!debounce(location.href,200)) return;
    const item=buildItem();
    if(!item.title) return;
    log("ADD_ITEM quick", item);
    sendItemSafe(item);
    sentQuick=true;
  }
  async function sendSettled(){
    if(!isPDP() || sentSettled) return;
    const item=await settleThenScrape();
    if(!item.title) return;
    log("ADD_ITEM settled", item);
    sendItemSafe(item);
    sentSettled=true;
  }

  // ---- wire/unwire behind a switch ----
  function onClick(e){ const btn = closestAddButton(e.target); if (!btn) return; if (btn.disabled || btn.getAttribute("aria-disabled")==="true") return; sendQuick(); setTimeout(sendSettled, 200); }
  function onKey(e){ if (e.key !== "Enter" && e.key !== " ") return; const btn = closestAddButton(e.target); if (!btn) return; sendQuick(); setTimeout(sendSettled, 200); }

  if (ENABLE_UI_TRIGGER) {
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  }

  log("loaded", { href: location.href, isPDP: isPDP(), uiTrigger: ENABLE_UI_TRIGGER });
})();