// content-scripts/genericAddListener.js
(() => {
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Generic]", ...a);
  const HAS_EXT = !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);

  // --------- small helpers ----------
  const $    = (s) => document.querySelector(s);
  const $$   = (s) => Array.from(document.querySelectorAll(s));
  const txt  = (s) => ($(s)?.textContent || "").trim();
  const attr = (s,n) => $(s)?.getAttribute(n) || "";
  const first= (a) => Array.isArray(a) ? a[0] : a;
  const token= (s) => (String(s).match(/[$€£]\s?\d[\d.,]+/) || [""])[0];
  const normT= (t) => (Array.isArray(t) ? t : (t ? [t] : [])).map(v => String(v).toLowerCase());

  function absUrl(u) {
    try { return new URL(u, location.href).toString(); } catch { return u || ""; }
  }
  function pickBestFromSrcset(ss) {
    if (!ss) return "";
    try {
      return ss.split(",")
        .map(s => s.trim())
        .map(p => {
          const [url, w] = p.split(/\s+/);
          const width = parseInt((w || "").replace(/\D/g, ""), 10) || 0;
          return { url: absUrl(url), width };
        })
        .sort((a,b) => b.width - a.width)[0]?.url || "";
    } catch { return ""; }
  }
  function looksLikePixel(u = "") {
    const x = String(u).toLowerCase();
    return !x || x.startsWith("data:") || x.endsWith(".svg") || /pixel|1x1|spacer|beacon/.test(x);
  }
  function centsToCurrency(cents, cur = "USD") {
    const n = Number(cents);
    if (Number.isFinite(n)) {
      const s = (cur === "USD" || !cur) ? "$" : cur;
      return `${s} ${(n / 100).toFixed(2)}`;
    }
    return "";
  }

  // --------- JSON sources ----------
  // 1) JSON-LD Product (most platforms)
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
    const scripts = $$('script[type*="ld+json"]');
    for (const s of scripts) {
      try {
        const json = JSON.parse((s.textContent || "").trim());
        const prod = findProductNode(json);
        if (prod) return prod;
      } catch {}
    }
    return null;
  }

  // 2) Shopify Product JSON: <script type="application/json" id="ProductJson-..."> or data-product-json
  function parseShopifyProductJSON() {
    // Most common patterns
    const candidates = [
      ...$$('script[type="application/json"][id^="ProductJson-"]'),
      ...$$('script[type="application/json"][data-product-json]')
    ];
    for (const s of candidates) {
      try {
        const json = JSON.parse((s.textContent || "").trim());
        // Shopify product JSON typically has: title, images[], variants[]
        if (json && (json.variants || json.images || json.title)) return json;
      } catch {}
    }
    // Some themes put it under __NEXT_DATA__ (Headless/Next.js)
    const next = $('#__NEXT_DATA__');
    if (next) {
      try {
        const json = JSON.parse(next.textContent || "");
        // Best effort: look for a product-like node
        const deepFind = (obj) => {
          if (!obj || typeof obj !== "object") return null;
          if (obj.variants && obj.images && obj.title) return obj;
          for (const k of Object.keys(obj)) {
            const r = deepFind(obj[k]); if (r) return r;
          }
          return null;
        };
        const hit = deepFind(json);
        if (hit) return hit;
      } catch {}
    }
    return null;
  }

  // --------- PDP heuristic ----------
  function looksLikePDP() {
    // 1) Strong signals
    if (parseLD()) return true;
    if (parseShopifyProductJSON()) return true;

    // 2) OG product type
    const ogType = attr('meta[property="og:type"]','content') || "";
    if (/product/i.test(ogType)) return true;

    // 3) Product form or add-to-cart controls commonly used by Shopify/boutiques
    if ($('form[action*="/cart/add"]') || $('[name="add"]') || $('[data-add-to-cart]')) return true;
    if ($('input[name="id"]') && ($('[type="submit"][name="add"]') || $('[data-product-form]'))) return true;

    // 4) Title + price token + non-pixel image
    const hasH1 = !!$("h1");
    if (!hasH1) return false;
    const hasPrice = $$("span,div,p,strong,b").some(el => /[$€£]\s?\d/.test(el.textContent || ""));
    if (!hasPrice) return false;
    const img = $("picture img, img");
    const src = img?.getAttribute("src") || img?.src || "";
    if (!src || looksLikePixel(src)) return false;

    // Exclude obvious non-PDP routes
    const path = location.pathname.toLowerCase();
    if (/cart|checkout|bag|wishlist|account|login|register|collection|collections|category|categories/i.test(path)) return false;

    return true;
  }

  // --------- field extractors ----------
  function extractTitle() {
    const og = attr('meta[property="og:title"]','content');
    if (og) return og;
    const ld = parseLD();
    if (ld?.name) return String(ld.name);
    const sj = parseShopifyProductJSON();
    if (sj?.title) return String(sj.title);
    return txt("h1") || document.title;
  }

  function extractBrand() {
    const ld = parseLD();
    if (ld?.brand) return typeof ld.brand === "string" ? ld.brand : (ld.brand.name || "");
    const ogSite = attr('meta[property="og:site_name"]','content') || "";
    if (ogSite) return ogSite;
    // Shopify sometimes exposes vendor on variants or product JSON
    const sj = parseShopifyProductJSON();
    if (sj?.vendor) return String(sj.vendor);
    return location.hostname.replace(/^www\./, "");
  }

  function extractImage() {
    // 1) OG image
    const og = attr('meta[property="og:image"]','content') || attr('meta[property="og:image:secure_url"]','content');
    if (og && !looksLikePixel(og)) return absUrl(og);

    // 2) JSON-LD image
    const ld = parseLD();
    if (ld?.image) {
      const v = first(ld.image);
      const url = (typeof v === "string") ? v : (v && typeof v === "object" && v.url) ? v.url : "";
      if (url && !looksLikePixel(url)) return absUrl(url);
    }

    // 3) Shopify product JSON: images can be strings or objects with "src"
    const sj = parseShopifyProductJSON();
    if (sj?.images && sj.images.length) {
      const v = first(sj.images);
      const url = (typeof v === "string") ? v : v?.src || v?.url || "";
      if (url && !looksLikePixel(url)) return absUrl(url);
    }

    // 4) <picture/img> with srcset
    const imgEl = $("picture img") || $("img");
    if (imgEl) {
      const ss  = imgEl.getAttribute("srcset");
      const best= pickBestFromSrcset(ss);
      const src = absUrl(imgEl.getAttribute("src") || imgEl.src || "");
      if (best && !looksLikePixel(best)) return best;
      if (src  && !looksLikePixel(src))  return src;
    }

    // 5) <picture><source srcset=...>
    const source = $("picture source[srcset]");
    if (source) {
      const ss2 = source.getAttribute("srcset");
      const best2 = pickBestFromSrcset(ss2);
      if (best2 && !looksLikePixel(best2)) return best2;
    }

    // 6) lazy attrs
    const lazyImg = $("img[data-src], img[data-original], img[data-lazy], img[data-srcset]");
    if (lazyImg) {
      const lazySrcset = lazyImg.getAttribute("data-srcset");
      const bestL = pickBestFromSrcset(lazySrcset);
      if (bestL && !looksLikePixel(bestL)) return bestL;
      const lazySrc = absUrl(lazyImg.getAttribute("data-src") || lazyImg.getAttribute("data-original") || lazyImg.getAttribute("data-lazy"));
      if (lazySrc && !looksLikePixel(lazySrc)) return lazySrc;
    }

    // 7) preload hints
    const preload = $$('link[rel="preload"][as="image"]').map(l => absUrl(l.getAttribute("href") || l.href))
      .find(href => href && !looksLikePixel(href));
    if (preload) return preload;

    // 8) twitter:image
    const tw = attr('meta[name="twitter:image"]','content');
    if (tw && !looksLikePixel(tw)) return absUrl(tw);

    return "";
  }

  function extractPrice() {
    // JSON-LD first
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

    // Shopify product JSON: variants[0].price (cents) or strings
    const sj = parseShopifyProductJSON();
    if (sj && sj.variants && sj.variants.length) {
      const v0 = sj.variants[0];
      if (typeof v0.price === "number") return centsToCurrency(v0.price, sj.currency || "USD");
      if (typeof v0.price === "string") {
        // Sometimes price comes as "99.00" (dollars)
        const n = Number(v0.price);
        if (Number.isFinite(n)) return `$ ${n.toFixed(2)}`;
        const tok = token(v0.price);
        if (tok) return tok;
      }
      // compare_at_price can be present
      if (typeof v0.compare_at_price === "number") return centsToCurrency(v0.compare_at_price, sj.currency || "USD");
      if (typeof v0.compare_at_price === "string") {
        const n = Number(v0.compare_at_price);
        if (Number.isFinite(n)) return `$ ${n.toFixed(2)}`;
      }
    }

    // Meta price tags
    const mp = attr('meta[itemprop="price"]','content') ||
               attr('meta[property="product:price:amount"]','content') ||
               attr('meta[property="og:price:amount"]','content') ||
               attr('meta[name="twitter:data1"]','content'); // sometimes "$99.00"
    if (mp) {
      const n = Number(mp);
      return Number.isFinite(n) ? `$ ${n.toFixed(2)}` : token(mp);
    }

    // Visible price (avoid per-unit/compare info)
    const cand = $$('[class*="price"], [data-testid*="price"], [itemprop*="price"], span, div')
      .map(el => el.textContent && el.textContent.trim())
      .filter(Boolean)
      .filter(t => !/\b(per|\/)\s?(count|ct|ea|each|oz|lb|kg|ml|g)\b/i.test(t))
      .find(t => /[$€£]\s?\d/.test(t));
    return cand ? token(cand) : "";
  }

  function buildItem() {
    const ld = parseLD();
    const sj = parseShopifyProductJSON();
    const sku = ld?.sku || ld?.mpn || sj?.id || sj?.product_id || "";
    return {
      id: String(sku || location.href),
      title: extractTitle(),
      brand: extractBrand(),
      price: extractPrice(),
      img: extractImage(),
      link: location.href
    };
  }

  // --------- send logic ----------
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

  // Dual-shot (quick on pointerdown, settled after DOM updates)
  let sentQuick=false, sentSettled=false, lastKey="", lastAt=0;
  const debounce = (k,ms)=>{ const now=Date.now(); if(k===lastKey && now-lastAt<ms) return false; lastKey=k; lastAt=now; return true; };

  function settleThenScrape(ms=900){
    return new Promise((resolve)=>{
      let done=false; const initial=buildItem();
      if (initial.price || initial.img){ done=true; return resolve(initial); }
      const timer=setTimeout(()=>{ if(!done){ done=true; obs.disconnect(); resolve(buildItem()); }}, ms);
      const obs=new MutationObserver(()=>{
        if(done) return; const item=buildItem();
        if(item.price || item.img){ clearTimeout(timer); done=true; obs.disconnect(); resolve(item); }
      });
      obs.observe(document.documentElement, { childList:true, subtree:true, attributes:true });
    });
  }

  function sendQuick(){ 
    if(!looksLikePDP() || sentQuick) return;
    if(!debounce(location.href,200)) return;
    const item=buildItem(); if(!item.title) return;
    log("ADD_ITEM quick", item); sendItemSafe(item); sentQuick=true;
  }
  async function sendSettled(){
    if(!looksLikePDP() || sentSettled) return;
    const item=await settleThenScrape(1000);
    if(!item.title) return;
    log("ADD_ITEM settled", item); sendItemSafe(item); sentSettled=true;
  }

  // --------- button detection (tight) ----------
  const POS=/\badd to (bag|cart)\b|\bbuy now\b/i;
  const NEG=/\b(add to wish|wishlist|favorites|list|registry|address|payment|card|newsletter)\b/i;

  function looksLikeAdd(node){
    if(!node||node.nodeType!==1) return false;
    const s=[ node.textContent||"", node.getAttribute?.("aria-label")||"", node.getAttribute?.("data-testid")||"", node.getAttribute?.("id")||"", node.getAttribute?.("name")||"", node.getAttribute?.("class")||"" ].join(" ").toLowerCase();
    if (s.includes("adding")) return false;
    if (NEG.test(s)) return false;
    if (POS.test(s)) return true;
    // Shopify common controls
    if (/\badd-to-cart\b|\bproduct-form__submit\b|\bshopify-payment-button\b/i.test(s)) return true;
    return false;
  }
  function pathHasAdd(e){ const path=(e.composedPath&&e.composedPath())||[]; for(const n of path) if(looksLikeAdd(n)) return true; return false; }

  ["mousedown","pointerdown","touchstart"].forEach(t => document.addEventListener(t, e => { if(pathHasAdd(e)) sendQuick(); }, true));
  ["click","pointerup","touchend","submit","keydown"].forEach(t => document.addEventListener(t, e => { if(pathHasAdd(e)) setTimeout(sendSettled,140); }, true));

  // Optional: honor background nudges (e.g., Amazon/eBay webRequest)
  chrome.runtime?.onMessage?.addListener?.((msg)=>{
    if (msg?.action === "ADD_TRIGGERED" && looksLikePDP()){
      setTimeout(sendSettled, 150);
    }
  });

  // Debug helper
  window.__UC_GENERIC_DEBUG = () => {
    const ld = parseLD();
    const sj = parseShopifyProductJSON();
    const ogImg = attr('meta[property="og:image"]','content') || attr('meta[property="og:image:secure_url"]','content');
    const img = document.querySelector("picture img, img");
    const imgSrc = img?.getAttribute("src") || "";
    const imgSrcset = img?.getAttribute("srcset") || "";
    const source = document.querySelector("picture source[srcset]");
    const sourceSrcset = source?.getAttribute("srcset") || "";
    const picked = extractImage();
    const price = extractPrice();
    const out = {
      href: location.href,
      pdp: looksLikePDP(),
      ldPresent: !!ld,
      shopifyJson: !!sj,
      title: extractTitle(),
      brand: extractBrand(),
      price,
      ogImg,
      imgSrc, imgSrcset, sourceSrcset,
      picked
    };
    console.log("[UnifiedCart-Generic DEBUG]", out);
    return out;
  };

  log("loaded", { href: location.href, pdp: looksLikePDP() });
})();