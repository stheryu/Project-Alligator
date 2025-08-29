// content-scripts/genericAddListener.js
(() => {
  if (window.top !== window) return;
  if (window.__UC_GENERIC_INJECTED__) return;
  window.__UC_GENERIC_INJECTED__ = true;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Generic]", ...a);
  const HOST = location.hostname.toLowerCase();

  // Hosts where “quick” is noisy → prefer nudges/settled only
  const DISABLE_QUICK_HOSTS = /(\.|^)(amazon|zara|mango|kith|theoutnet)\.com$/i;
  const IS_AMAZON = /\bamazon\./i.test(HOST);

  // Hosts that legitimately add off-PDP (allow click + nudge off-PDP)
  const ALLOW_OFF_PDP_HOSTS =
    /(\.|^)uniqlo\.com$|(\.|^)zara\.(com|net)$|(\.|^)mango\.com$|(\.|^)ebay\.com$/i;

  // ---------- global state (hot-reload safe) ----------
  const STATE = (window.__UC_GENERIC_STATE ||= {
    wired: false,
    listeners: [],
    modeEnabled: true,
  });

  const __UC_MODE = {
    get enabled() { return STATE.modeEnabled; },
    set enabled(v) { STATE.modeEnabled = !!v; }
  };

  const __listeners = STATE.listeners;
  function on(t, type, h, opts) { t.addEventListener(type, h, opts); __listeners.push([t, type, h, opts]); }
  function offAll() { for (const [t, ty, h, o] of __listeners) t.removeEventListener(ty, h, o); __listeners.length = 0; }

  // ---------- tiny helpers ----------
  const $    = (s) => document.querySelector(s);
  const $$   = (s) => Array.from(document.querySelectorAll(s));
  const txt  = (s) => ($(s)?.textContent || "").trim();
  const attr = (s, n) => $(s)?.getAttribute(n) || "";
  const first= (a) => Array.isArray(a) ? a[0] : a;
  const token= (s) => (String(s).match(/[$€£]\s?\d[\d.,]+/) || [""])[0];
  const absUrl = (u) => { try { return new URL(u, location.href).toString(); } catch { return u || ""; } };
  function looksLikePixel(u = "") {
    const x = String(u).toLowerCase();
    return !x || x.startsWith("data:") || x.endsWith(".svg") || /pixel|1x1|spacer|beacon/.test(x);
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
        .sort((a, b) => b.width - a.width)[0]?.url || "";
    } catch { return ""; }
  }
  function centsToCurrency(cents, cur = "USD") {
    const n = Number(cents);
    if (Number.isFinite(n)) return `${cur === "USD" ? "$" : cur} ${(n / 100).toFixed(2)}`;
    return "";
  }

  // ---------- Amazon: require real Add-to-Cart click recently ----------
  const AMZ_ADD_SELECTORS = [
    "#add-to-cart-button",
    "#add-to-cart-button-ubb",
    'input[name="submit.add-to-cart"]',
    'form[action*="handle-buy-box"] [type="submit"]',
    "[data-action='add-to-cart']",
    "[aria-labelledby*='add-to-cart-button']"
  ].join(",");
  let amzLastAddClickTs = 0;
  document.addEventListener("click", (e) => {
    try {
      if (!IS_AMAZON) return;
      const btn = e.target?.closest?.(AMZ_ADD_SELECTORS);
      if (btn) amzLastAddClickTs = Date.now();
    } catch {}
  }, true);
  const amzClickedRecently = (ms = 6000) =>
    IS_AMAZON && (Date.now() - amzLastAddClickTs) < ms;

  // ---------- JSON & microdata ----------
  function findProductNode(node) {
    try {
      if (!node || typeof node !== "object") return null;
      const t = node["@type"];
      const isProduct = Array.isArray(t)
        ? t.map(String).map(s => s.toLowerCase()).includes("product")
        : String(t || "").toLowerCase() === "product";
      if (isProduct) return node;
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
    const next = document.getElementById('__NEXT_DATA__');
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
  const microName  = () => txt('[itemprop="name"]') || "";
  function microPrice() {
    const el = document.querySelector('[itemprop="price"]');
    if (!el) return "";
    const c = el.getAttribute("content");
    if (c) {
      const n = Number(c);
      return Number.isFinite(n) ? `$ ${n.toFixed(2)}` : token(c);
    }
    return token(el.textContent || "");
  }
  function microImage() {
    const el = document.querySelector('[itemprop="image"]');
    const u = el?.getAttribute?.("content") || el?.getAttribute?.("src") || "";
    return u ? absUrl(u) : "";
  }

  // ---------- PDP heuristic ----------
  function looksLikePDP() {
    if (parseLD()) return true;
    if (parseShopifyProductJSON()) return true;
    const ogType = attr('meta[property="og:type"]','content') || "";
    if (/product/i.test(ogType)) return true;

    if (document.querySelector('form[action*="/cart/add"]') ||
        document.querySelector('[name="add"]') ||
        document.querySelector('[data-add-to-cart]')) return true;
    if (document.querySelector('input[name="id"]') &&
        (document.querySelector('[type="submit"][name="add"]') ||
         document.querySelector('[data-product-form]'))) return true;

    if (document.querySelector("form.cart") ||
        document.querySelector("button.single_add_to_cart_button") ||
        document.querySelector('[name="add-to-cart"]')) return true;

    if (document.querySelector('form[action*="/cart.php"]') ||
        document.querySelector('#form-action-addToCart') ||
        document.querySelector('[data-button-state][data-add-to-cart]')) return true;

    if (document.querySelector('form#product_addtocart_form') ||
        document.querySelector('#product-addtocart-button') ||
        document.querySelector('[data-role="tocart"]')) return true;

    if (document.querySelector('form[name="add-to-cart"]') ||
        document.querySelector('[data-action="add-to-cart"]') ||
        document.querySelector('button.add-to-cart') ||
        document.querySelector('form[action*="Cart-AddProduct"]') ||
        document.querySelector('form[id*="addtocart"]') ||
        document.querySelector('input[name="pid"]')) return true;

    if (document.querySelector('[data-button-action="add-to-cart"]')) return true;

    if (document.querySelector('.sqs-add-to-cart-button') ||
        document.querySelector('.ProductItem-addToCart')) return true;

    if (document.querySelector('button[data-hook="add-to-cart"]')) return true;

    // Visual checks
    if (!document.querySelector("h1")) return false;
    const hasPrice = Array.from(document.querySelectorAll("span,div,p,strong,b"))
      .some(el => /[$€£]\s?\d/.test(el.textContent || ""));
    if (!hasPrice) return false;
    const img = document.querySelector("picture img, img");
    const src = img?.getAttribute("src") || img?.src || "";
    if (!src || looksLikePixel(src)) return false;

    // URL checks; skip strictness for allowed off-PDP hosts
    const path = location.pathname.toLowerCase();
    const isProductPath =
      /\/products?\//.test(path) ||
      /\/product\//.test(path)  ||
      /\/p\//.test(path)        ||
      /\/dp\//.test(path)       ||
      /\/(item|items|sku|prod|goods|shop)\//.test(path) ||
      /-p\d+(?:\.html|$)/.test(path);
    if (!isProductPath && !ALLOW_OFF_PDP_HOSTS.test(HOST)) {
      if (/(^|\/)(cart|checkout|shopping-?bag)(\/|$)/.test(path)) return false;
      if (/(^|\/)(wishlist|account|login|register)(\/|$)/.test(path)) return false;
      if (/(^|\/)(collection|collections|category|categories|catalog)(\/|$)/.test(path)) return false;
    }
    return true;
  }

  // ---------- field extractors ----------
  function extractTitle() {
    const og = attr('meta[property="og:title"]','content'); if (og) return og;
    const ld = parseLD(); if (ld?.name) return String(ld.name);
    const sj = parseShopifyProductJSON(); if (sj?.title) return String(sj.title);
    const mn = txt('[itemprop="name"]'); if (mn) return mn;
    return txt("h1") || document.title;
  }
  function extractBrand() {
    const ld = parseLD(); if (ld?.brand) return typeof ld.brand === "string" ? ld.brand : (ld.brand.name || "");
    const ogSite = attr('meta[property="og:site_name"]','content') || ""; if (ogSite) return ogSite;
    const sj = parseShopifyProductJSON(); if (sj?.vendor) return String(sj.vendor);
    return location.hostname.replace(/^www\./, "");
  }
  function extractImage() {
    const og = attr('meta[property="og:image"]','content') ||
               attr('meta[property="og:image:secure_url"]','content');
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
    const mi = microImage(); if (mi && !looksLikePixel(mi)) return mi;

    const imgEl = document.querySelector("picture img") || document.querySelector("img");
    if (imgEl) {
      const ss  = imgEl.getAttribute("srcset");
      const best= pickBestFromSrcset(ss);
      const src = absUrl(imgEl.getAttribute("src") || imgEl.src || "");
      if (best && !looksLikePixel(best)) return best;
      if (src  && !looksLikePixel(src))  return src;
    }
    const source = document.querySelector("picture source[srcset]");
    if (source) {
      const ss2 = source.getAttribute("srcset");
      const best2 = pickBestFromSrcset(ss2);
      if (best2 && !looksLikePixel(best2)) return best2;
    }
    const lazyImg = document.querySelector("img[data-src], img[data-original], img[data-lazy], img[data-srcset]");
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
    const preload = Array.from(document.querySelectorAll('link[rel="preload"][as="image"]'))
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
        const tok = token(v0.price); if (tok) return tok;
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
    const cand = Array.from(document.querySelectorAll('[class*="price"], [data-testid*="price"], [itemprop*="price"], span, div'))
      .map(el => el.textContent && el.textContent.trim())
      .filter(Boolean)
      .filter(t => !/\b(per|\/)\s?(count|ct|ea|each|oz|lb|kg|ml|g)\b/i.test(t))
      .find(t => /[$€£]\s?\d/.test(t));
    return cand ? token(cand) : "";
  }

  // ---------- item builder & send ----------
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
  function sendItemSafe(item) {
    try {
      if (!chrome?.runtime?.id) { log("context invalidated — refresh page"); return; }
      chrome.runtime.sendMessage({ action: "ADD_ITEM", item }, () => void chrome.runtime?.lastError);
    } catch (e) { log("sendMessage exception", e); }
  }

  // ---------- dual-shot add flow ----------
  let sentQuick = false, sentSettled = false, lastKey = "", lastAt = 0;
  function debounce(k, ms) { const now = Date.now(); if (k === lastKey && now - lastAt < ms) return false; lastKey = k; lastAt = now; return true; }

  function settleThenScrape(ms = 900) {
    return new Promise((resolve) => {
      let done = false; const initial = buildItem();
      if (initial.price || initial.img) { done = true; return resolve(initial); }
      const timer = setTimeout(() => { if (!done) { done = true; obs?.disconnect?.(); resolve(buildItem()); } }, ms);
      const obs = new MutationObserver(() => {
        if (done) return;
        const item = buildItem();
        if (item.price || item.img) { clearTimeout(timer); done = true; obs.disconnect(); resolve(item); }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    });
  }

  function sendQuick() {
    if (!__UC_MODE.enabled) return;
    const allowOff = ALLOW_OFF_PDP_HOSTS.test(HOST);
    if (!allowOff && !looksLikePDP()) return;
    if (sentQuick) return;
    if (!debounce(location.href, 200)) return;
    const item = buildItem();
    if (!item.title) return;
    log("ADD_ITEM quick", item);
    sendItemSafe(item);
    sentQuick = true;
  }

  async function sendSettled() {
    if (!__UC_MODE.enabled) return;
    const allowOff = ALLOW_OFF_PDP_HOSTS.test(HOST);
    if (!allowOff && !looksLikePDP()) return;
    if (sentSettled) return;
    const item = await settleThenScrape();
    if (!item.title) return;
    log("ADD_ITEM settled", item);
    sendItemSafe(item);
    sentSettled = true;
  }

  async function sendSettledForced() {
    if (!__UC_MODE.enabled) return;
    if (sentSettled) return;
    const item = await settleThenScrape();
    if (!item.title) return;
    log("ADD_ITEM settled (forced)", item);
    sendItemSafe(item);
    sentSettled = true;
  }

  // ---------- cart/bag count watcher (covers off-PDP tile adds) ----------
  let CART_COUNT_SNAPSHOT = null;
  function readCartLikeCount() {
    const selectors = [
      '[data-testid*="cart"]','[data-test*="cart"]','[aria-label*="cart"]','[id*="cart"]','[class*="cart"]',
      '[data-testid*="bag"]','[data-test*="bag"]','[aria-label*="bag"]','[id*="bag"]','[class*="bag"]',
      '[data-testid*="basket"]','[data-test*="basket"]','[aria-label*="basket"]','[id*="basket"]','[class*="basket"]'
    ].join(',');
    const nodes = $$(selectors);
    let best = null;
    for (const el of nodes) {
      const s = ((el.getAttribute?.("aria-label") || "") + " " + (el.textContent || "")).trim();
      const m = s.match(/(\d{1,3})/g);
      if (m && m.length) {
        const n = parseInt(m[m.length - 1], 10);
        if (Number.isFinite(n)) best = Math.max(best ?? 0, n);
      }
    }
    return best;
  }
  function watchForCartIncrement(windowMs = 2500, pollMs = 150) {
    const startCount = readCartLikeCount();
    const start = Date.now();
    if (CART_COUNT_SNAPSHOT == null && startCount != null) CART_COUNT_SNAPSHOT = startCount;

    const timer = setInterval(() => {
      const now = Date.now();
      const cur = readCartLikeCount();
      if (cur != null && (CART_COUNT_SNAPSHOT == null || cur > CART_COUNT_SNAPSHOT || (startCount != null && cur > startCount))) {
        CART_COUNT_SNAPSHOT = cur;
        clearInterval(timer);
        sendSettledForced();
      } else if (now - start > windowMs) {
        clearInterval(timer);
      }
    }, pollMs);
  }

  // ---------- add/buy button detection ----------
  const BUTTONISH_SEL = [
    "button",'input[type="submit"]','input[type="button"]',
    "[role='button']","a[role='button']",
    "[data-action='add-to-cart']","[data-button-action='add-to-cart']",
    "[data-add-to-cart]","[data-hook='add-to-cart']",
    "#product-addtocart-button","[data-role='tocart']",
    "[name='add']","#add-to-bag","#add-to-cart",
    "[data-testid*='add']","[data-test*='add']","[data-qa*='add']"
  ].join(",");
  const POS = /\badd(?:ing)?(?:\s+to)?\s+(?:shopping\s+)?(?:bag|cart)\b|\bbuy now\b|\bpurchase\b/i;
  const NEG = /\b(add to wish|wishlist|favorites|list|registry|address|payment|card|newsletter)\b/i;

  function isVariantUI(node) {
    if (!node || node.nodeType !== 1) return false;
    const tag  = node.tagName;
    if (tag === "SELECT" || tag === "OPTION") return true;

    const role = String(node.getAttribute?.("role") || "").toLowerCase();
    if (role === "listbox" || role === "option" || role === "radiogroup" || role === "radio") return true;

    const cls  = String(node.className || "").toLowerCase();
    const name = String(node.getAttribute?.("name") || "").toLowerCase();
    const id   = String(node.id || "").toLowerCase();
    const dti  = String(node.getAttribute?.("data-testid") || "").toLowerCase();
    const dha  = String(node.getAttribute?.("data-action") || "").toLowerCase();

    if (/\b(size|sizes|swatch|variant|variation|colour|color|fit)\b/.test(cls)) return true;
    if (/\b(size|variant|swatch|colour|color|fit)\b/.test(name)) return true;
    if (/\b(size|variant|swatch|colour|color|fit)\b/.test(id)) return true;
    if (/^dwvar_/.test(name) || /^dwopt/.test(name)) return true;
    if (/attribute|option|selector/.test(cls) && /size|color|colour/.test(cls)) return true;
    if (/select/.test(dha) && /variant|size|color|colour/.test(dha)) return true;
    if (/size/.test(dti) && /(option|selector|swatch)/.test(dti)) return true;

    for (const a of Array.from(node.attributes || [])) {
      const an = String(a.name).toLowerCase();
      const av = String(a.value).toLowerCase();
      if (an.startsWith("data-") &&
          (/(size|variant|swatch|option|attribute|color|colour)/.test(an) ||
           /(size|variant|swatch|option|attribute|color|colour)/.test(av))) {
        return true;
      }
    }
    return false;
  }

  function looksLikeAdd(el) {
    if (!el || el.nodeType !== 1) return false;
    const s = [
      el.innerText || el.textContent || "",
      el.getAttribute?.("aria-label") || "",
      el.getAttribute?.("data-testid") || "",
      el.id || "",
      el.getAttribute?.("name") || "",
      el.getAttribute?.("class") || "",
      el.getAttribute?.("data-action") || "",
      el.getAttribute?.("data-hook") || "",
      el.getAttribute?.("data-role") || ""
    ].join(" ").toLowerCase();

    if (s.includes("adding")) return false;
    if (NEG.test(s)) return false;
    if (POS.test(s)) return true;

    if (/\badd-to-cart\b|\bproduct-form__submit\b|\bshopify-payment-button\b/.test(s)) return true;
    if (/\bsingle_add_to_cart_button\b|\badd_to_cart_button\b|\bwoocommerce\b/.test(s)) return true;
    if (/\bform-action-addToCart\b|\bdata-add-to-cart\b/.test(s)) return true;
    if (/\bproduct-addtocart-button\b|\btocart\b/.test(s)) return true;
    if (/\badd-to-cart\b/.test(s) || /cart-addproduct/.test(s) || /\bpid\b/.test(s)) return true;
    if (/\bsqs-add-to-cart-button\b|\bProductItem-addToCart\b/.test(s)) return true;
    if (/\badd-to-cart\b/.test(el.getAttribute?.("data-hook") || "")) return true;
    return false;
  }

  function closestActionEl(start) {
    let el = start && start.nodeType === 1 ? start : start?.parentElement || null;
    for (let i = 0; i < 10 && el; i++) {
      if (isVariantUI(el)) return null;
      if (el.matches?.(BUTTONISH_SEL) || looksLikeAdd(el)) {
        const disabled = el.hasAttribute?.("disabled") ||
          String(el.getAttribute?.("aria-disabled") || "").toLowerCase() === "true";
        if (!disabled) return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function isAddClick(evt) {
    if (evt.type === "click" && evt.button !== 0) return false;
    if (evt.type === "keydown" && evt.key !== "Enter" && evt.key !== " ") return false;
    const actionEl = closestActionEl(evt.target);
    return !!actionEl && looksLikeAdd(actionEl);
  }

  // ---------- in-page network hook (page context) ----------
function injectInpageHook() {
  // Only on hosts we trust for off-PDP adds (uniqlo/zara/mango/ebay)
  if (!ALLOW_OFF_PDP_HOSTS.test(HOST)) return;

  // Ask the service worker to inject our inpage hook into MAIN world.
  try {
    chrome.runtime.sendMessage({ action: "INJECT_INPAGE_HOOK" }, (res) => {
      if (chrome.runtime.lastError) {
        log("executeScript messaging error; falling back to <script src>", chrome.runtime.lastError.message);
        return fallbackTag();
      }
      if (res && res.ok) {
        log("in-page hook injected via chrome.scripting.executeScript");
      } else {
        log("executeScript returned non-ok; falling back to <script src>", res?.error);
        fallbackTag();
      }
    });
  } catch (e) {
    log("executeScript call threw; falling back to <script src>", e);
    fallbackTag();
  }

  // Fallback: add a non-inline <script src="chrome-extension://...">.
  // This will work on sites that allow the extension scheme in their CSP.
  function fallbackTag() {
    try {
      const url = chrome.runtime.getURL("Inpage/pageHook.inpage.js");
      const s = document.createElement("script");
      s.src = url;
      s.async = false;
      (document.documentElement || document.head || document.body).appendChild(s);
      // don't remove immediately; let it load
      log("in-page hook injected via <script src>");
    } catch (err) {
      log("in-page hook fallback failed", err);
    }
  }
}

  window.addEventListener("message", (e) => {
    try {
      if (!e || !e.data || e.source !== window) return;
      if (e.data.__UC_ADD_HIT) {
        log("in-page add hit", e.data.url);
        // On off-PDP hosts (UNIQLO etc), force a settled scrape.
        setTimeout(sendSettledForced, 150);
      }
    } catch {}
  });

  // ---------- message nudges from background ----------
  function handleNudge(msg) {
    if (!__UC_MODE.enabled) return;

    const isAddTrig     = msg?.action === "ADD_TRIGGERED";
    const isBroadcast   = msg?.action === "ADD_TRIGGERED_BROADCAST";
    const isSfccNudge   = msg?.action === "SFCC_NETWORK_NUDGE";
    if (!isAddTrig && !isBroadcast && !isSfccNudge) return;

    if (isBroadcast) {
      const mhost = String(msg.host || "").toLowerCase();
      if (mhost === "zara" && !/(\.|^)zara\.(com|net)$/.test(HOST)) return;
      if (mhost === "mango" && !/(\.|^)mango\.com$/.test(HOST) && !/(\.|^)shop\.mango\.com$/.test(HOST)) return;
    }

    if (IS_AMAZON && !amzClickedRecently()) {
      log("ignore nudge (amazon, no recent add click)");
      return;
    }

    setTimeout(() => {
      const allowOff = ALLOW_OFF_PDP_HOSTS.test(HOST);
      if (allowOff && !looksLikePDP()) sendSettledForced();
      else sendSettled();
    }, 200);
  }

  // ---------- wire/unwire ----------
  function handleClick(e) {
    if (!__UC_MODE.enabled) return;
    if (ALLOW_OFF_PDP_HOSTS.test(HOST)) watchForCartIncrement(); // observe badge on any click
    if (DISABLE_QUICK_HOSTS.test(HOST)) return;
    if (isAddClick(e)) sendQuick();
  }

  function handleAfter() {
    if (!__UC_MODE.enabled) return;
    if (ALLOW_OFF_PDP_HOSTS.test(HOST)) watchForCartIncrement();
  }

  function wireAll() {
    if (STATE.wired) return;
    on(document, "click", handleClick, true);
    for (const t of ["click", "submit", "pointerup", "touchend", "keydown"]) on(document, t, handleAfter, true);
    try { chrome.runtime?.onMessage?.addListener?.(handleNudge); } catch {}
    STATE.wired = true;
    log("wired (shopping mode ON)");
  }

  function unwireAll() {
    if (!STATE.wired) return;
    offAll();
    try { chrome.runtime?.onMessage?.removeListener?.(handleNudge); } catch {}
    resetFlags();
    STATE.wired = false;
    log("unwired (shopping mode OFF)");
  }

  // ---------- SPA URL change watcher ----------
  let lastHref = location.href;
  function resetFlags() { sentQuick = false; sentSettled = false; lastKey = ""; lastAt = 0; }
  function onUrlMaybeChanged() { if (location.href !== lastHref) { lastHref = location.href; resetFlags(); } }
  (function watchUrlChanges() {
    const _ps = history.pushState, _rs = history.replaceState;
    history.pushState = function (...a) { const r = _ps.apply(this, a); onUrlMaybeChanged(); return r; };
    history.replaceState = function (...a) { const r = _rs.apply(this, a); onUrlMaybeChanged(); return r; };
    window.addEventListener("popstate", onUrlMaybeChanged);
    window.addEventListener("hashchange", onUrlMaybeChanged);
    setInterval(onUrlMaybeChanged, 1000);
  })();

  // ---------- shopping mode toggle ----------
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

  // Inject page-context network hooks early for UNIQLO/Zara/Mango/eBay
  injectInpageHook();

  // ---------- Debug helpers ----------
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
  window.__UC_FORCE_ADD = () => setTimeout(() => {
    if (ALLOW_OFF_PDP_HOSTS.test(HOST) && !looksLikePDP()) sendSettledForced(); else sendSettled();
  }, 200);
  window.__UC_CART_COUNT = readCartLikeCount;

  // Initial wire (if storage hasn't toggled it off yet)
  if (__UC_MODE.enabled && !STATE.wired) wireAll();
  log("loaded", { href: location.href, pdp: looksLikePDP(), host: HOST });
})();