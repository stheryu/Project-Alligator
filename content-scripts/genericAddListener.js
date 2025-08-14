// content-scripts/genericAddListener.js
(() => {
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Generic]", ...a);
  const HAS_EXT = !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);

  // ----------------- helpers -----------------
  const $  = (s, sc = document) => sc.querySelector(s);
  const $$ = (s, sc = document) => Array.from(sc.querySelectorAll(s));
  const txt = (s, sc = document) => (sc.querySelector(s)?.textContent || "").trim();
  const attr = (s, n, sc = document) => sc.querySelector(s)?.getAttribute(n) || "";
  const lower = (v) => (typeof v === "string" ? v : String(v || "")).toLowerCase();
  const token = (s) => (String(s).match(/[$€£]\s?\d[\d.,]+/) || [""])[0];
  const absUrl = (u) => { try { return new URL(u, location.href).toString(); } catch { return u || ""; } };
  const looksLikePixel = (u = "") => {
    const x = String(u).toLowerCase();
    return !x || x.startsWith("data:") || x.endsWith(".svg") || /pixel|1x1|spacer|beacon/.test(x);
  };
  const pickBestFromSrcset = (ss) => {
    if (!ss) return "";
    try {
      return ss.split(",").map(s => s.trim()).map(p => {
        const [url, w] = p.split(/\s+/);
        const width = parseInt((w || "").replace(/\D/g, ""), 10) || 0;
        return { url: absUrl(url), width };
      }).sort((a,b) => b.width - a.width)[0]?.url || "";
    } catch { return ""; }
  };
  const centsToCurrency = (cents, cur = "USD") => {
    const n = Number(cents);
    if (Number.isFinite(n)) {
      const s = (cur === "USD" || !cur) ? "$" : cur;
      return `${s} ${(n / 100).toFixed(2)}`;
    }
    return "";
  };

  // ----------------- mode wiring -----------------
  const __UC_MODE = { enabled: true };
  let WIRED = false, lastHref = location.href;
  const __listeners = [];
  const on  = (t, type, h, opts) => { t.addEventListener(type, h, opts); __listeners.push([t,type,h,opts]); };
  const offAll = () => { for (const [t,ty,h,o] of __listeners) t.removeEventListener(ty,h,o); __listeners.length = 0; };

  function wireAll(){
    if (WIRED) return;
    on(document, "click", handleEarly, true);
    for (const t of ["click","submit","pointerup","touchend","keydown"]) on(document, t, handleLate, true);
    window.addEventListener("message", handlePageHookMsg, true);
    try { chrome.runtime?.onMessage?.addListener?.(handleBgNudge); } catch {}
    watchUrlChanges();
    WIRED = true; log("wired");
  }
  function unwireAll(){
    if (!WIRED) return;
    offAll();
    window.removeEventListener("message", handlePageHookMsg, true);
    try { chrome.runtime?.onMessage?.removeListener?.(handleBgNudge); } catch {}
    resetFlags();
    WIRED = false; log("unwired");
  }
  try {
    chrome.storage?.sync?.get?.({ shoppingMode: true }, ({ shoppingMode }) => {
      __UC_MODE.enabled = !!shoppingMode;
      __UC_MODE.enabled ? wireAll() : unwireAll();
    });
    chrome.storage?.onChanged?.addListener?.((changes, area) => {
      if (area === "sync" && "shoppingMode" in changes) {
        __UC_MODE.enabled = !!changes.shoppingMode.newValue;
        __UC_MODE.enabled ? wireAll() : unwireAll();
      }
    });
    chrome.runtime?.onMessage?.addListener?.((m) => {
      if (m?.action === "SHOPPING_MODE_CHANGED") {
        __UC_MODE.enabled = !!m.enabled;
        __UC_MODE.enabled ? wireAll() : unwireAll();
      }
    });
  } catch {}

  // ----------------- data sources -----------------
  function collectLDProducts(root = document) {
    const prods = [];
    const visit = (node) => {
      try {
        if (!node || typeof node !== "object") return;
        const t = node["@type"];
        const isProd = Array.isArray(t) ? t.map(lower).includes("product") : lower(t) === "product";
        if (isProd) prods.push(node);
        if (Array.isArray(node)) { for (const x of node) visit(x); }
        else {
          if (node["@graph"]) visit(node["@graph"]);
          for (const k of Object.keys(node)) visit(node[k]);
        }
      } catch {}
    };
    for (const s of $$('script[type*="ld+json"]', root)) {
      try { const raw = (s.textContent || "").trim(); if (raw) visit(JSON.parse(raw)); } catch {}
    }
    return prods;
  }
  function parseShopifyProductJSON(root = document) {
    const candidates = [
      ...$$('script[type="application/json"][id^="ProductJson-"]', root),
      ...$$('script[type="application/json"][data-product-json]', root)
    ];
    for (const s of candidates) {
      try {
        const json = JSON.parse((s.textContent || "").trim());
        if (json && (json.variants || json.images || json.title)) return json;
      } catch {}
    }
    const next = (root === document) ? document.getElementById("__NEXT_DATA__") : root.getElementById?.("__NEXT_DATA__");
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

  // ----------------- PDP gate (tight) -----------------
  const PATH_NEG = /(^|\/)(shop|collection|collections|category|categories|catalog|new|sale|deals)(\/|$)/;
  function hostNeedsProductPath() {
    const h = location.hostname.replace(/^www\./, "");
    // OUTNET (and you can add more hosts if needed)
    if (h.endsWith("theoutnet.com")) return true;
    return false;
  }
  function productPathOK() {
    const p = location.pathname.toLowerCase();
    if (hostNeedsProductPath()) return /\/product\//.test(p);
    return true;
  }
  function looksLikePDP() {
    const p = location.pathname.toLowerCase();
    if (PATH_NEG.test(p)) return false;           // listing/home paths
    if (!productPathOK()) return false;           // site-specific requirement
    const ogType = (attr('meta[property="og:type"]','content') || "").toLowerCase();
    if (ogType === "product") return true;
    if (/\/products?\//i.test(p)) return true;    // Shopify PDP
    if ($("form[action*='/cart/add']") || $("[name='add']") || $("[data-add-to-cart]") || $("[data-button-action='add-to-cart']")) return true;
    if (collectLDProducts().length === 1) return true;
    return false;
  }

  // ----------------- product card scoping -----------------
  const CARD_SEL = [
    "[itemtype*='Product']",
    "[itemscope][itemtype*='Product']",
    "[data-product-id]",
    "[data-product]",
    "[data-sku]",
    "[class*='product-card']",
    "[class*='productTile']",
    "[class*='product-item']",
    "[class*='product-tile']",
    "[class*='grid-product']",
    "[class*='product ']"
  ].join(",");
  const findProductCard = (start) => {
    let el = start && start.nodeType === 1 ? start : start?.parentElement || null;
    for (let i = 0; el && i < 10; i++) { if (el.matches?.(CARD_SEL)) return el; el = el.parentElement; }
    return null;
  };

  // ----------------- extractors (scoped & global) -----------------
  function extractGlobalTitle() {
    const og = attr('meta[property="og:title"]','content');
    if (og) return og;
    const ld = collectLDProducts()[0];
    if (ld?.name) return String(ld.name);
    const sj = parseShopifyProductJSON();
    if (sj?.title) return String(sj.title);
    return txt("h1") || document.title;
  }
  function extractGlobalBrand() {
    const ld = collectLDProducts()[0];
    if (ld?.brand) return typeof ld.brand === "string" ? ld.brand : (ld.brand.name || "");
    const sj = parseShopifyProductJSON();
    if (sj?.vendor) return String(sj.vendor);
    const ogSite = attr('meta[property="og:site_name"]','content') || "";
    return ogSite || location.hostname.replace(/^www\./, "");
  }
  function extractGlobalPrice() {
    const ld = collectLDProducts()[0];
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
    const sj = parseShopifyProductJSON();
    const v0 = sj?.variants?.[0];
    if (v0) {
      if (typeof v0.price === "number") return centsToCurrency(v0.price, sj.currency || "USD");
      if (typeof v0.price === "string") { const n = Number(v0.price); return Number.isFinite(n) ? `$ ${n.toFixed(2)}` : token(v0.price) || ""; }
      if (typeof v0.compare_at_price === "number") return centsToCurrency(v0.compare_at_price, sj.currency || "USD");
    }
    const mp = attr('meta[itemprop="price"]','content') ||
               attr('meta[property="product:price:amount"]','content') ||
               attr('meta[property="og:price:amount"]','content') ||
               attr('meta[name="twitter:data1"]','content');
    if (mp) { const n = Number(mp); return Number.isFinite(n) ? `$ ${n.toFixed(2)}` : token(mp); }
    const cand = $$('[class*="price"], [data-testid*="price"], [itemprop*="price"], span, div')
      .map(el => el.textContent && el.textContent.trim())
      .filter(Boolean)
      .filter(t => !/\b(per|\/)\s?(count|ct|ea|each|oz|lb|kg|ml|g)\b/i.test(t))
      .find(t => /[$€£]\s?\d/.test(t));
    return cand ? token(cand) : "";
  }

  function extractScopedTitle(root) {
    return txt('[itemprop="name"]', root)
        || txt('[data-test*="title"]', root)
        || txt('[data-testid*="title"]', root)
        || txt('[class*="title"]', root)
        || txt("a[title]", root)
        || extractGlobalTitle();
  }
  function extractScopedBrand(root) {
    return txt('[itemprop="brand"]', root)
        || txt('[data-test*="brand"]', root)
        || txt('[data-testid*="brand"]', root)
        || txt('a[href*="/brands"]', root)
        || extractGlobalBrand();
  }
  function extractScopedPrice(root) {
    const ldEl = $('script[type*="ld+json"]', root);
    if (ldEl) {
      try {
        const j = JSON.parse(ldEl.textContent || "");
        const offers = Array.isArray(j?.offers) ? j.offers : (j?.offers ? [j.offers] : []);
        for (const o of offers) {
          const p = o.price || o.lowPrice || o.highPrice || o?.priceSpecification?.price;
          if (p != null && p !== "") {
            const n = Number(p); const cur = o.priceCurrency || "USD";
            return Number.isFinite(n) ? `${cur === "USD" ? "$" : cur} ${n.toFixed(2)}` : token(p);
          }
        }
      } catch {}
    }
    const t = $$('[class*="price"], [data-testid*="price"], [itemprop*="price"], span, div', root)
      .map(el => el.textContent && el.textContent.trim())
      .filter(Boolean)
      .filter(s => !/\b(per|\/)\s?(count|ct|ea|each|oz|lb|kg|ml|g)\b/i.test(s))
      .find(s => /[$€£]\s?\d/.test(s));
    return t ? token(t) : "";
  }
  function extractScopedImage(root) {
    const og = attr('meta[property="og:image"]','content', root) || attr('meta[property="og:image:secure_url"]','content', root);
    if (og && !looksLikePixel(og)) return absUrl(og);
    const el = $("picture img", root) || $("img", root);
    if (el) {
      const ss = el.getAttribute("srcset");
      const best = pickBestFromSrcset(ss);
      const src = absUrl(el.getAttribute("src") || el.src || "");
      if (best && !looksLikePixel(best)) return best;
      if (src && !looksLikePixel(src)) return src;
    }
    return "";
  }

  // ----------------- CTA detection (strict) -----------------
  // Only explicit add/buy words. (No "shop now", no "view")
  const POS = /\b(add(?:\s+to)?\s*(?:bag|cart)|buy\s*(?:now)?|purchase)\b/i;
  const NEG = /\b(wish(?:list)?|favorites?|registry|newsletter|subscribe|sign\s*(?:in|up)|gift\s*card|address|payment|coupon|promo|apply|logout|reorder|track\s*order|shop\s*pay|paypal|apple\s*pay|google\s*pay|klarna|afterpay|learn\s*more|view|discover|explore|see\s*(?:more|details)|quick\s*view)\b/i;
  const QTY = /\b(qty|quantity|increment|decrement|plus|minus|stepper|spinner)\b/i;

  // STRONG selectors only (removed generic "button" / generic input)
  const STRONG_SEL = [
    "form[action*='/cart/add'] button[type='submit']",
    "form[action*='/cart/add'] [name='add']",
    "button[name='add']",
    "[data-add-to-cart]",
    "[data-button-action='add-to-cart']",
    "[data-role='tocart']",
    ".single_add_to_cart_button",
    ".sqs-add-to-cart-button",
    "#product-addtocart-button",
    "[data-testid*='add-to-cart']",
    "[data-test*='add-to-cart']",
    "[data-qa*='add-to-cart']"
  ].join(",");

  const insideAddForm = (el) => {
    const f = el?.closest?.("form");
    if (!f) return false;
    const a = lower(f.getAttribute("action") || "");
    return /\/cart\/add/.test(a);
  };
  const isAnchor = (el) => el && el.tagName === "A";
  const isInteractiveButtonish = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const role = lower(el.getAttribute?.("role"));
    if (el.tagName === "BUTTON" || el.tagName === "INPUT") return true;
    if (role === "button") return true;
    return false;
  };

  function looksLikeAdd(el) {
    if (!el || el.nodeType !== 1) return false;

    const sAll = [
      el.textContent || "",
      el.getAttribute?.("aria-label") || "",
      el.getAttribute?.("title") || "",
      el.getAttribute?.("data-testid") || "",
      el.getAttribute?.("data-test") || "",
      el.getAttribute?.("data-qa") || "",
      el.getAttribute?.("name") || "",
      el.getAttribute?.("id") || "",
      el.className || ""
    ].join(" ").toLowerCase();

    if (QTY.test(sAll)) return false;
    if (NEG.test(sAll)) return false;

    // Strong selectors
    if (el.matches?.(STRONG_SEL)) return true;

    // Otherwise, require: interactive buttonish or inside /cart/add form + explicit positive text
    if ((isInteractiveButtonish(el) || insideAddForm(el)) && POS.test(sAll)) return true;

    return false;
  }

  function findActionElFromEvent(e) {
    const path = (e.composedPath && e.composedPath()) || [];
    for (const n of path) {
      if (!(n && n.nodeType === 1)) continue;
      if (isAnchor(n)) return null;               // never count anchors
      if (looksLikeAdd(n)) return n;
      // bail if this is option/swatch UI
      const tag = n.tagName;
      if (/^(select|option)$/i.test(tag)) return null;
      const role = lower(n.getAttribute?.("role"));
      if (role === "radiogroup" || role === "listbox" || role === "option" || role === "radio") return null;
    }
    return null;
  }

  // ----------------- in-page hook confirmation (from pageHook.inpage.js) -----------------
  let lastAddEventAt = 0;
  function handlePageHookMsg(ev) {
    const d = ev?.data || {};
    if (d && d.source === "UnifiedCartPage" && d.type === "ADD_EVENT") {
      // pageHook.inpage.js should only post for **POST** /cart/add
      lastAddEventAt = Date.now();
      if (DEBUG) log("ADD_EVENT", d.via, d.url);
      if (looksLikePDP()) setTimeout(sendSettled, 120);
    }
  }
  const seenRecentAddEvent = (ms=1200) => (Date.now() - lastAddEventAt) <= ms;

  function handleBgNudge(msg){
    if (!__UC_MODE.enabled) return;
    if (msg?.action === "ADD_TRIGGERED" && looksLikePDP()) setTimeout(sendSettled, 150);
  }

  // ----------------- state & debounce -----------------
  let sentQuick=false, sentSettled=false, lastKey="", lastAt=0;
  let lastActionEl=null, lastActionAt=0, lastActionStrong=false;
  const debounce = (k,ms)=>{ const now=Date.now(); if(k===lastKey && now-lastAt<ms) return false; lastKey=k; lastAt=now; return true; };
  const resetFlags = () => { sentQuick=false; sentSettled=false; lastKey=""; lastAt=0; lastActionEl=null; lastActionAt=0; lastActionStrong=false; };

  // ----------------- item builders -----------------
  function buildItemFromCard(card) {
    const ldScript = $('script[type*="ld+json"]', card);
    let sku = ""; if (ldScript) { try { const j = JSON.parse(ldScript.textContent||""); sku = j?.sku || j?.mpn || ""; } catch {} }
    const title = extractScopedTitle(card);
    const brand = extractScopedBrand(card);
    const price = extractScopedPrice(card) || extractGlobalPrice();
    const img = extractScopedImage(card);
    return {
      id: String(sku || title || location.href),
      title: title || extractGlobalTitle(),
      brand: brand || extractGlobalBrand(),
      price: price || "",
      img: img || "",
      link: location.href
    };
  }
  function buildItemGlobal() {
    const og = attr('meta[property="og:image"]','content') || attr('meta[property="og:image:secure_url"]','content');
    let img = "";
    if (og && !looksLikePixel(og)) img = absUrl(og);
    else {
      const el = $("picture img") || $("img");
      if (el) { img = pickBestFromSrcset(el.getAttribute("srcset")) || absUrl(el.getAttribute("src") || el.src || ""); }
    }
    return {
      id: String(location.href),
      title: extractGlobalTitle(),
      brand: extractGlobalBrand(),
      price: extractGlobalPrice(),
      img,
      link: location.href
    };
  }

  // ----------------- dual-shot send -----------------
  function sendItemSafe(item) {
    if (!HAS_EXT) { log("context invalidated — refresh page"); return; }
    try {
      chrome.runtime.sendMessage({ action: "ADD_ITEM", item }, () => {
        if (chrome.runtime?.lastError) log("sendMessage lastError", chrome.runtime.lastError.message);
      });
    } catch (e) { log("sendMessage exception", e); }
  }
  function settleThenScrape(ms = 900){
    return new Promise((resolve)=>{
      let done=false;
      const initial = lastActionEl ? buildItemFromCard(findProductCard(lastActionEl) || document) : buildItemGlobal();
      if (initial.price || initial.img){ done=true; return resolve(initial); }
      const timer=setTimeout(()=>{ if(!done){ done=true; obs?.disconnect?.(); resolve(lastActionEl ? buildItemFromCard(findProductCard(lastActionEl) || document) : buildItemGlobal()); }}, ms);
      const obs=new MutationObserver(()=>{
        if(done) return;
        const item = lastActionEl ? buildItemFromCard(findProductCard(lastActionEl) || document) : buildItemGlobal();
        if(item.price || item.img){ clearTimeout(timer); done=true; obs.disconnect(); resolve(item); }
      });
      obs.observe(document.documentElement, { childList:true, subtree:true, attributes:true });
    });
  }

  function sendQuick(){
    if (!__UC_MODE.enabled) return;
    // Never quick-send on listing paths; only on PDP
    if (!looksLikePDP()) return;
    if (sentQuick) return;
    if (!debounce(location.href,200)) return;
    const card = lastActionEl && findProductCard(lastActionEl);
    const item = card ? buildItemFromCard(card) : buildItemGlobal();
    if (!item.title) return;
    log("ADD_ITEM quick", item);
    sendItemSafe(item);
    sentQuick=true;
  }

  async function sendSettled(){
    if (!__UC_MODE.enabled) return;
    // Settled send only if PDP OR we had a strong add on a card + recent POST /cart/add confirm
    const onPdp = looksLikePDP();
    const allowFromCard = (!!lastActionEl && (lastActionStrong || insideAddForm(lastActionEl)) && seenRecentAddEvent(1800));
    if (!onPdp && !allowFromCard) return;
    if (sentSettled) return;
    const item = await settleThenScrape();
    if (!item.title) return;
    log("ADD_ITEM settled", item);
    sendItemSafe(item);
    sentSettled=true;
  }

  // ----------------- handlers -----------------
  function handleEarly(e){
    if (!__UC_MODE.enabled) return;
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;

    const el = findActionElFromEvent(e);
    if (!el) return;

    lastActionEl = el;
    lastActionAt = Date.now();

    // "Strong" only if matches explicit add selectors OR POS text inside an add form
    const textHit = POS.test((el.textContent || "").toLowerCase());
    lastActionStrong = el.matches?.(STRONG_SEL) || insideAddForm(el) || (textHit && isInteractiveButtonish(el));

    // quick only on PDP (prevents /shop/ false positives)
    if (lastActionStrong) sendQuick();
  }

  function handleLate(e){
    if (!__UC_MODE.enabled) return;
    if (!lastActionEl || Date.now() - lastActionAt > 1500) return;

    // If we're **not** on a PDP, require recent POST /cart/add confirmation
    if (!looksLikePDP() && !seenRecentAddEvent(1500)) {
      if (DEBUG) log("non-PDP without network confirm → ignore");
      lastActionEl = null; lastActionAt = 0; lastActionStrong = false;
      return;
    }
    setTimeout(sendSettled, 160);
  }

  function handleBgNudge(msg){
    if (!__UC_MODE.enabled) return;
    if (msg?.action === "ADD_TRIGGERED" && (looksLikePDP() || lastActionEl)) {
      setTimeout(sendSettled, 150);
    }
  }

  // ----------------- SPA URL watcher -----------------
  function onUrlMaybeChanged(){ if (location.href !== lastHref) { lastHref = location.href; resetFlags(); } }
  function watchUrlChanges(){
    const _ps = history.pushState, _rs = history.replaceState;
    history.pushState = function(...a){ const r = _ps.apply(this,a); onUrlMaybeChanged(); return r; };
    history.replaceState = function(...a){ const r = _rs.apply(this,a); onUrlMaybeChanged(); return r; };
    window.addEventListener("popstate", onUrlMaybeChanged);
    window.addEventListener("hashchange", onUrlMaybeChanged);
    setInterval(onUrlMaybeChanged, 1000);
  }

  // ----------------- debug -----------------
  window.__UC_GENERIC_DEBUG = () => {
    const out = {
      href: location.href,
      pdp: looksLikePDP(),
      hostNeedsProductPath: hostNeedsProductPath(),
      ldProducts: collectLDProducts().length,
      title: extractGlobalTitle(),
      brand: extractGlobalBrand(),
      price: extractGlobalPrice()
    };
    console.log("[UnifiedCart-Generic DEBUG]", out);
    return out;
  };

  if (__UC_MODE.enabled) wireAll();
  log("loaded", { href: location.href, pdp: looksLikePDP() });
})();