// content-scripts/dwrAddListener.js
// SFCC (Design Within Reach) site helper with tight PDP gate + safe UI fallback.
// - Only fires on actual Add to Cart submits/clicks.
// - Avoids false positives (headers, variant picks, etc.).
// - Reuses strong field extractors (esp. image).

(() => {
  // Only run in the top frame
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-DWR]", ...a);
  const HAS_EXT = !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);

  // ---------- tiny helpers ----------
  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const txt  = (s) => ($(s)?.textContent || "").trim();
  const attr = (s,n) => $(s)?.getAttribute(n) || "";
  const abs  = (u) => { try { return new URL(u, location.href).toString(); } catch { return u || ""; } };
  const token= (s) => (String(s).match(/[$€£]\s?\d[\d.,]+/) || [""])[0];

  const looksPixel = (u="") => {
    const x = String(u).toLowerCase();
    return !x || x.startsWith("data:") || x.endsWith(".svg") || /pixel|1x1|spacer|beacon/.test(x);
  };
  const pickBestFromSrcset = (ss) => {
    if (!ss) return "";
    try {
      return ss
        .split(",")
        .map(s => s.trim())
        .map(p => {
          const [url, w] = p.split(/\s+/);
          const width = parseInt((w || "").replace(/\D/g, ""), 10) || 0;
          return { url: abs(url), width };
        })
        .sort((a,b) => b.width - a.width)[0]?.url || "";
    } catch { return ""; }
  };

  // ---------- JSON-LD ----------
  const normT = (t) => (Array.isArray(t) ? t : (t ? [t] : [])).map(v => String(v).toLowerCase());
  function findProductNode(node) {
    try {
      if (!node || typeof node !== "object") return null;
      if (normT(node["@type"]).includes("product")) return node;
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

  // ---------- PDP guard (strict) ----------
  function isPDP() {
    // Avoid obvious non-PDP routes
    const path = (location.pathname || "").toLowerCase();
    if (/(^|\/)(cart|checkout|shopping-?bag|wishlist|account|login|register|search)(\/|$)/.test(path)) return false;

    // og:type=product
    const ogType = (attr('meta[property="og:type"]','content') || "").toLowerCase();
    if (ogType === "product") return true;

    // JSON-LD Product present
    if (parseLD()) return true;

    // Common SFCC PDP path fragments
    // e.g. /product/..., /p/..., /prod/..., /sku/..., /pid/..., /item/...
    if (/\/(product|p|prod|sku|pid|item)\//i.test(path)) return true;

    return false;
  }

  // ---------- field extractors ----------
  function extractTitle() {
    const ld = parseLD();
    if (ld?.name) return String(ld.name);
    return attr('meta[property="og:title"]','content') || txt("h1") || document.title || "";
  }

  function extractBrand() {
    const ld = parseLD();
    if (ld?.brand) return typeof ld.brand === "string" ? ld.brand : (ld.brand.name || "");
    const ogSite = attr('meta[property="og:site_name"]','content') || "";
    return ogSite || "Design Within Reach";
  }

  function extractImage() {
    // 1) OG image
    const og = attr('meta[property="og:image"]','content') || attr('meta[property="og:image:secure_url"]','content');
    if (og && !looksPixel(og)) return abs(og);

    // 2) Current hero (picture/srcset preferred)
    const hero = $("picture img") || $("img");
    if (hero) {
      const best = pickBestFromSrcset(hero.getAttribute("srcset"));
      const src  = abs(hero.currentSrc || hero.getAttribute("src") || hero.src || "");
      if (best && !looksPixel(best)) return best;
      if (src && !looksPixel(src)) return src;
    }

    // 3) Largest visible image (good for SFCC galleries)
    let best = ""; let bestArea = 0;
    for (const img of Array.from(document.images)) {
      try {
        const rect = img.getBoundingClientRect();
        if (rect.width < 250 || rect.height < 250) continue; // ignore icons/thumbs
        let u = img.currentSrc || img.src || img.getAttribute("src") || "";
        if (!u) {
          const ss = img.getAttribute("srcset");
          if (ss) u = pickBestFromSrcset(ss);
        }
        if (!u || looksPixel(u)) continue;
        const area = rect.width * rect.height;
        if (area > bestArea) { bestArea = area; best = abs(u); }
      } catch {}
    }
    if (best) return best;

    // 4) Preload hints
    const preload = $$('link[rel="preload"][as="image"]')
      .map(l => abs(l.getAttribute("href") || l.href))
      .find(h => h && !looksPixel(h));
    if (preload) return preload;

    // 5) Twitter card
    const tw = attr('meta[name="twitter:image"]','content');
    if (tw && !looksPixel(tw)) return abs(tw);

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
    const mp = attr('meta[itemprop="price"]','content') ||
               attr('meta[property="product:price:amount"]','content') ||
               attr('meta[property="og:price:amount"]','content');
    if (mp) {
      const n = Number(mp);
      return Number.isFinite(n) ? `$ ${n.toFixed(2)}` : token(mp);
    }
    const cand = $$('[class*="price"], [data-testid*="price"], span, div')
      .map(el => el.textContent && el.textContent.trim())
      .filter(Boolean)
      .find(t => /[$€£]\s?\d/.test(t));
    return cand ? token(cand) : "";
  }

  // ---------- item + messaging ----------
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
    if (!HAS_EXT) return;
    try {
      chrome.runtime.sendMessage({ action: "ADD_ITEM", item }, () => void chrome.runtime?.lastError);
    } catch {}
  }

  // Debounce duplicates (per page)
  let lastSentKey = "";
  let lastSentAt  = 0;
  const DEDUPE_MS = 900;
  function shouldSend(key) {
    const t = Date.now();
    if (key === lastSentKey && t - lastSentAt < DEDUPE_MS) return false;
    lastSentKey = key; lastSentAt = t; return true;
  }

  // Wait a moment for DOM to settle (price/image swap after click/submit)
  function settleThenScrape(ms = 800) {
    return new Promise((resolve) => {
      let done = false;
      const initial = buildItem();
      if ((initial.price && initial.img) || initial.title) {
        // if it already looks good, still wait briefly for potential upgrades
      }
      const timer = setTimeout(() => {
        if (!done) { done = true; obs?.disconnect?.(); resolve(buildItem()); }
      }, ms);
      const obs = new MutationObserver(() => {
        if (done) return;
        const item = buildItem();
        if ((item.price && item.img) || item.title) {
          clearTimeout(timer);
          done = true; obs.disconnect();
          resolve(item);
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    });
  }

  async function sendQuickThenSettled() {
    if (!isPDP()) return;
    const quick = buildItem();
    if (!quick.title) return;
    const key = (quick.id || quick.link || location.href);
    if (!shouldSend(key)) return;

    // quick optimistic
    log("ADD_ITEM quick", quick);
    sendItemSafe(quick);

    // settled
    try {
      const settled = await settleThenScrape(900);
      if (settled && settled.title) {
        log("ADD_ITEM settled", settled);
        sendItemSafe(settled);
      }
    } catch {}
  }

  // ---------- UI fallback (tight) ----------
  // Known SFCC/DWR selectors
  const ADD_SELECTORS = [
    'form[action*="Cart-AddProduct"] button[type="submit"]',
    'button[name="addToCart"]',
    'button#add-to-cart',
    '[data-action="add-to-cart"]'
  ].join(',');

  // Primary signal: Cart-AddProduct form submit
  document.addEventListener("submit", (e) => {
    try {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      const action = (form.getAttribute("action") || "").toLowerCase();
      if (!/cart-?addproduct|add-?to-?cart/.test(action)) return;
      if (!isPDP()) return;
      sendQuickThenSettled();
    } catch {}
  }, true);

  // Backup: explicit click on known add buttons
  document.addEventListener("click", (e) => {
    const btn = e.target && (e.target.closest?.(ADD_SELECTORS));
    if (!btn) return;
    if (!isPDP()) return;
    if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return;
    sendQuickThenSettled();
  }, true);

  log("loaded", { href: location.href, isPDP: isPDP() });
})();