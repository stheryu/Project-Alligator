// content-scripts/genericAddListener.js
(() => {
  if (window.top !== window) return;
  if (window.__UC_GENERIC_INJECTED__) return;
  window.__UC_GENERIC_INJECTED__ = true;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Generic]", ...a);

  const HOST       = location.hostname.toLowerCase();
  const IS_GILT    = /(\.|^)(gilt|ruelala)\.com$/i.test(HOST);
  const IS_ZARA    = /(\.|^)zara\.(com|net)$/i.test(HOST);
  const IS_NIKE    = /(\.|^)nike\.com$/i.test(HOST);
  const IS_AMAZON  = /\bamazon\./i.test(HOST);
  const IS_UNIQLO = /(\.|^)(uniqlo|elgnisolqinu|fastretailing)\.com$/i.test(HOST);

  // “Quick” is noisy → rely on settled-only for these (add Uniqlo only)
  const DISABLE_QUICK_HOSTS =
    /(\.|^)(amazon|zara|mango|kith|theoutnet|gilt|ruelala|nike|uniqlo)\.(com|net)$/i;

  // Off-PDP legit add flows (inject in-page hook + allow settled adds)
  const ALLOW_OFF_PDP_HOSTS =
    /(\.|^)dwr\.com$|(\.|^)uniqlo\.com$|(\.|^)zara\.(com|net)$|(\.|^)mango\.com$|(\.|^)ebay\.com$|(\.|^)gilt\.com$|(\.|^)ruelala\.com$|(\.|^)brooklinen\.com$|(\.|^)mytheresa\.com$/i;

  // ---------- global state ----------
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

  // ---------- helpers ----------
  const $  = (s, root=document) => root.querySelector(s);
  const $$ = (s, root=document) => Array.from(root.querySelectorAll(s));
  const txt  = (s) => ($(s)?.textContent || "").trim();
  const attr = (s, n) => $(s)?.getAttribute(n) || "";
  const first= (a) => Array.isArray(a) ? a[0] : a;

  // money: symbol OR ISO code before/after
  const TOKEN_RE = /(?:[$€£¥₹]\s?\d[\d.,]*|\b(?:USD|CAD|EUR|GBP|JPY|INR)\b\s?\d[\d.,]*|\d[\d.,]*\s?\b(?:USD|CAD|EUR|GBP|JPY|INR)\b)/i;
  const token = (s) => (String(s).match(TOKEN_RE) || [""])[0];

  const absUrl = (u) => { try { return new URL(u, location.href).toString(); } catch { return u || ""; } };
  const looksLikePixel = (u = "") => {
    const x = String(u).toLowerCase();
    return !x || x.startsWith("data:") || x.endsWith(".svg") || /pixel|1x1|spacer|beacon/.test(x);
  };
  const pickBestFromSrcset = (ss) => {
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
  };
  const centsToCurrency = (cents, cur = "USD") => {
    const n = Number(cents);
    return Number.isFinite(n) ? `${cur === "USD" ? "$" : cur} ${(n / 100).toFixed(2)}` : "";
  };

  // price sanitation + noise filters
  const CUR_NUM_RE = /([$€£¥₹])\s*([0-9][\d.,]*)|(?:\b(USD|CAD|EUR|GBP|JPY|INR)\b)\s*([0-9][\d.,]*)|([0-9][\d.,]*)\s*\b(USD|CAD|EUR|GBP|JPY|INR)\b/i;
  const BNPL_RE = /(afterpay|klarna|affirm|sezzle|quadpay|zip\s*pay|shop\s*pay|paypal\s*pay|interest[-\s]?free|installments?|installment|per\s*(month|mo\.?|payment|installment)|\b\d+\s*(x|payments?)\s*of|\bpay\s+in\s+\d+)/i;
  const MEMBERSHIP_RE = /(rue\s*now|rue\s*unlimited|gilt\s*unlimited|unlimited\s*shipping|shipping\s*pass|membership|subscribe|trial|free\s*shipping\s*(?:year|every|today)?)/i;
  const LISTISH_RE = /\b(list|msrp|compare|original|was|before|strikethrough|tachado|prix\s*barré|precio\s*tachado)\b/i;
  const CURRENTISH_RE = /\b(now|our\s*price|current|sale|today|your\s*price|price\s*(?:now|today))\b/i;

  function priceToCents(text) {
    const m = String(text || "").match(CUR_NUM_RE);
    if (!m) return null;
    const raw = m[2] || m[4] || m[5];
    const num = String(raw).replace(/[^\d.,]/g, "").replace(/[.,](?=\d{3}\b)/g, "").replace(",", ".");
    const f = parseFloat(num);
    return Number.isFinite(f) ? Math.round(f * 100) : null;
  }
  function isValidNonZeroPrice(p) {
    if (!p) return false;
    if (/free/i.test(p)) return true;
    const c = priceToCents(p);
    return c != null && c > 0;
  }
  const cleanPrice = (p) => String(p || "").replace(/[.,]\s*$/, "").trim();

  function nodeTextBag(el) {
    let cur = el, out = "";
    for (let i = 0; i < 3 && cur; i++) {
      out += " " + (cur.textContent || "") + " " + (cur.className || "") + " " + (cur.id || "");
      cur = cur.parentElement;
    }
    return out.toLowerCase();
  }
  const isBnplNode        = (el) => BNPL_RE.test(nodeTextBag(el));
  const isMembershipNode  = (el) => MEMBERSHIP_RE.test(nodeTextBag(el));
  const isListishNode     = (el) => LISTISH_RE.test(nodeTextBag(el));
  const isCurrentishNode  = (el) => CURRENTISH_RE.test(nodeTextBag(el));

  function pickBestPriceTokenFrom(nodes, { preferMin = true, minCents = 0 } = {}) {
    const pairs = [];
    for (const el of nodes) {
      if (!el) continue;
      if (isBnplNode(el) || isMembershipNode(el)) continue;
      const t = token(el.textContent || "") || token(el.getAttribute?.("content") || "");
      const cents = priceToCents(t);
      if (cents && cents > 0) {
        if (cents >= minCents) pairs.push([t, cents, el]);
      }
      // also scan attributes for embedded numbers
      for (const a of Array.from(el.attributes || [])) {
        const maybe = token(a.value || "");
        const c2 = priceToCents(maybe);
        if (c2 && c2 > 0 && c2 >= minCents) pairs.push([maybe, c2, el]);
      }
    }
    if (!pairs.length) return "";
    const currentish = pairs.filter(([, , el]) => isCurrentishNode(el) && !isListishNode(el));
    const nonList    = pairs.filter(([, , el]) => !isListishNode(el));
    const source = currentish.length ? currentish : (nonList.length ? nonList : pairs);
    source.sort((a, b) => preferMin ? (a[1] - b[1]) : (b[1] - a[1]));
    return cleanPrice(source[0][0]);
  }

  // ---------- Amazon guard ----------
  const AMZ_ADD_SELECTORS = [
    "#add-to-cart-button","#add-to-cart-button-ubb",
    'input[name="submit.add-to-cart"]','form[action*="handle-buy-box"] [type="submit"]',
    "[data-action='add-to-cart']","[aria-labelledby*='add-to-cart-button']"
  ].join(",");
  let amzLastAddClickTs = 0;
  document.addEventListener("click", (e) => {
    try {
      if (!IS_AMAZON) return;
      const btn = e.target?.closest?.(AMZ_ADD_SELECTORS);
      if (btn) amzLastAddClickTs = Date.now();
    } catch {}
  }, true);
  const amzClickedRecently = (ms = 6000) => IS_AMAZON && (Date.now() - amzLastAddClickTs) < ms;

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
        return deepFind(json);
      } catch {}
    }
    return null;
  }
  const microName = () => txt('[itemprop="name"]') || "";
  function microPrice() {
    const el = document.querySelector('[itemprop="price"]');
    if (!el) return "";
    const c = el.getAttribute("content");
    if (c) {
      const n = Number(c);
      if (Number.isFinite(n) && n > 0) return `$ ${n.toFixed(2)}`;
    }
    const tok = token(el.textContent || "");
    return isValidNonZeroPrice(tok) ? cleanPrice(tok) : "";
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

    const formish =
      document.querySelector('form[action*="/cart/add"]') ||
      document.querySelector('[name="add"]') ||
      document.querySelector('[data-add-to-cart]') ||
      document.querySelector('input[name="id"]');
    if (formish) return true;

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

    // visual checks
    if (!document.querySelector("h1")) return false;
    const hasPrice = Array.from(document.querySelectorAll("span,div,p,strong,b"))
      .some(el => TOKEN_RE.test(el.textContent || ""));
    if (!hasPrice) return false;

    const img = document.querySelector("picture img, img");
    const src = img?.getAttribute("src") || img?.src || "";
    if (!src || looksLikePixel(src)) return false;

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

    const mi = microImage();
    if (mi && !looksLikePixel(mi)) return mi;

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

    // CSS background-image fallback
    {
      const cands = document.querySelectorAll('.pdp, .product, .gallery, .media, [class*="image"], [class*="media"]');
      for (const el of cands) {
        const bg = getComputedStyle(el).backgroundImage || "";
        const m = bg && bg.match(/url\((["']?)(.*?)\1\)/);
        if (m && m[2] && !looksLikePixel(m[2])) {
          const u = absUrl(m[2]);
          if (u) return u;
        }
      }
    }

    const tw = attr('meta[name="twitter:image"]','content');
    if (tw && !looksLikePixel(tw)) return absUrl(tw);

    return "";
  }

  // --- Gilt/Rue: membership-safe, list-avoiding, “current” price ---
  function extractPriceGiltRue() {
    const MAIN = $("main") || $("article") || document.body;

    const aria = $('div[aria-label*="current price" i], [aria-label*="our price" i], [aria-label*="now price" i]', MAIN);
    if (aria && !isMembershipNode(aria) && !isBnplNode(aria)) {
      const t = token(aria.getAttribute("aria-label") || "");
      if (isValidNonZeroPrice(t)) return cleanPrice(t);
    }

    const strongSel = [
      '.product-detail__price .bfx-price',
      '.product-detail__list-price .bfx-price',
      '.product-detail__list-price',
      '.price--sale, .sale, .sale-price, .now, .priceNow, .price__current',
      '[data-testid*="price-now"]','[data-test*="price-now"]',
      '[data-testid*="sale"]','[data-test*="sale"]'
    ];
    const strong = pickBestPriceTokenFrom(strongSel.map(s => $(s, MAIN)), { preferMin:true, minCents:1500 });
    if (isValidNonZeroPrice(strong)) return cleanPrice(strong);

    const sr = Array.from($$('.screen-reader-only', MAIN)).find(el => /\bour price\b/i.test(el.textContent || ""));
    if (sr) {
      const scope = sr.parentElement || sr.closest("div,section,article,form") || MAIN;
      const near = $$("span,div,b,strong,p", scope).filter(el => !isBnplNode(el) && !isMembershipNode(el));
      const best = pickBestPriceTokenFrom(near, { preferMin:true, minCents:1500 });
      if (isValidNonZeroPrice(best)) return cleanPrice(best);
    }

    const addBtn = $([
      "[data-test*='add']","[data-testid*='add']","[data-qa*='add']",
      "[data-action='add-to-cart']","[data-hook='add-to-cart']","#add-to-bag","#add-to-cart",
      "button.add-to-cart","#product-addtocart-button","[data-role='tocart']"
    ].join(","), MAIN);
    if (addBtn) {
      const scope = addBtn.closest("section,article,form,div") || MAIN;
      const nodes = $$("[class*='price'],[data-test*='price'],[data-testid*='price'],span,div,b,strong,p", scope)
        .filter(el => !isBnplNode(el) && !isMembershipNode(el));
      const best = pickBestPriceTokenFrom(nodes, { preferMin:true, minCents:1500 });
      if (isValidNonZeroPrice(best)) return cleanPrice(best);
    }

    return "";
  }

  // ---------- price extractor ----------
  function extractPrice() {
    if (IS_GILT) {
      const gp = extractPriceGiltRue();
      if (isValidNonZeroPrice(gp)) return gp;
    }

    const MAIN = $("main") || $("article") || document.body;

    // 1) Nike
    if (IS_NIKE) {
      const aria = $('div[aria-label*="current price" i]', MAIN)?.getAttribute("aria-label") || "";
      const ariaTok = token(aria);
      if (isValidNonZeroPrice(ariaTok)) return cleanPrice(ariaTok);
      const nikeCur = [
        '[data-testid="currentPrice-container"]','#price-container [data-testid="currentPrice-container"]',
        '[data-qa*="current-price"]','[data-test="product-price"]',
        '.is--current-price, .current-price, .product-price.is--current-price',
        '[data-testid*="price-current"]','[data-testid*="pdp-product-price"]'
      ].map(sel => $(sel, MAIN)).find(Boolean);
      if (nikeCur && !isBnplNode(nikeCur)) {
        const t = token(nikeCur.textContent || nikeCur.getAttribute?.("content") || "");
        if (isValidNonZeroPrice(t)) return cleanPrice(t);
      }
    }

    // 1b) Zara: favor selected size in action sheet if open
    if (IS_ZARA) {
      const sheet = $('.zds-action-sheet-swipeable-container--open', MAIN) || $('.zds-action-sheet-swipeable-container[aria-modal="true"]', MAIN);
      if (sheet) {
        const selectedRow =
          sheet.querySelector('.size-selector-sizes-size--selected, [aria-pressed="true"], [aria-checked="true"], .is-selected, .selected') ||
          sheet.querySelector('.size-selector-sizes__size');
        const priceNode =
          selectedRow?.querySelector('[data-qa-id="price-container-current"] .money-amount__main, .price-current__amount .money-amount__main, .price-current .money-amount__main, .price__amount .money-amount__main, .price-current__amount, .price__amount, .money-amount__main');
        if (priceNode) {
          const t = token(priceNode.textContent || "");
          if (isValidNonZeroPrice(t)) return cleanPrice(t);
        }
      }
      const micro = $('[itemprop="price"]', MAIN);
      if (micro) {
        const c = micro.getAttribute("content");
        if (c) { const n = Number(c); if (Number.isFinite(n) && n > 0) return `$ ${n.toFixed(2)}`; }
        const t = token(micro.textContent || "");
        if (isValidNonZeroPrice(t)) return cleanPrice(t);
      }
      const zEl = [
        '.current-price, .price__current, .price-current',
        '[data-qa*="current-price"]','[data-testid*="price-now"]','[aria-label*="current price" i]'
      ].map(sel => $(sel, MAIN)).find(Boolean);
      if (zEl && !isBnplNode(zEl)) {
        const t = token(zEl.textContent || zEl.getAttribute?.("content") || "");
        if (isValidNonZeroPrice(t)) return cleanPrice(t);
      }
    }

    // 2) Structured data
    const ld = parseLD();
    if (ld?.offers) {
      const offers = Array.isArray(ld.offers) ? ld.offers : [ld.offers];
      for (const o of offers) {
        const p = o.price || o.lowPrice || o.highPrice || o?.priceSpecification?.price;
        if (p != null && p !== "") {
          const n = Number(p);
          const cur = o.priceCurrency || "USD";
          if (Number.isFinite(n) && n > 0) return `${cur === "USD" ? "$" : cur} ${n.toFixed(2)}`;
          const tok = token(String(p));
          if (isValidNonZeroPrice(tok)) return cleanPrice(tok);
        }
      }
    }

    // 3) Shopify JSON
    const sj = parseShopifyProductJSON();
    if (sj?.variants?.length) {
      const chosen = sj.variants.find(v => v.available && (v.featured || v.selected)) || sj.variants[0];
      if (chosen) {
        if (typeof chosen.price === "number" && chosen.price > 0) return centsToCurrency(chosen.price, sj.currency || "USD");
        if (typeof chosen.price === "string") {
          const n = Number(chosen.price); if (Number.isFinite(n) && n > 0) return `$ ${n.toFixed(2)}`;
          const tok = token(chosen.price); if (isValidNonZeroPrice(tok)) return cleanPrice(tok);
        }
        if (typeof chosen.compare_at_price === "number" && chosen.compare_at_price > 0) return centsToCurrency(chosen.compare_at_price, sj.currency || "USD");
        if (typeof chosen.compare_at_price === "string") {
          const n2 = Number(chosen.compare_at_price); if (Number.isFinite(n2) && n2 > 0) return `$ ${n2.toFixed(2)}`;
        }
      }
    }

    // 4) Meta/micro
    const mp = microPrice() ||
               attr('meta[itemprop="price"]','content') ||
               attr('meta[property="product:price:amount"]','content') ||
               attr('meta[property="og:price:amount"]','content') ||
               attr('meta[name="twitter:data1"]','content');
    if (mp) {
      const n = Number(mp);
      if (Number.isFinite(n) && n > 0) return `$ ${n.toFixed(2)}`;
      const tok = token(mp);
      if (isValidNonZeroPrice(tok)) return cleanPrice(tok);
    }

    // 5) Scoped DOM heuristics near title / add button
    const MAIN2 = MAIN;
    const titleEl = $("h1,[itemprop='name']", MAIN2) || MAIN2;
    const addBtn = $([
      "#add-to-cart-button","[data-action='add-to-cart']","button.add-to-cart",
      "[data-button-action='add-to-cart']","[data-add-to-cart]","[data-hook='add-to-cart']",
      "#product-addtocart-button","[data-role='tocart']","[name='add']","#add-to-bag","#add-to-cart",
      // Zara/Nike/Uniqlo/Brooklinen patterns
      "[data-qa*='add-to-cart']","[data-qa*='addToCart']","[data-testid*='add-to-cart']",
      "[data-test*='add-to-cart']","[data-cy*='add-to-cart']",
      ".AddToCart__Button",".pdp-add-to-cart",
      "[aria-label*='add to cart' i]","[aria-label*='add to bag' i]"
    ].join(","), MAIN2);
    const scopes = [
      titleEl.closest("section, article, main, div, form") || MAIN2,
      addBtn?.closest?.("section, article, main, div, form") || null
    ].filter(Boolean);
    for (const scope of scopes) {
      const nodes = $$(
        '[data-testid*="price"],[data-test*="price"],[class*="price"],[id*="price"],.price,.product-price,.pdp-price,.sale-price,.member-price,span,div,b,strong,p',
        scope
      ).filter(el => !isBnplNode(el) && !isMembershipNode(el));
      const best = pickBestPriceTokenFrom(nodes, { preferMin: IS_ZARA || IS_NIKE, minCents: IS_GILT ? 1500 : 0 });
      if (isValidNonZeroPrice(best)) return cleanPrice(best);
    }

    // 6) Whole-page fallback
    const preferMin = IS_ZARA || IS_NIKE;
    const nodes = $$(
      '[data-testid*="price"],[data-test*="price"],[itemprop*="price"],[class*="price"],[id*="price"],.price,.product-price,.pdp-price,.sale-price,.member-price,span,div,b,strong,p'
    ).filter(el => !isBnplNode(el) && !isMembershipNode(el));
    const best = pickBestPriceTokenFrom(nodes, { preferMin, minCents: IS_GILT ? 1500 : 0 });
    return isValidNonZeroPrice(best) ? cleanPrice(best) : "";
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
  const debounce = (k, ms) => { const now = Date.now(); if (k === lastKey && now - lastAt < ms) return false; lastKey = k; lastAt = now; return true; };

  function settleThenScrape(ms) {
    // UNIQLO is slow to hydrate; give it more time
    const timeout = ms ?? (IS_GILT ? 2600 : (IS_NIKE || IS_ZARA) ? 2500 : IS_UNIQLO ? 3800 : 900);
    const strictPrice = IS_GILT;
    return new Promise((resolve) => {
      let done = false;
      let obs;
      const initial = buildItem();
      const initialOk = strictPrice
        ? (isValidNonZeroPrice(initial.price) && initial.img)
        : (initial.price || initial.img);
      if (initialOk) return resolve(initial);
      const timer = setTimeout(() => { if (!done) { done = true; obs?.disconnect?.(); resolve(buildItem()); } }, timeout);
      obs = new MutationObserver(() => {
        if (done) return;
        const item = buildItem();
        const ok = strictPrice ? (isValidNonZeroPrice(item.price) && item.img) : (item.price || item.img);
        if (ok) { clearTimeout(timer); done = true; obs.disconnect(); resolve(item); }
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
    if (DISABLE_QUICK_HOSTS.test(HOST)) return; // skip quick on noisy hosts (incl. Uniqlo)
    const item = buildItem();
    if (!item.title) return;
    if (!isValidNonZeroPrice(item.price)) return;
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

  // ---------- cart/bag count + mini-cart watcher ----------
  let CART_COUNT_SNAPSHOT = null;
  function readCartLikeCount() {
    const selectors = [
      '[data-testid*="cart"]','[data-test*="cart"]','[aria-label*="cart"]','[id*="cart"]','[class*="cart"]',
      '[data-testid*="bag"]','[data-test*="bag"]','[aria-label*="bag"]','[id*="bag"]','[class*="bag"]',
      '[data-testid*="basket"]','[data-test*="basket"]','[aria-label*="basket"]','[id*="basket"]','[class*="basket"]',
      '#headerCartCount','#cart-qty','#cart-quantity',
      '[data-cart-count]','[data-qa*="cart-count"]','[class*="cart-count"]','[id*="cartCount"]','[id*="CartCount"]'
    ].join(',');
    const nodes = $$(selectors);
    let best = null;
    for (const el of nodes) {
      const s = (
        (el.getAttribute?.("data-cart-count") || "") + " " +
        (el.getAttribute?.("aria-label") || "") + " " +
        (el.textContent || "")
      ).trim();
      const m = s.match(/(\d{1,3})/g);
      if (m && m.length) {
        const n = parseInt(m[m.length - 1], 10);
        if (Number.isFinite(n)) best = Math.max(best ?? 0, n);
      }
    }
    return best;
  }
  function watchForCartIncrement(windowMs = IS_GILT ? 3500 : IS_UNIQLO ? 4000 : 2500, pollMs = 150) {
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
  function watchMiniCartOpen(windowMs = 2500) {
    const start = Date.now();
    const obs = new MutationObserver(() => {
      const panel = document.querySelector(
        '[data-qa*="mini-cart"],[data-testid*="mini-cart"],[id*="mini-cart"],[class*="mini-cart"],[class*="cart-drawer"],[data-test*="mini-cart"],[data-cy*="mini-cart"]'
      );
      if (panel && (panel.offsetParent !== null || getComputedStyle(panel).visibility !== "hidden")) {
        obs.disconnect();
        sendSettledForced();
      } else if (Date.now() - start > windowMs) {
        obs.disconnect();
      }
    });
    obs.observe(document.documentElement, { childList:true, subtree:true, attributes:true });
  }
  function watchUniqloAddedOverlay(windowMs = 5000) {
  if (!IS_UNIQLO) return;
  const start = Date.now();
  const isVisible = (el) => el && (el.offsetParent !== null || getComputedStyle(el).visibility !== "hidden");
  const hit = () => {
    const panel = document.querySelector(".fr-ec-header-overlay");
    if (panel && isVisible(panel) && /added to (cart|bag)/i.test(panel.textContent || "")) return panel;
    const h5 = document.querySelector('#Added\\ to\\ cart, [id="Added to cart"]');
    if (h5 && isVisible(h5)) return h5;
    return null;
  };

  const initial = hit();
  if (initial) { sendSettledForced(); return; }

  const obs = new MutationObserver(() => { if (hit()) { obs.disconnect(); sendSettledForced(); } });
  obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

  setTimeout(() => obs.disconnect(), windowMs);
}

  // ---------- add/buy button detection ----------
  const BUTTONISH_SEL = [
    "button",'input[type="submit"]','input[type="button"]',
    "[role='button']","a[role='button']",
    "[data-action='add-to-cart']","[data-button-action='add-to-cart']",
    "[data-add-to-cart]","[data-hook='add-to-cart']",
    "#product-addtocart-button","[data-role='tocart']",
    "[name='add']","#add-to-bag","#add-to-cart",
    "[data-testid*='add']","[data-test*='add']","[data-qa*='add']",
    // Zara/Nike/Uniqlo/Brooklinen patterns
    "[data-qa*='add-to-cart']","[data-qa*='addToCart']","[data-testid*='add-to-cart']",
    "[data-test*='add-to-cart']","[data-cy*='add-to-cart']",
    ".AddToCart__Button",".pdp-add-to-cart",
    "[aria-label*='add to cart' i]","[aria-label*='add to bag' i]"
  ].join(",");

  const POS_L10N = /(add(?:ing)?\s*(?:to)?\s*(?:shopping\s*)?(?:bag|cart)|buy\s*now|purchase|ajouter\s+au\s+panier|añadir(?:\s+al)?\s+(?:carrito|cesta)|aggiungi\s+al\s+carrello|in\s+den\s+warenkorb|カートに追加|加入(?:購物車|购物车)|장바구니에\s*담기|добавить\s+в\s+корзину)/i;
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

  function elementIsInteractive(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === "BUTTON") return true;
    if (tag === "INPUT") {
      const t = (el.getAttribute("type") || "").toLowerCase();
      return t === "submit" || t === "button";
    }
    if (tag === "A" && el.hasAttribute("href")) return true;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "button") return true;
    if (el.hasAttribute("onclick")) return true;
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
    if (POS_L10N.test(s)) return true;

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
    const startEl = start && start.nodeType === 1 ? start : start?.parentElement || null;
    if (!startEl) return null;
    if (isVariantUI(startEl)) return null; // only bail if the clicked node itself is variant UI
    let el = startEl;
    for (let i = 0; i < 20 && el; i++) {
      if ((el.matches?.(BUTTONISH_SEL) || looksLikeAdd(el)) && elementIsInteractive(el)) {
        const disabled = el.hasAttribute?.("disabled") || String(el.getAttribute?.("aria-disabled") || "").toLowerCase() === "true";
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

  // ---------- in-page network hook ----------
  function injectInpageHook() {
    if (!ALLOW_OFF_PDP_HOSTS.test(HOST)) return;
    try {
      chrome.runtime.sendMessage({ action: "INJECT_INPAGE_HOOK" }, (res) => {
        if (chrome.runtime.lastError) return fallbackTag();
        if (!(res && res.ok)) fallbackTag();
      });
    } catch { fallbackTag(); }

    function fallbackTag() {
      try {
        const url = chrome.runtime.getURL("Inpage/pageHook.inpage.js");
        const s = document.createElement("script");
        s.src = url; s.async = false;
        (document.documentElement || document.head || document.body).appendChild(s);
      } catch {}
    }
  }

  // Accept legacy __UC_ADD_HIT and newer UnifiedCartPage ADD_EVENT
  window.addEventListener("message", (e) => {
    try {
      if (!e || !e.data || e.source !== window) return;
      const d = e.data;
      if (d.__UC_ADD_HIT || (d.source === "UnifiedCartPage" && d.type === "ADD_EVENT")) {
        setTimeout(sendSettledForced, 200);
      }
    } catch {}
  });

  // ---------- message nudges ----------
  function handleNudge(msg) {
    if (!__UC_MODE.enabled) return;
    const isAddTrig   = msg?.action === "ADD_TRIGGERED";
    const isBroadcast = msg?.action === "ADD_TRIGGERED_BROADCAST";
    const isSfccNudge = msg?.action === "SFCC_NETWORK_NUDGE";
    if (!isAddTrig && !isBroadcast && !isSfccNudge) return;
    if (IS_UNIQLO) watchUniqloAddedOverlay(6000);

    if (isBroadcast) {
      const mhost = String(msg.host || "").toLowerCase();
      if (mhost === "zara"   && !/(\.|^)zara\.(com|net)$/.test(HOST)) return;
      if (mhost === "mango"  && !/(\.|^)mango\.com$/.test(HOST) && !/(\.|^)shop\.mango\.com$/.test(HOST)) return;
      if (mhost === "uniqlo" && !/(\.|^)(uniqlo|fastretailing|elgnisolqinu)\.com$/.test(HOST)) return;
      if (mhost === "gilt"   && !/(\.|^)gilt\.com$/.test(HOST)) return;
    }

    if (IS_AMAZON && !amzClickedRecently()) return;

    setTimeout(() => {
      const allowOff = ALLOW_OFF_PDP_HOSTS.test(HOST);
      if (allowOff && !looksLikePDP()) sendSettledForced();
      else sendSettled();
    }, 200);

    // UNIQLO extra retry (slow hydration, handle SPAs/drawers)
    if (IS_UNIQLO) {
      setTimeout(() => { if (!sentSettled) sendSettledForced(); }, 1800);
      setTimeout(() => { if (!sentSettled) sendSettledForced(); }, 3600);
    }
  }

  // ---------- wire/unwire ----------
  function handleClick(e) {
    if (!__UC_MODE.enabled) return;

    if (ALLOW_OFF_PDP_HOSTS.test(HOST)) {
      watchForCartIncrement();
      watchMiniCartOpen();
    if (IS_UNIQLO) 
      watchUniqloAddedOverlay(6000);
    }

    // Always follow real add-click with a settled send (even on noisy hosts)
    if (isAddClick(e)) setTimeout(sendSettled, 60);

    // Quick allowed on non-noisy hosts only
    if (!DISABLE_QUICK_HOSTS.test(HOST) && isAddClick(e)) sendQuick();
  }

  function handleAfter() {
    if (!__UC_MODE.enabled) return;
    if (ALLOW_OFF_PDP_HOSTS.test(HOST)) {
      watchForCartIncrement();
      watchMiniCartOpen();
    if (IS_UNIQLO) 
      watchUniqloAddedOverlay(6000);
    }
  }

  function wireAll() {
    if (STATE.wired) return;
    on(document, "click", handleClick, true);
    for (const t of ["click", "submit", "pointerup", "touchend", "keydown"]) on(document, t, handleAfter, true);
    try { chrome.runtime?.onMessage?.addListener?.(handleNudge); } catch {}
    STATE.wired = true;
  }

  function unwireAll() {
    if (!STATE.wired) return;
    offAll();
    try { chrome.runtime?.onMessage?.removeListener?.(handleNudge); } catch {}
    resetFlags();
    STATE.wired = false;
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

  // Inject in-page hook early for off-PDP hosts
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
    con