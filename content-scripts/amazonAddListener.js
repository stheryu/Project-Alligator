// content-scripts/amazonAddListener.js
(() => {
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Amazon]", ...a);

  // Is the extension context alive? (avoids errors after you reload the extension)
  const HAS_EXT = !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);

  // ---------- Safe send with storage fallback ----------
  function saveToStorageDirect(item) {
    if (!chrome?.storage?.sync) {
      log("storage fallback skipped: chrome.storage unavailable (context invalidated)");
      return;
    }
    try {
      chrome.storage.sync.get({ cart: [] }, (res) => {
        let items = Array.isArray(res.cart) ? res.cart : [];
        const id = String(item.id || "");
        const link = String(item.link || "");
        items = items.filter(it => String(it.id||"") !== id && String(it.link||"") !== link);
        items.push(item);
        chrome.storage.sync.set({ cart: items });
      });
    } catch (e) { log("storage fallback error:", e); }
  }

  function sendItemSafe(item) {
    if (!HAS_EXT) {
      log("sendItemSafe: extension context invalidated — refresh the page and try again.");
      return;
    }
    try {
      chrome.runtime.sendMessage({ action: "ADD_ITEM", item }, () => {
        if (chrome.runtime?.lastError) {
          log("sendMessage lastError → fallback:", chrome.runtime.lastError.message);
          saveToStorageDirect(item);
        }
      });
    } catch (e) {
      log("sendItemSafe exception → fallback:", e);
      saveToStorageDirect(item);
    }
  }

  // ---------- Helpers ----------
  const $  = (s) => document.querySelector(s);
  const txt= (s) => ($(s)?.textContent || "").trim();
  const attr=(s,n)=> $(s)?.getAttribute(n) || "";
  const token = (s) => (String(s).match(/[$€£]\s?\d[\d,]*(?:\.\d{2})?/) || [""])[0];

  function parseDynamicImageJson(s) {
    try { return JSON.parse(s); } catch { return null; }
  }
  function pickLargestFromDynamicMap(map) {
    // map is: { "url": [width, height], ... }
    if (!map || typeof map !== "object") return "";
    let best = "", bestW = 0;
    for (const [url, wh] of Object.entries(map)) {
      const w = Array.isArray(wh) ? (+wh[0] || 0) : 0;
      if (w > bestW) { bestW = w; best = url; }
    }
    return best;
  }

  function extractASIN() {
    // #ASIN input, or URL (/dp/ASIN or /gp/product/ASIN)
    const asin = $("#ASIN")?.value || "";
    if (asin) return asin;
    const m = location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    return m ? m[1] : location.href;
  }

  function extractTitle() {
    return txt("#productTitle") || attr('meta[property="og:title"]','content') || document.title;
  }

  function extractBrand() {
    // #bylineInfo often contains "Visit the XYZ Store" — trim it
    const b = txt("#bylineInfo") || txt("#brand") || "";
    return b.replace(/^Visit the\s+(.+?)\s+Store$/i, "$1").trim();
  }

  function extractImage() {
    // Strongest: #landingImage
    const img = $("#landingImage");
    if (img) {
      const old = img.getAttribute("data-old-hires");
      if (old && !/^data:|\.svg$/i.test(old)) return old;
      // dynamic map (JSON) with sizes → pick largest
      const dyn = img.getAttribute("data-a-dynamic-image");
      const map = dyn && parseDynamicImageJson(dyn);
      const best = pickLargestFromDynamicMap(map);
      if (best) return best;
      const src = img.getAttribute("src") || img.src;
      if (src) return src;
    }
    // Fallbacks: any big product image in gallery or OG image
    const og = attr('meta[property="og:image"]', 'content');
    if (og) return og;
    const gallery = document.querySelector('img[src*="images/I/"]');
    return gallery?.getAttribute("src") || gallery?.src || "";
  }

  function extractPrice() {
    // Prefer "priceToPay" (the big bold current price)
    const p1 = $("#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen")?.textContent?.trim();
    if (p1) return p1;

    // Next: apex price block
    const p2 = $("#apex_desktop .a-price .a-offscreen")?.textContent?.trim();
    if (p2) return p2;

    // Legacy blocks
    const p3 = $("#priceblock_ourprice, #priceblock_dealprice, #priceblock_saleprice")?.textContent?.trim();
    if (p3) return p3;

    // If multiple a-offscreen nodes exist, filter out per-unit and strike-through
    const candidates = Array.from(document.querySelectorAll(".a-price .a-offscreen"))
      .map(el => el.textContent?.trim())
      .filter(Boolean)
      // drop per-unit (/$, “per”, parentheses right after)
      .filter(t => !/\(\s*\$?[\d.]+\s*\/\s*(count|oz|lb|ct|unit|each)\s*\)/i.test(t));

    // Choose the one that appears inside the "apex" or "corePrice" containers first
    const apexHit = candidates.find(t => t && $("#apex_desktop .a-price .a-offscreen")?.textContent?.trim() === t);
    if (apexHit) return apexHit;

    // Otherwise take the first currency token we see
    const any = candidates.find(t => /[$€£]\s?\d/.test(t));
    return any || "";
  }

  function buildItem() {
    return {
      id: extractASIN(),
      title: extractTitle(),
      brand: extractBrand(),
      price: extractPrice(),
      img: extractImage(),
      link: location.href
    };
  }

  // ---------- Dual-shot sending (quick + settled) ----------
  let sentQuick = false, sentSettled = false;
  let lastKey = "", lastAt = 0;
  const debounce = (key, ms) => { const now = Date.now(); if (key === lastKey && now - lastAt < ms) return false; lastKey = key; lastAt = now; return true; };

  function settleThenScrape(ms = 900) {
    return new Promise((resolve) => {
      let resolved = false;
      const initial = buildItem();
      // If we already have price or image, return immediately
      if (initial.price || initial.img) { resolved = true; return resolve(initial); }
      const timer = setTimeout(() => { if (!resolved) { resolved = true; obs.disconnect(); resolve(buildItem()); } }, ms);
      const obs = new MutationObserver(() => {
        if (resolved) return;
        const item = buildItem();
        if (item.price || item.img) { clearTimeout(timer); resolved = true; obs.disconnect(); resolve(item); }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    });
  }

  function sendQuick(reason = "ui-quick") {
    if (sentQuick) return;
    const key = extractASIN();
    if (!debounce(key, 200)) return;
    const item = buildItem(); if (!item.title) return;
    log("ADD_ITEM", reason, item);
    sendItemSafe(item);
    sentQuick = true;
  }

  async function sendSettled(reason = "ui-settled") {
    if (sentSettled) return;
    const key = extractASIN();
    if (!debounce(key, 600)) { /* allow one more later */ }
    const item = await settleThenScrape(1000);
    if (!item.title) return;
    log("ADD_ITEM", reason, item);
    sendItemSafe(item);
    sentSettled = true;
  }

  // ---------- Button detection ----------
  const BUTTON_SELECTORS = [
    "#add-to-cart-button",
    "input#add-to-cart-button",
    "input[name='submit.add-to-cart']",
    "#buy-now-button",
    "input#buy-now-button",
    "input[name='submit.buy-now']",
    // Some pages render as <input class="a-button-input" ...>
    "input.a-button-input[name='submit.add-to-cart']",
    "input.a-button-input[name='submit.buy-now']"
  ];
  const ADD_TEXT_RE = /\badd to cart\b|\bbuy now\b|\badd\b(?!ing)/i;

  function nodeLooksLikeAdd(node) {
    if (!node || node.nodeType !== 1) return false;
    // Direct selector hit?
    for (const sel of BUTTON_SELECTORS) {
      if (node.matches?.(sel)) return true;
    }
    // Or text attributes
    const s = [
      node.textContent || "",
      node.getAttribute?.("aria-label") || "",
      node.getAttribute?.("id") || "",
      node.getAttribute?.("name") || "",
      node.getAttribute?.("class") || ""
    ].join(" ").toLowerCase();
    if (s.includes("adding")) return false;
    return ADD_TEXT_RE.test(s);
  }

  function findAddInPath(e) {
    const path = (e.composedPath && e.composedPath()) || [];
    for (const n of path) if (nodeLooksLikeAdd(n)) return n;
    for (const sel of BUTTON_SELECTORS) {
      const cand = document.querySelector(sel);
      if (cand && nodeLooksLikeAdd(cand)) return cand;
    }
    return null;
  }

  function early(e) { if (findAddInPath(e)) sendQuick("ui-quick"); }
  function late(e)  { if (findAddInPath(e)) setTimeout(() => sendSettled("ui-settled"), 140); }

  ["mousedown","pointerdown","touchstart"].forEach(t => document.addEventListener(t, early, true));
  ["click","pointerup","touchend","submit","keydown"].forEach(t => document.addEventListener(t, late, true));

  // Listen to webRequest assist from background (helps capture settled state)
  chrome.runtime?.onMessage?.addListener?.((msg) => {
    if (msg?.action === "ADD_TRIGGERED") setTimeout(() => sendSettled("webRequest"), 150);
  });

  // Debug helper for you
  window.__UC_AMZ_DEBUG = () => {
    const item = buildItem();
    const buttons = BUTTON_SELECTORS.map(sel => !!document.querySelector(sel));
    console.log("[UnifiedCart-Amazon] DEBUG", { item, buttons, href: location.href });
    return { item, buttons, href: location.href };
  };

  log("loaded");
})();