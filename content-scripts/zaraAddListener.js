// content-scripts/zaraAddListener.js
(() => {
  if (window.top !== window) return; // top frame only
  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Zara]", ...a);

  // ---- tiny utils ----
  const $ = (s) => document.querySelector(s);
  const attr = (s, n) => $(s)?.getAttribute(n) || "";
  const first = (v) => Array.isArray(v) ? v[0] : v;

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
    const ld = parseLD();
    if (ld?.offers){
      const offers = Array.isArray(ld.offers) ? ld.offers : [ld.offers];
      for (const o of offers){
        const p = o.price || o.lowPrice || o.highPrice || o?.priceSpecification?.price;
        if (p != null && p !== "") {
          const n = Number(p); if (Number.isFinite(n)) return `$ ${n.toFixed(2)}`;
          const tok = String(p).match(/[$€£]\s?\d[\d.,]*/); if (tok) return tok[0];
        }
      }
    }
    const metaP = attr('meta[property="product:price:amount"]','content') || attr('meta[itemprop="price"]','content');
    if (metaP){
      const n = Number(metaP); if (Number.isFinite(n)) return `$ ${n.toFixed(2)}`;
      const tok = String(metaP).match(/[$€£]\s?\d[\d.,]*/); if (tok) return tok[0];
    }
    const t = Array.from(document.querySelectorAll('[class*="price"],[data-testid*="price"],span,div'))
      .map(el => el.textContent && el.textContent.trim())
      .find(txt => /[$€£]\s?\d/.test(txt||""));
    return t ? (t.match(/[$€£]\s?\d[\d.,]*/)||[""])[0] : "";
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
  function settleThenScrape(ms=900){
    return new Promise((resolve)=>{
      let done=false;
      const initial = buildItem();
      if (initial.price || initial.img){ done=true; return resolve(initial); }
      const t = setTimeout(()=>{ if(!done){ done=true; obs.disconnect(); resolve(buildItem()); }}, ms);
      const obs = new MutationObserver(()=>{
        if (done) return;
        const it = buildItem();
        if (it.price || it.img){ clearTimeout(t); done=true; obs.disconnect(); resolve(it); }
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
    const item = await settleThenScrape(1000);
    if (!item.title) return;
    lastSentAt = now;
    log("ADD_ITEM via nudge", item);
    sendItemSafe(item);
  });

  log("wired", { href: location.href });
})();