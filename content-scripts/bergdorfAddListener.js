// content-scripts/bergdorfAddListener.js
(() => {
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Bergdorf]", ...a);
  const HAS_EXT = !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);

  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const txt  = (s) => ($(s)?.textContent || "").trim();
  const attr = (s,n) => $(s)?.getAttribute(n) || "";
  const first= (a) => Array.isArray(a) ? a[0] : a;
  const token= (s) => (String(s).match(/[$€£]\s?\d[\d.,]+/) || [""])[0];
  const lower= (v) => (typeof v === "string" ? v : String(v || "")).toLowerCase();
  const absUrl = (u) => { try { return new URL(u, location.href).toString(); } catch { return u || ""; } };
  const looksLikePixel = (u="") => {
    const x = String(u).toLowerCase();
    return !x || x.startsWith("data:") || x.endsWith(".svg") || /pixel|1x1|spacer|beacon/.test(x);
  };
  function pickBestFromSrcset(ss) {
    if (!ss) return "";
    try {
      return ss.split(",").map(s => s.trim()).map(p => {
        const [url, w] = p.split(/\s+/);
        const width = parseInt((w || "").replace(/\D/g, ""), 10) || 0;
        return { url: absUrl(url), width };
      }).sort((a,b) => b.width - a.width)[0]?.url || "";
    } catch { return ""; }
  }

  // ---------- JSON-LD ----------
  function findProductNode(node) {
    try {
      if (!node || typeof node !== "object") return null;
      const t = node["@type"];
      if (Array.isArray(t) ? t.map(lower).includes("product") : lower(t) === "product") return node;
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

  // PDP heuristic (tight)
  function isPDP() {
    if (parseLD()) return true;
    const canon = $('link[rel="canonical"]')?.href || "";
    const path  = location.pathname || "";
    return /\/(p|prod)\//i.test(canon || path) || /\/product\//i.test(path);
  }

  // ---------- field extractors ----------
  function extractTitle() {
    return attr('meta[property="og:title"]','content') || txt("h1") || document.title;
  }
  function extractBrand() {
    const ld = parseLD();
    if (ld?.brand) return typeof ld.brand === "string" ? ld.brand : (ld.brand.name || "");
    return txt('[data-testid*="brand"], a[href*="/c/designers/"]') || "";
  }
  function microImage() {
    const el = $('[itemprop="image"]');
    const u = el?.getAttribute?.("content") || el?.getAttribute?.("src") || "";
    return u ? absUrl(u) : "";
  }
  function extractImage() {
    const og = attr('meta[property="og:image"]','content') || attr('meta[property="og:image:secure_url"]','content');
    if (og && !looksLikePixel(og)) return absUrl(og);
    const ld = parseLD();
    if (ld?.image) {
      const v = first(Array.isArray(ld.image) ? ld.image : [ld.image]);
      const url = typeof v === "string" ? v : (v && typeof v === "object" && v.url) ? v.url : "";
      if (url && !looksLikePixel(url)) return absUrl(url);
    }
    const imgEl = $("picture img") || $("img");
    if (imgEl) {
      const best = pickBestFromSrcset(imgEl.getAttribute("srcset"));
      const src = absUrl(imgEl.getAttribute("src") || imgEl.src || "");
      if (best && !looksLikePixel(best)) return best;
      if (src && !looksLikePixel(src)) return src;
    }
    const source = $("picture source[srcset]");
    if (source) {
      const best2 = pickBestFromSrcset(source.getAttribute("srcset"));
      if (best2 && !looksLikePixel(best2)) return best2;
    }
    const lazy = $("img[data-src], img[data-original], img[data-lazy]");
    if (lazy) {
      const lazySrc = absUrl(lazy.getAttribute("data-src") || lazy.getAttribute("data-original") || lazy.getAttribute("data-lazy"));
      if (lazySrc && !looksLikePixel(lazySrc)) return lazySrc;
    }
    const preload = $$('link[rel="preload"][as="image"]').map(l => absUrl(l.getAttribute("href") || l.href)).find(h => h && !looksLikePixel(h));
    if (preload) return preload;
    const mi = microImage();
    if (mi && !looksLikePixel(mi)) return mi;
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
          const n = Number(p); const cur = o.priceCurrency || "USD";
          return Number.isFinite(n) ? `${cur === "USD" ? "$" : cur} ${n.toFixed(2)}` : token(p);
        }
      }
    }
    const mp = attr('meta[itemprop="price"]','content') ||
               attr('meta[property="product:price:amount"]','content') ||
               attr('meta[property="og:price:amount"]','content');
    if (mp) { const n = Number(mp); return Number.isFinite(n) ? `$ ${n.toFixed(2)}` : token(mp); }
    const cand = $$('[class*="price"], [data-testid*="price"], span, div')
      .map(el => el.textContent && el.textContent.trim())
      .filter(Boolean)
      .find(t => /[$€£]\s?\d/.test(t));
    return cand ? token(cand) : "";
  }

  function buildItem() {
    const ld  = parseLD();
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
    } catch (e) { log("sendMessage exception", e); }
  }

  // ---------- variant UI guard ----------
  function isVariantUI(node) {
    if (!node || node.nodeType !== 1) return false;
    const tag = node.tagName;
    if (tag === "SELECT" || tag === "OPTION") return true;
    const role = lower(node.getAttribute("role"));
    if (role === "listbox" || role === "option" || role === "radiogroup" || role === "radio") return true;
    const cls = lower(node.className);
    if (/\b(size|sizes|swatch|variant|variation|attribute|color|colour|fit)\b/.test(cls)) return true;
    const name = lower(node.getAttribute("name"));
    const id   = lower(node.id);
    if (/size|variant|swatch|variation|attribute|color|colour/.test(name)) return true;
    if (/size|variant|swatch|variation|attribute|color|colour/.test(id)) return true;
    return false;
  }

  // ---------- add button targeting (tight) ----------
  const ADD_SEL = [
    'button[name="addToCart"]',
    'button#add-to-bag', 'button#add-to-cart',
    'button.add-to-cart', 'button.AddToBag',
    '[data-action="add-to-cart"]',
    '#product-addtocart-button'
  ].join(",");

  function closestAddButton(start) {
    let el = start && start.nodeType === 1 ? start : start?.parentElement || null;
    for (let i = 0; i < 8 && el; i++) {
      if (isVariantUI(el)) return null;           // clicks inside size/swatch UI => bail
      if (el.matches?.(ADD_SEL)) return el;
      el = el.parentElement;
    }
    return null;
  }

  // ---------- dual-shot (click only; no pointerdown) ----------
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
      obs.observe(document.documentElement, { childList:true, subtree:true, attributes:true });
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

  // ---------- wire up (ONLY on actual Add button clicks) ----------
  document.addEventListener("click", (e) => {
    const btn = closestAddButton(e.target);
    if (!btn) return;               // ignore size/swatch/dropdowns entirely
    if (btn.disabled || btn.getAttribute("aria-disabled")==="true") return;
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

  // ---------- debug helper ----------
  window.__UC_BG_DEBUG = () => {
    const ld = parseLD();
    const out = {
      href: location.href,
      isPDP: isPDP(),
      title: extractTitle(),
      brand: extractBrand(),
      price: extractPrice(),
      img: extractImage(),
    };
    console.log("[UnifiedCart-Bergdorf DEBUG]", out);
    return out;
  };

  log("loaded", { href: location.href, isPDP: isPDP() });
})();