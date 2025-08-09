// content-scripts/genericAddListener.js
(() => {
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Generic]", ...a);
  const HAS_EXT = !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);

  // ---------- tiny helpers ----------
  const $    = (s) => document.querySelector(s);
  const $$   = (s) => Array.from(document.querySelectorAll(s));
  const txt  = (s) => ($(s)?.textContent || "").trim();
  const attr = (s,n) => $(s)?.getAttribute(n) || "";
  const first= (a) => Array.isArray(a) ? a[0] : a;
  const token= (s) => (String(s).match(/[$€£]\s?\d[\d.,]+/) || [""])[0];
  const lower= (v) => (typeof v === "string" ? v : String(v || "")).toLowerCase();

  function absUrl(u) { try { return new URL(u, location.href).toString(); } catch { return u || ""; } }
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

  // ---------- JSON sources ----------
  function findProductNode(node) {
    try {
      if (!node || typeof node !== "object") return null;
      const t = node["@type"];
      if (Array.isArray(t) ? t.map(lower).includes("product") : lower(t) === "product") return node;
      if (Array.isArray(node)) {
        for (const x of node) { const hit = findProductNode(x); if (hit) return hit; }
      } else {
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

  // Shopify Product JSON (incl. headless via __NEXT_DATA__)
  function parseShopifyProductJSON() {
    const candidates = [
      ...$$('script[type="application/json"][id^="ProductJson-"]'),
      ...$$('script[type="application/json"][data-product-json]')
    ];
    for (const s of candidates) {
      try {
        const json = JSON.parse((s.textContent || "").trim());
        if (json && (json.variants || json.images || json.title)) return json;
      } catch {}
    }
    const next = $('#__NEXT_DATA__');
    if (next) {
      try {
        const json = JSON.parse(next.textContent || "");
        const deepFind = (obj) => {
          if (!obj || typeof obj !== "object") return null;
          if (obj.variants && obj.images && obj.title) return obj;
          for (const k of Object.keys(obj)) { const r = deepFind(obj[k]); if (r) return r; }
          return null;
        };
        const hit = deepFind(json);
        if (hit) return hit;
      } catch {}
    }
    return null;
  }

  // ---------- microdata ----------
  const microName  = () => txt('[itemprop="name"]') || "";
  function microPrice() {
    const el = $('[itemprop="price"]');
    if (!el) return "";
    const c = el.getAttribute("content");
    if (c) {
      const n = Number(c);
      return Number.isFinite(n) ? `$ ${n.toFixed(2)}` : token(c);
    }
    return token(el.textContent || "");
  }
  function microImage() {
    const el = $('[itemprop="image"]');
    const u = el?.getAttribute?.("content") || el?.getAttribute?.("src") || "";
    return u ? absUrl(u) : "";
  }

  // ---------- add/buy button detection (strict; avoids variant UI) ----------
  const POS = /\badd(?:ing)?(?:\s+to)?\s+(?:shopping\s+)?(?:bag|cart)\b|\bbuy now\b|\bpurchase\b/i;
  const NEG = /\b(add to wish|wishlist|favorites|list|registry|address|payment|card|newsletter)\b/i;

  function isVariantUI(node) {
    if (!node || node.nodeType !== 1) return false;
    const tag  = node.tagName;
    if (tag === "SELECT" || tag === "OPTION") return true;
    const role = lower(node.getAttribute("role"));
    if (role === "listbox" || role === "option" || role === "radiogroup" || role === "radio") return true;

    const cls  = lower(node.className);
    const name = lower(node.getAttribute("name"));
    const id   = lower(node.id);
    const dti  = lower(node.getAttribute("data-testid"));
    const dha  = lower(node.getAttribute("data-action"));

    // Common size/variant cues (incl. SFCC/Demandware)
    if (/\b(size|sizes|swatch|variant|variation|colour|color|fit)\b/.test(cls)) return true;
    if (/\b(size|variant|swatch|colour|color|fit)\b/.test(name)) return true;
    if (/\b(size|variant|swatch|colour|color|fit)\b/.test(id)) return true;
    if (/^dwvar_/.test(name) || /^dwopt/.test(name)) return true; // SFCC option fields
    if (/attribute|option|selector/.test(cls) && /size|color|colour/.test(cls)) return true;
    if (/select/.test(dha) && /variant|size|color|colour/.test(dha)) return true;
    if (/size/.test(dti) && /(option|selector|swatch)/.test(dti)) return true;

    return false;
  }

  const BUTTONISH_SEL = [
    "button",
    'input[type="submit"]',
    'input[type="button"]',
    "[role='button']",
    "a[role='button']",
    // common platforms
    "[data-action='add-to-cart']",
    "[data-button-action='add-to-cart']",
    "[data-add-to-cart]",
    "[data-hook='add-to-cart']",
    "#product-addtocart-button",
    "[data-role='tocart']",
    // looser, for SSENSE & friends
    "[name='add']",
    "[id='add-to-bag']",
    "[id='add-to-cart']",
    "[data-testid*='add']",
    "[data-test*='add']",
    "[data-qa*='add']"
  ].join(",");

  function looksLikeAdd(el) {
    if (!el || el.nodeType !== 1) return false;
    const s = [
      el.innerText || el.textContent || "",
      el.getAttribute?.("aria-label") || "",
      el.getAttribute?.("data-testid") || "",
      el.getAttribute?.("id") || "",
      el.getAttribute?.("name") || "",
      el.getAttribute?.("class") || "",
      el.getAttribute?.("data-action") || "",
      el.getAttribute?.("data-hook") || "",
      el.getAttribute?.("data-role") || ""
    ].join(" ").toLowerCase();

    if (s.includes("adding")) return false;
    if (NEG.test(s)) return false;
    if (POS.test(s)) return true;

    // platform hints
    if (/\badd-to-cart\b|\bproduct-form__submit\b|\bshopify-payment-button\b/.test(s)) return true;     // Shopify
    if (/\bsingle_add_to_cart_button\b|\badd_to_cart_button\b|\bwoocommerce\b/.test(s)) return true;    // Woo
    if (/\bform-action-addToCart\b|\bdata-add-to-cart\b/.test(s)) return true;                          // BigCommerce
    if (/\bproduct-addtocart-button\b|\btocart\b/.test(s)) return true;                                 // Magento
    if (/\badd-to-cart\b/.test(s) || /cart-addproduct/.test(s) || /\bpid\b/.test(s)) return true;       // SFCC
    if (/\bsqs-add-to-cart-button\b|\bProductItem-addToCart\b/.test(s)) return true;                    // Squarespace
    if (/\badd-to-cart\b/.test(el.getAttribute?.("data-hook") || "")) return true;                      // Wix-ish
    return false;
  }

  function closestActionEl(start) {
    let el = start && start.nodeType === 1 ? start : start?.parentElement || null;
    for (let i = 0; i < 10 && el; i++) {
      if (isVariantUI(el)) return null;                        // inside size/swatch UI — bail
      if (el.matches?.(BUTTONISH_SEL) || looksLikeAdd(el)) {
        const disabled = el.hasAttribute?.("disabled") || lower(el.getAttribute?.("aria-disabled")) === "true";
        if (!disabled) return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function isAddClick(evt) {
    if (evt.type === "click" && evt.button !== 0) return false; // left clicks only
    if (evt.type === "keydown" && evt.key !== "Enter" && evt.key !== " ") return false;
    const actionEl = closestActionEl(evt.target);
    return !!actionEl && looksLikeAdd(actionEl);
  }

  // ---------- PDP heuristic ----------
  function looksLikePDP() {
    if (parseLD()) return true;
    if (parseShopifyProductJSON()) return true;

    const ogType = attr('meta[property="og:type"]','content') || "";
    if (/product/i.test(ogType)) return true;

    // Shopify
    if ($('form[action*="/cart/add"]') || $('[name="add"]') || $('[data-add-to-cart]')) return true;
    if ($('input[name="id"]') && ($('[type="submit"][name="add"]') || $('[data-product-form]'))) return true;

    // WooCommerce
    if (document.querySelector("form.cart") ||
        document.querySelector("button.single_add_to_cart_button") ||
        document.querySelector('[name="add-to-cart"]')) return true;

    // BigCommerce
    if (document.querySelector('form[action*="/cart.php"]') ||
        document.querySelector('#form-action-addToCart') ||
        document.querySelector('[data-button-state][data-add-to-cart]')) return true;

    // Magento 2
    if (document.querySelector('form#product_addtocart_form') ||
        document.querySelector('#product-addtocart-button') ||
        document.querySelector('[data-role="tocart"]')) return true;

    // SFCC / Demandware (DWR/others)
    if (document.querySelector('form[name="add-to-cart"]') ||
        document.querySelector('[data-action="add-to-cart"]') ||
        document.querySelector('button.add-to-cart') ||
        document.querySelector('form[action*="Cart-AddProduct"]') ||
        document.querySelector('form[id*="addtocart"]') ||
        document.querySelector('input[name="pid"]')) return true;

    // PrestaShop
    if (document.querySelector('[data-button-action="add-to-cart"]')) return true;

    // Squarespace
    if (document.querySelector('.sqs-add-to-cart-button') ||
        document.querySelector('.ProductItem-addToCart')) return true;

    // Wix
    if (document.querySelector('button[data-hook="add-to-cart"]')) return true;

    // Sanity: title + price + image
    const hasH1 = !!$("h1");
    if (!hasH1) return false;
    const hasPrice = $$("span,div,p,strong,b").some(el => /[$€£]\s?\d/.test(el.textContent || ""));
    if (!hasPrice) return false;
    const img = $("picture img, img");
    const src = img?.getAttribute("src") || img?.src || "";
    if (!src || looksLikePixel(src)) return false;

    // Path hints
    const path = location.pathname.toLowerCase();
    const isProductPath =
      /\/products?\//.test(path) ||   // Shopify
      /\/product\//.test(path)   ||   // SFCC & headless (DWR)
      /\/p\//.test(path)        ||
      /\/dp\//.test(path)       ||
      /\/(item|items|sku|prod|goods|shop)\//.test(path) ||
      /-p\d+(?:\.html|$)/.test(path); // Zara-like

    if (!isProductPath) {
      if (/(^|\/)(cart|checkout|shopping-?bag)(\/|$)/.test(path)) return false;
      if (/(^|\/)(wishlist|account|login|register)(\/|$)/.test(path)) return false;
      if (/(^|\/)(collection|collections|category|categories|catalog)(\/|$)/.test(path)) return false;
    }
    return true;
  }

  // ---------- field extractors ----------
  function extractTitle() {
    const og = attr('meta[property="og:title"]','content');
    if (og) return og;
    const ld = parseLD();
    if (ld?.name) return String(ld.name);
    const sj = parseShopifyProductJSON();
    if (sj?.title) return String(sj.title);
    const mn = microName();
    if (mn) return mn;
    return txt("h1") || document.title;
  }

  function extractBrand() {
    const ld = parseLD();
    if (ld?.brand) return typeof ld.brand === "string" ? ld.brand : (ld.brand.name || "");
    const ogSite = attr('meta[property="og:site_name"]','content') || "";
    if (ogSite) return ogSite;
    const sj = parseShopifyProductJSON();
    if (sj?.vendor) return String(sj.vendor);
    return location.hostname.replace(/^www\./, "");
  }

  function extractImage() {
    const og = attr('meta[property="og:image"]','content') || attr('meta[property="og:image:secure_url"]','content');
    if (og && !looksLikePixel(og)) return absUrl(og);

    const ld = parseLD();
    if (ld?.image) {
      const v = first(ld.image);
      const url = (typeof v === "string") ? v : (v && typeof v === "object" && v.url) ? v.url : "";
      if (url && !looksLikePixel(url)) return absUrl(url);
    }

    const sj = parseShopifyProductJSON();
    if (sj?.images?.length) {
      const v = first(sj.images);
      const url = (typeof v === "string") ? v : v?.src || v?.url || "";
      if (url && !looksLikePixel(url)) return absUrl(url);
    }

    const mi = microImage();
    if (mi && !looksLikePixel(mi)) return mi;

    const imgEl = $("picture img") || $("img");
    if (imgEl) {
      const ss  = imgEl.getAttribute("srcset");
      const best= pickBestFromSrcset(ss);
      const src = absUrl(imgEl.getAttribute("src") || imgEl.src || "");
      if (best && !looksLikePixel(best)) return best;
      if (src  && !looksLikePixel(src))  return src;
    }

    const source = $("picture source[srcset]");
    if (source) {
      const ss2 = source.getAttribute("srcset");
      const best2 = pickBestFromSrcset(ss2);
      if (best2 && !looksLikePixel(best2)) return best2;
    }

    const lazyImg = $("img[data-src], img[data-original], img[data-lazy], img[data-srcset]");
    if (lazyImg) {
      const lazySrcset = lazyImg.getAttribute("data-srcset");
      const bestL = pickBestFromSrcset(lazySrcset);
      if (bestL && !looksLikePixel(bestL)) return bestL;
      const lazySrc = absUrl(
        lazyImg.getAttribute("data-src") ||
        lazyImg.getAttribute("data-original") ||
        lazyImg.getAttribute("data-lazy")
      );
      if (lazySrc && !looksLikePixel(lazySrc)) return lazySrc;
    }

    const preload = $$('link[rel="preload"][as="image"]')
      .map(l => absUrl(l.getAttribute("href") || l.href))
      .find(href => href && !looksLikePixel(href));
    if (preload) return preload;

    const tw = attr('meta[name="twitter:image"]','content');
    if (tw && !looksLikePixel(tw)) return absUrl(tw);

    return "";
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

    const sj = parseShopifyProductJSON();
    if (sj?.variants?.length) {
      const v0 = sj.variants[0];
      if (typeof v0.price === "number") return centsToCurrency(v0.price, sj.currency || "USD");
      if (typeof v0.price === "string") {
        const n = Number(v0.price);
        if (Number.isFinite(n)) return `$ ${n.toFixed(2)}`;
        const tok = token(v0.price);
        if (tok) return tok;
      }
      if (typeof v0.compare_at_price === "number") return centsToCurrency(v0.compare_at_price, sj.currency || "USD");
      if (typeof v0.compare_at_price === "string") {
        const n2 = Number(v0.compare_at_price);
        if (Number.isFinite(n2)) return `$ ${n2.toFixed(2)}`;
      }
    }

    const mp = microPrice() ||
               attr('meta[itemprop="price"]','content') ||
               attr('meta[property="product:price:amount"]','content') ||
               attr('meta[property="og:price:amount"]','content') ||
               attr('meta[name="twitter:data1"]','content');
    if (mp) {
      const n = Number(mp);
      return Number.isFinite(n) ? `$ ${n.toFixed(2)}` : token(mp);
    }

    const cand = $$('[class*="price"], [data-testid*="price"], [itemprop*="price"], span, div')
      .map(el => el.textContent && el.textContent.trim())
      .filter(Boolean)
      .filter(t => !/\b(per|\/)\s?(count|ct|ea|each|oz|lb|kg|ml|g)\b/i.test(t))
      .find(t => /[$€£]\s?\d/.test(t));
    return cand ? token(cand) : "";
  }

  // ---------- item builder ----------
  function buildItem() {
    const ld = parseLD();
    const sj = parseShopifyProductJSON();
    const sku = (ld && (ld.sku || ld.mpn)) || (sj && (sj.id || sj.product_id)) || "";
    return {
      id: String(sku || location.href),
      title: extractTitle(),
      brand: extractBrand(),
      price: extractPrice(),
      img: extractImage(),
      link: location.href
    };
  }

  // ---------- send logic ----------
  function sendItemSafe(item) {
    if (!HAS_EXT) { log("context invalidated — refresh page"); return; }
    try {
      chrome.runtime.sendMessage({ action: "ADD_ITEM", item }, () => {
        if (chrome.runtime?.lastError) log("sendMessage lastError", chrome.runtime.lastError.message);
      });
    } catch (e) { log("sendMessage exception", e); }
  }

  // Dual-shot
  let sentQuick=false, sentSettled=false, lastKey="", lastAt=0;
  const debounce = (k,ms)=>{ const now=Date.now(); if(k===lastKey && now-lastAt<ms) return false; lastKey=k; lastAt=now; return true; };

  function settleThenScrape(ms = 900){
    return new Promise((resolve)=>{
      let done=false; const initial=buildItem();
      if (initial.price || initial.img){ done=true; return resolve(initial); }
      const timer=setTimeout(()=>{ if(!done){ done=true; obs?.disconnect?.(); resolve(buildItem()); }}, ms);
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
    const item=buildItem();
    if(!item.title) return; // allow quick with title; settled fills details
    log("ADD_ITEM quick", item);
    sendItemSafe(item);
    sentQuick=true;
  }

  async function sendSettled(){
    if(!looksLikePDP() || sentSettled) return;
    const item=await settleThenScrape();
    if(!item.title) return;
    log("ADD_ITEM settled", item);
    sendItemSafe(item);
    sentSettled=true;
  }

  // ---------- wire events ----------
  // Quick only on actual *click* or keyboard activation of a real button-ish control
  document.addEventListener("click", (e) => { if (isAddClick(e)) sendQuick(); }, true);
  ["click","submit","pointerup","touchend","keydown"].forEach(t => {
    document.addEventListener(t, (e) => { if (isAddClick(e)) setTimeout(sendSettled, 200); }, true);
  });

  // Optional: honor background nudges (Amazon/eBay webRequest)
  chrome.runtime?.onMessage?.addListener?.((msg)=>{
    if (msg?.action === "ADD_TRIGGERED" && looksLikePDP()){
      setTimeout(sendSettled, 200);
    }
  });

  // SPA URL change watcher — reset flags only
  let lastHref = location.href;
  function resetFlags(){ sentQuick=false; sentSettled=false; lastKey=""; lastAt=0; }
  function onUrlMaybeChanged(){ if (location.href !== lastHref) { lastHref = location.href; resetFlags(); } }
  (function watchUrlChanges(){
    const _ps = history.pushState, _rs = history.replaceState;
    history.pushState = function(...a){ const r = _ps.apply(this,a); onUrlMaybeChanged(); return r; };
    history.replaceState = function(...a){ const r = _rs.apply(this,a); onUrlMaybeChanged(); return r; };
    window.addEventListener("popstate", onUrlMaybeChanged);
    window.addEventListener("hashchange", onUrlMaybeChanged);
    setInterval(onUrlMaybeChanged, 1000);
  })();

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