// content-scripts/amazonAddListener.js
(() => {
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Amazon]", ...a);

  // ---------- Safe send with storage fallback ----------
  const HAS_EXT = !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);

  function saveToStorageDirect(item) {
    if (!chrome?.storage?.sync) return;
    try {
      chrome.storage.sync.get({ cart: [] }, (res) => {
        let items = Array.isArray(res.cart) ? res.cart : [];
        const id = String(item.id || "");
        const link = String(item.link || "");
        items = items.filter(it => String(it.id||"") !== id && String(it.link||"") !== link);
        items.push(item);
        chrome.storage.sync.set({ cart: items });
      });
    } catch {}
  }

  function sendItemSafe(item) {
    if (!HAS_EXT) return;
    try {
      chrome.runtime.sendMessage({ action: "ADD_ITEM", item }, () => void chrome.runtime?.lastError);
    } catch {
      saveToStorageDirect(item);
    }
  }

  // ---------- helpers ----------
  const $   = (s) => document.querySelector(s);
  const txt = (s) => ($(s)?.textContent || "").trim();
  const attr= (s,n)=> $(s)?.getAttribute(n) || "";
  const token = (s) => (String(s).match(/[$€£]\s?\d[\d,]*(?:\.\d{2})?/) || [""])[0];

  function parseJSON(s){ try { return JSON.parse(s); } catch { return null; } }
  function pickLargestFromDynamicMap(map){
    if (!map || typeof map !== "object") return "";
    let best="", bestW=0;
    for (const [url, wh] of Object.entries(map)) {
      const w = Array.isArray(wh) ? (+wh[0] || 0) : 0;
      if (w > bestW) { bestW = w; best = url; }
    }
    return best;
  }

  function extractASIN() {
    const asin = $("#ASIN")?.value || "";
    if (asin) return asin;
    const m = location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    return m ? m[1] : location.href;
  }
  function extractTitle() {
    return txt("#productTitle") || attr('meta[property="og:title"]','content') || document.title;
  }
  function extractBrand() {
    const b = txt("#bylineInfo") || txt("#brand") || "";
    return b.replace(/^Visit the\s+(.+?)\s+Store$/i, "$1").trim();
  }
  function extractImage() {
    const img = $("#landingImage");
    if (img) {
      const old = img.getAttribute("data-old-hires");
      if (old && !/^data:|\.svg$/i.test(old)) return old;
      const dyn = img.getAttribute("data-a-dynamic-image");
      const best = pickLargestFromDynamicMap(parseJSON(dyn));
      if (best) return best;
      const src = img.getAttribute("src") || img.src;
      if (src) return src;
    }
    const og = attr('meta[property="og:image"]','content');
    if (og) return og;
    const gallery = document.querySelector('img[src*="images/I/"]');
    return gallery?.getAttribute("src") || gallery?.src || "";
  }
  function extractPrice() {
    const p1 = $("#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen")?.textContent?.trim();
    if (p1) return p1;
    const p2 = $("#apex_desktop .a-price .a-offscreen")?.textContent?.trim();
    if (p2) return p2;
    const p3 = $("#priceblock_ourprice, #priceblock_dealprice, #priceblock_saleprice")?.textContent?.trim();
    if (p3) return p3;

    const candidates = Array.from(document.querySelectorAll(".a-price .a-offscreen"))
      .map(el => el.textContent?.trim())
      .filter(Boolean)
      .filter(t => !/\(\s*\$?[\d.]+\s*\/\s*(count|oz|lb|ct|unit|each)\s*\)/i.test(t));

    const apexHit = candidates.find(t => t && $("#apex_desktop .a-price .a-offscreen")?.textContent?.trim() === t);
    if (apexHit) return apexHit;

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

  // ---------- CTA detection (no global DOM scan) ----------
  // Only treat a click/keyboard event as Add/Buy if the actual event path contains a matching node.
  const BUTTON_SELECTORS = [
    "#add-to-cart-button",
    "input#add-to-cart-button",
    "input[name='submit.add-to-cart']",
    "#buy-now-button",
    "input#buy-now-button",
    "input[name='submit.buy-now']",
    "input.a-button-input[name='submit.add-to-cart']",
    "input.a-button-input[name='submit.buy-now']"
  ].join(",");

  const ADD_TEXT_RE = /\badd to cart\b|\bbuy now\b|\badd\b(?!ing)/i;
  function nodeLooksLikeAdd(node) {
    if (!node || node.nodeType !== 1) return false;

    // direct selector match
    if (node.matches?.(BUTTON_SELECTORS)) return !isDisabled(node);

    // attribute/text hints
    const s = [
      node.textContent || "",
      node.getAttribute?.("aria-label") || "",
      node.getAttribute?.("id") || "",
      node.getAttribute?.("name") || "",
      node.getAttribute?.("class") || ""
    ].join(" ").toLowerCase();

    if (s.includes("adding")) return false;
    if (!ADD_TEXT_RE.test(s)) return false;
    return !isDisabled(node);
  }

  function isDisabled(el) {
    const aria = (el.getAttribute?.("aria-disabled") || "").toLowerCase() === "true";
    return aria || el.hasAttribute?.("disabled");
  }

  function getActionElFromEvent(e) {
    const path = (e.composedPath && e.composedPath()) || [];
    for (const n of path) {
      if (n && n.nodeType === 1 && nodeLooksLikeAdd(n)) return n;
    }
    // No fallback global query here — prevents white-space clicks from triggering.
    return null;
  }

  // ---------- send strategy ----------
  let sentQuick = false, sentSettled = false;
  let lastKey = "", lastAt = 0;
  let lastAddClickTs = 0;

  const debounce = (key, ms) => {
    const now = Date.now();
    if (key === lastKey && now - lastAt < ms) return false;
    lastKey = key; lastAt = now; return true;
  };

  function settleThenScrape(ms = 900) {
    return new Promise((resolve) => {
      let resolved = false;
      const initial = buildItem();
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

  function resetFlags() { sentQuick = false; sentSettled = false; lastKey = ""; lastAt = 0; }

  // ---------- event handlers (strict) ----------
  function onClick(e) {
    // left clicks only
    if (e.type === "click" && e.button !== 0) return;
    const actionEl = getActionElFromEvent(e);
    if (!actionEl) return;

    lastAddClickTs = Date.now();
    sendQuick("ui-quick");
    setTimeout(() => sendSettled("ui-settled"), 160);
  }

  function onKeydown(e) {
    const k = e.key;
    if (k !== "Enter" && k !== " ") return;
    const actionEl = getActionElFromEvent(e);
    if (!actionEl) return;

    lastAddClickTs = Date.now();
    sendQuick("ui-quick");
    setTimeout(() => sendSettled("ui-settled"), 160);
  }

  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeydown, true);

  // ---------- background nudges (only if we actually clicked add recently) ----------
  chrome.runtime?.onMessage?.addListener?.((msg) => {
    if (msg?.action !== "ADD_TRIGGERED") return;
    if (Date.now() - lastAddClickTs > 3000) return; // ignore stray nudges
    setTimeout(() => sendSettled("webRequest"), 150);
  });

  // ---------- SPA URL changes → reset flags ----------
  let lastHref = location.href;
  const onUrlMaybeChanged = () => { if (location.href !== lastHref) { lastHref = location.href; resetFlags(); } };
  (function watchUrlChanges(){
    const _ps = history.pushState, _rs = history.replaceState;
    history.pushState = function(...a){ const r = _ps.apply(this,a); onUrlMaybeChanged(); return r; };
    history.replaceState = function(...a){ const r = _rs.apply(this,a); onUrlMaybeChanged(); return r; };
    window.addEventListener("popstate", onUrlMaybeChanged);
    window.addEventListener("hashchange", onUrlMaybeChanged);
    setInterval(onUrlMaybeChanged, 1000);
  })();

  log("loaded");
})();