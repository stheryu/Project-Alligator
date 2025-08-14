// content-scripts/pageHook.js

(() => {
  if (window.top !== window) return; // top-frame only

  // ---- Inject the in-page hook (must be web_accessible) ----
  try {
    const url = chrome.runtime.getURL("inpage/pageHook.inpage.js");
    const s = document.createElement("script");
    s.src = url;
    s.async = false;
    s.onload = () => { try { s.remove(); } catch {} };
    (document.documentElement || document.head || document.body).appendChild(s);
  } catch (e) {
    // Non-fatal; we can still listen to submits via DOM if needed
    // eslint-disable-next-line no-console
    console.debug("[UnifiedCart] inpage injection failed:", e);
  }

  // ---- Helpers for scrape (minimal but resilient) ----
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const txt  = (sel) => ($(sel)?.textContent || "").trim();
  const attr = (sel, n) => $(sel)?.getAttribute(n) || "";
  const first= (a) => Array.isArray(a) ? a[0] : a;
  const abs  = (u) => { try { return new URL(u, location.href).toString(); } catch { return u || ""; } };
  const token= (s) => (String(s).match(/[$€£]\s?\d[\d.,]+/) || [""])[0];
  const looksPixel = (u="") => {
    const x = String(u).toLowerCase();
    return !x || x.startsWith("data:") || x.endsWith(".svg") || /pixel|1x1|spacer|beacon/.test(x);
  };

  function findProductNode(node) {
    try {
      if (!node || typeof node !== "object") return null;
      const t = node["@type"];
      const norm = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).map(x => String(x).toLowerCase());
      if (norm(t).includes("product")) return node;
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
        const raw = (s.textContent || "").trim(); if (!raw) continue;
        const json = JSON.parse(raw);
        const prod = findProductNode(json);
        if (prod) return prod;
      } catch {}
    }
    return null;
  }

  function parseShopifyProductJSON() {
    const cands = [
      ...$$('script[type="application/json"][id^="ProductJson-"]'),
      ...$$('script[type="application/json"][data-product-json]')
    ];
    for (const s of cands) {
      try {
        const json = JSON.parse((s.textContent || "").trim());
        if (json && (json.variants || json.images || json.title)) return json;
      } catch {}
    }
    const next = document.getElementById("__NEXT_DATA__");
    if (next) {
      try {
        const json = JSON.parse(next.textContent || "");
        const deep = (obj) => {
          if (!obj || typeof obj !== "object") return null;
          if (obj.variants && obj.images && obj.title) return obj;
          for (const k of Object.keys(obj)) { const r = deep(obj[k]); if (r) return r; }
          return null;
        };
        const hit = deep(json);
        if (hit) return hit;
      } catch {}
    }
    return null;
  }

  function extractTitle() {
    return (
      attr('meta[property="og:title"]','content') ||
      (parseLD()?.name ? String(parseLD().name) : "") ||
      (parseShopifyProductJSON()?.title ? String(parseShopifyProductJSON().title) : "") ||
      txt("h1") ||
      document.title
    );
  }

  function extractBrand() {
    const ld = parseLD();
    if (ld?.brand) return typeof ld.brand === "string" ? ld.brand : (ld.brand.name || "");
    const sj = parseShopifyProductJSON();
    if (sj?.vendor) return String(sj.vendor);
    const ogSite = attr('meta[property="og:site_name"]','content') || "";
    if (ogSite) return ogSite;
    return location.hostname.replace(/^www\./, "");
  }

  function pickBestFromSrcset(ss) {
    if (!ss) return "";
    try {
      return ss.split(",").map(s => s.trim()).map(p => {
        const [url, w] = p.split(/\s+/);
        return { url: abs(url), width: parseInt((w || "").replace(/\D/g, ""), 10) || 0 };
      }).sort((a,b) => b.width - a.width)[0]?.url || "";
    } catch { return ""; }
  }

  function extractImage() {
    const og = attr('meta[property="og:image"]','content') || attr('meta[property="og:image:secure_url"]','content');
    if (og && !looksPixel(og)) return abs(og);

    const ld = parseLD();
    if (ld?.image) {
      const v = first(Array.isArray(ld.image) ? ld.image : [ld.image]);
      const url = typeof v === "string" ? v : (v && typeof v === "object" && v.url) ? v.url : "";
      if (url && !looksPixel(url)) return abs(url);
    }

    const sj = parseShopifyProductJSON();
    if (sj?.images?.length) {
      const v = first(sj.images);
      const url = (typeof v === "string") ? v : v?.src || v?.url || "";
      if (url && !looksPixel(url)) return abs(url);
    }

    const imgEl = document.querySelector("picture img") || document.querySelector("img");
    if (imgEl) {
      const best = pickBestFromSrcset(imgEl.getAttribute("srcset"));
      const src  = abs(imgEl.getAttribute("src") || imgEl.src || "");
      if (best && !looksPixel(best)) return best;
      if (src && !looksPixel(src)) return src;
    }

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

    const sj = parseShopifyProductJSON();
    if (sj?.variants?.length) {
      const v0 = sj.variants[0];
      if (typeof v0.price === "number") return `$ ${(v0.price / 100).toFixed(2)}`;
      if (typeof v0.price === "string") {
        const n = Number(v0.price);
        return Number.isFinite(n) ? `$ ${n.toFixed(2)}` : token(v0.price);
      }
    }

    const metaNum =
      attr('meta[itemprop="price"]','content') ||
      attr('meta[property="product:price:amount"]','content') ||
      attr('meta[property="og:price:amount"]','content') ||
      attr('meta[name="twitter:data1"]','content');
    if (metaNum) {
      const n = Number(metaNum);
      return Number.isFinite(n) ? `$ ${n.toFixed(2)}` : token(metaNum);
    }

    const cand = $$('[class*="price"], [data-testid*="price"], [itemprop*="price"], span, div')
      .map(el => el.textContent && el.textContent.trim())
      .filter(Boolean)
      .filter(t => !/\b(per|\/)\s?(count|ct|ea|each|oz|lb|kg|ml|g)\b/i.test(t))
      .find(t => /[$€£]\s?\d/.test(t));
    return cand ? token(cand) : "";
  }

  function buildItem() {
    const ld = parseLD();
    const sj = parseShopifyProductJSON();
    const sku = (ld && (ld.sku || ld.mpn)) || (sj && (sj.id || sj.product_id)) || "";
    return {
      id:   String(sku || location.href),
      title: String(extractTitle() || document.title || ""),
      brand: String(extractBrand() || ""),
      price: String(extractPrice() || ""),
      img:   String(extractImage() || ""),
      link:  location.href
    };
  }

  // Wait briefly for UI/price/img to settle after an add
  function settleThenScrape(ms = 900) {
    return new Promise((resolve) => {
      let done = false;
      const initial = buildItem();
      if (initial.price || initial.img) { done = true; return resolve(initial); }
      const timer = setTimeout(() => { if (!done) { done = true; obs.disconnect(); resolve(buildItem()); }}, ms);
      const obs = new MutationObserver(() => {
        if (done) return;
        const item = buildItem();
        if (item.price || item.img) { clearTimeout(timer); done = true; obs.disconnect(); resolve(item); }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    });
  }

  // ---- Listen for in-page ADD events and persist item ----
  const recent = new Map(); // url -> ts
  const SEEN_MS = 1200;

  function dedupe(key) {
    const t = Date.now();
    const last = recent.get(key) || 0;
    if (t - last < SEEN_MS) return true;
    recent.set(key, t);
    return false;
  }

  window.addEventListener("message", async (ev) => {
    const d = ev?.data;
    if (!d || d.source !== "UnifiedCartPage" || d.type !== "ADD_EVENT") return;

    const key = String(d.url || location.href);
    if (dedupe(key)) return;

    try {
      const item = await settleThenScrape(900);
      if (!item.title) return;
      // Send straight to background; background already dedupes + respects shoppingMode
      chrome.runtime.sendMessage({ action: "ADD_ITEM", item }, () => void chrome.runtime?.lastError);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.debug("[UnifiedCart] pageHook scrape/send error:", e);
    }
  }, false);

  // Safety: ignore obviously non-PDP sections
  const path = location.pathname.toLowerCase();
  if (/(^|\/)(cart|checkout|shopping-?bag|wishlist|account|login|register)(\/|$)/.test(path)) {
    // Do nothing; add events from these pages aren’t PDP adds
  }
})();