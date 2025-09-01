// content-scripts/zaraAddListener.js
(() => {
  if (window.top !== window) return; // top frame only
  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Zara]", ...a);

  // ---- tiny utils ----
  const $ = (s, root=document) => root.querySelector(s);
  const $$ = (s, root=document) => Array.from(root.querySelectorAll(s));
  const attr = (s, n) => $(s)?.getAttribute(n) || "";
  const first = (v) => Array.isArray(v) ? v[0] : v;

  // robust money token (handles "$ 39.90", "€19,99", etc.)
  const TOKEN_RE = /(?:[$€£¥₹]\s?\d[\d.,]*|\b(?:USD|CAD|EUR|GBP|JPY|INR)\b\s?\d[\d.,]*|\d[\d.,]*\s?\b(?:USD|CAD|EUR|GBP|JPY|INR)\b)/i;
  const token = (s) => (String(s).match(TOKEN_RE) || [""])[0];
  const clean = (p) => String(p || "").replace(/[.,]\s*$/, "").trim();

  const isZaraPDP = () => {
    try {
      const p = location.pathname.toLowerCase();
      if (/-p\d+(?:\.html|$)/.test(p)) return true;               // e.g. ...-p04341878.html
      const can = attr('link[rel="canonical"]','href') || "";
      if (/-p\d+/.test(can)) return true;
      const ogt = attr('meta[property="og:type"]','content') || "";
      if (/product/i.test(ogt)) return true;
      return !!document.querySelector('[data-product-id], [data-qa*="pdp"]');
    } catch { return false; }
  };

  // JSON-LD product (best-effort)
  function findProduct(node){
    try {
      if (!node || typeof node !== "object") return null;
      const t = node["@type"];
      const isProd = Array.isArray(t) ? t.map(String).map(s=>s.toLowerCase()).includes("product") : (String(t||"").toLowerCase()==="product");
      if (isProd) return node;
      if (Array.isArray(node)) for (const x of node){ const hit = findProduct(x); if (hit) return hit; }
      else {
        if (node["@graph"]) { const hit = findProduct(node["@graph"]); if (hit) return hit; }
        for (const k of Object.keys(node)){ const hit = findProduct(node[k]); if (hit) return hit; }
      }
    } catch {}
    return null;
  }
  function parseLD(){
    for (const s of document.querySelectorAll('script[type*="ld+json"]')){
      try { const j = JSON.parse(s.textContent||""); const p = findProduct(j); if (p) return p; } catch {}
    }
    return null;
  }

  // ------- PRICE SOURCES (ordered) -------

  // 1) Main current price from PDP header (reflects selected size)
  function readMainCurrentPrice() {
    // aria label (varies by locale)
    const priceContainer = $('#price-container,[data-qa-id="price-container-current"]') || $('[aria-label*="current price" i]');
    if (priceContainer) {
      // prefer structured amount nodes
      const amt =
        $('[data-qa-qualifier="price-amount-current"] .money-amount__main', priceContainer) ||
        $('.price-current__amount .money-amount__main', priceContainer) ||
        $('.money-amount__main', priceContainer) ||
        priceContainer;
      const t = token(amt.textContent || amt.getAttribute?.("aria-label") || "");
      if (t) return clean(t);
    }
    return "";
  }

  // 2) Action-sheet (size picker) — last clicked/selected size price
  let ZARA_LAST_SIZE_PRICE = "";
  function readActionSheetSelectedPrice() {
    const sheet = $('.zds-action-sheet-swipeable-container--open');
    if (!sheet) return ZARA_LAST_SIZE_PRICE || "";
    // try an explicitly selected/focused size item
    const sel =
      $('.size-selector-sizes-size__button[aria-pressed="true"]', sheet) ||
      $('.size-selector-sizes-size__button[aria-selected="true"]', sheet) ||
      $('.size-selector-sizes-size--selected .size-selector-sizes-size__button', sheet) ||
      document.activeElement?.closest?.('.size-selector-sizes-size__button') ||
      null;
    const holder = sel || $('.size-selector-sizes-size__button', sheet); // fall back to first button if needed
    if (holder) {
      const amt =
        $('.price-current__amount .money-amount__main', holder) ||
        $('.money-amount__main', holder) ||
        holder;
      const t = token(amt.textContent || "");
      if (t) return clean(t);
    }
    return ZARA_LAST_SIZE_PRICE || "";
  }
  // capture last clicked size price so we use the *user’s choice*
  document.addEventListener("click", (e) => {
    try {
      const btn = e.target?.closest?.('.size-selector-sizes-size__button');
      if (!btn) return;
      const amt =
        $('.price-current__amount .money-amount__main', btn) ||
        $('.money-amount__main', btn) ||
        btn;
      const t = token(amt.textContent || "");
      if (t) ZARA_LAST_SIZE_PRICE = clean(t);
      if (DEBUG && ZARA_LAST_SIZE_PRICE) log("size-click price override =", ZARA_LAST_SIZE_PRICE);
    } catch {}
  }, true);

  // 3) JSON-LD/meta fallback
  function readStructuredPrice(){
    const ld = parseLD();
    if (ld?.offers){
      const offers = Array.isArray(ld.offers) ? ld.offers : [ld.offers];
      for (const o of offers){
        const p = o.price || o.lowPrice || o.highPrice || o?.priceSpecification?.price;
        if (p != null && p !== "") {
          const n = Number(p);
          if (Number.isFinite(n) && n > 0) return `$ ${n.toFixed(2)}`;
          const tok = token(String(p)); if (tok) return clean(tok);
        }
      }
    }
    const metaP = attr('meta[property="product:price:amount"]','content') || attr('meta[itemprop="price"]','content');
    if (metaP){
      const n = Number(metaP); if (Number.isFinite(n) && n > 0) return `$ ${n.toFixed(2)}`;
      const tok = token(metaP); if (tok) return clean(tok);
    }
    return "";
  }

  function extractTitle(){
    return (
      attr('meta[property="og:title"]','content') ||
      document.querySelector("h1")?.textContent?.trim() ||
      document.title
    );
  }
  function extractImage(){
    const og = attr('meta[property="og:image"]','content') || attr('meta[property="og:image:secure_url"]','content');
    if (og) return og;
    const ld = parseLD(); const im = ld?.image && first(ld.image);
    if (im) return typeof im === "string" ? im : (im.url || "");
    const img = document.querySelector("picture img, img");
    return img?.getAttribute("src") || img?.src || "";
  }
  function extractPrice(){
    // priority: main current > action sheet selection > structured/meta > page scan (last resort)
    const main = readMainCurrentPrice();
    if (main) return main;

    const sheetPrice = readActionSheetSelectedPrice();
    if (sheetPrice) return sheetPrice;

    const structured = readStructuredPrice();
    if (structured) return structured;

    // Last resort: page scan but *prefer current* / avoid picking lowest
    const currentish = $(
      '.price-current .money-amount__main, [data-qa-qualifier="price-amount-current"] .money-amount__main, [data-qa-id="price-container-current"] .money-amount__main'
    );
    if (currentish) {
      const t = token(currentish.textContent || ""); if (t) return clean(t);
    }
    const any = Array.from(document.querySelectorAll('[class*="price"],[data-testid*="price"],span,div'))
      .map(el => token(el.textContent || ""))
      .find(Boolean);
    return any ? clean(any) : "";
  }

  function extractId(){
    const ld = parseLD(); if (ld?.sku) return String(ld.sku);
    const can = attr('link[rel="canonical"]','href') || "";
    const m = can.match(/-p(\d+)/); if (m) return m[1];
    const hid = document.querySelector('[name="productCode"]')?.value || "";
    return hid || location.href;
  }

  function buildItem(){
    return {
      id: extractId(),
      title: extractTitle(),
      brand: "ZARA",
      price: extractPrice(),
      img: extractImage(),
      link: location.href
    };
  }

  // --- send (safe) ---
  function sendItemSafe(item){
    try {
      if (!chrome?.runtime?.id) return;
      chrome.runtime.sendMessage({ action: "ADD_ITEM", item }, () => void chrome.runtime?.lastError);
    } catch {}
  }

  // --- settle-after-nudge ---
  function settleThenScrape(ms=1000){
    return new Promise((resolve)=>{
      let done=false;
      const tryBuild = () => {
        const it = buildItem();
        if (it.price || it.img) return it;
        return null;
      };
      const initial = tryBuild();
      if (initial){ return resolve(initial); }

      const t = setTimeout(()=>{ if(!done){ done=true; obs.disconnect(); resolve(buildItem()); }}, ms);
      const obs = new MutationObserver(()=>{
        if (done) return;
        const it = tryBuild();
        if (it){ clearTimeout(t); done=true; obs.disconnect(); resolve(it); }
      });
      obs.observe(document.documentElement, { childList:true, subtree:true, attributes:true });
    });
  }

  // --- nudge handler (from background webRequest; includes BROADCAST) ---
  let lastSentAt = 0;
  chrome.runtime?.onMessage?.addListener?.(async (m)=>{
    if (!m) return;
    if (m.action !== "ADD_TRIGGERED" && m.action !== "ADD_TRIGGERED_BROADCAST") return;
    if (!isZaraPDP()) return;
    const now = Date.now(); if (now - lastSentAt < 1200) return;
    const item = await settleThenScrape(1200);
    if (!item.title) return;
    lastSentAt = now;
    log("ADD_ITEM via nudge", item);
    sendItemSafe(item);
  });

  log("wired", { href: location.href });
})();