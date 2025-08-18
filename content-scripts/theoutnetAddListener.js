// content-scripts/theoutnetAddListener.js
(() => {
  if (window.top !== window) return;
  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-OUTNET]", ...a);

  const $ = (s)=>document.querySelector(s);
  const attr = (s,n)=>$(s)?.getAttribute(n) || "";
  const first = (v)=>Array.isArray(v)?v[0]:v;

  const isPDP = () => {
    const p = location.pathname.toLowerCase();
    if (/\/shop\/product\//.test(p) || /\/product\//.test(p)) return true;
    const ogt = attr('meta[property="og:type"]','content') || "";
    return /product/i.test(ogt);
  };

  function findProduct(node){
    try{
      if (!node || typeof node !== "object") return null;
      const t=node["@type"]; const isProd=Array.isArray(t)?t.map(String).map(s=>s.toLowerCase()).includes("product"):(String(t||"").toLowerCase()==="product");
      if (isProd) return node;
      if (Array.isArray(node)) for (const x of node){ const hit=findProduct(x); if (hit) return hit; }
      else{
        if (node["@graph"]){ const hit=findProduct(node["@graph"]); if (hit) return hit; }
        for(const k of Object.keys(node)){ const hit=findProduct(node[k]); if (hit) return hit; }
      }
    }catch{}
    return null;
  }
  function parseLD(){
    for (const s of document.querySelectorAll('script[type*="ld+json"]')){
      try { const j=JSON.parse(s.textContent||""); const p=findProduct(j); if (p) return p; } catch {}
    }
    return null;
  }

  function extractTitle(){
    return attr('meta[property="og:title"]','content') ||
           document.querySelector("h1")?.textContent?.trim() ||
           document.title;
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
        if (p != null && p !== ""){
          const n=Number(p); if (Number.isFinite(n)) return `$ ${n.toFixed(2)}`;
          const tok=String(p).match(/[$€£]\s?\d[\d.,]*/); if (tok) return tok[0];
        }
      }
    }
    const m = attr('meta[property="product:price:amount"]','content') || attr('meta[itemprop="price"]','content');
    if (m){ const n=Number(m); if (Number.isFinite(n)) return `$ ${n.toFixed(2)}`; const tok=String(m).match(/[$€£]\s?\d[\d.,]*/); if (tok) return tok[0]; }
    const t = Array.from(document.querySelectorAll('[class*="price"], [data-testid*="price"], span, div'))
      .map(el => el.textContent && el.textContent.trim())
      .find(txt => /[$€£]\s?\d/.test(txt||""));
    return t ? (t.match(/[$€£]\s?\d[\d.,]*/)||[""])[0] : "";
  }
  function extractId(){
    const ld = parseLD(); if (ld?.sku) return String(ld.sku);
    const can = attr('link[rel="canonical"]','href') || "";
    return can || location.href;
  }
  function extractBrand(){
    return attr('meta[property="og:site_name"]','content') || "THE OUTNET";
  }

  function buildItem(){
    return {
      id: extractId(),
      title: extractTitle(),
      brand: extractBrand(),
      price: extractPrice(),
      img: extractImage(),
      link: location.href
    };
  }

  function sendItemSafe(item){
    try {
      if (!chrome?.runtime?.id) return;
      chrome.runtime.sendMessage({ action: "ADD_ITEM", item }, () => void chrome.runtime?.lastError);
    } catch {}
  }

  // Strict “Add to Bag” detection to avoid gallery clicks
  const ADD_TXT = /\badd to (bag|cart)\b/i;
  const BTN_SEL = [
    "button", "[role=button]", "a[role=button]", "input[type=submit]",
    "[data-test*='add']",
    "[data-testid*='add']",
    "#addToBagButton", "#add-to-bag", "#add-to-cart"
  ].join(",");

  const looksLikeAdd = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const s = [
      el.textContent || "",
      el.getAttribute?.("aria-label") || "",
      el.getAttribute?.("data-testid") || "",
      el.getAttribute?.("data-test") || "",
      el.id || "", el.name || "", el.className || ""
    ].join(" ").toLowerCase();
    if (s.includes("adding")) return false;
    return ADD_TXT.test(s);
  };

  let seenAt = 0;
  function onClick(e){
    if (!isPDP()) return;
    const btn = e.target?.closest?.(BTN_SEL);
    if (!btn || !looksLikeAdd(btn)) return;
    const now = Date.now(); if (now - seenAt < 1200) return; // dedupe
    seenAt = now;
    setTimeout(async () => {
      const item = await (async()=> {
        // wait for UI/price to settle
        return new Promise((resolve)=>{
          let done=false;
          const initial = buildItem();
          if (initial.price || initial.img){ done=true; return resolve(initial); }
          const t=setTimeout(()=>{ if(!done){ done=true; obs.disconnect(); resolve(buildItem()); }}, 900);
          const obs=new MutationObserver(()=>{
            if (done) return;
            const it = buildItem();
            if (it.price || it.img){ clearTimeout(t); done=true; obs.disconnect(); resolve(it); }
          });
          obs.observe(document.documentElement, { childList:true, subtree:true, attributes:true });
        });
      })();
      if (!item.title) return;
      log("ADD_ITEM via click", item);
      sendItemSafe(item);
    }, 150);
  }

  window.addEventListener("click", onClick, true);
  log("wired", { href: location.href, pdp: isPDP() });
})();