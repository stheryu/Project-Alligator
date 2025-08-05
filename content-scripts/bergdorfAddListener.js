// content-scripts/bergdorfAddListener.js
(() => {
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Bergdorf]", ...a);
  const HAS_EXT = !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);

  // ---------- small helpers ----------
  const $    = (s) => document.querySelector(s);
  const txt  = (s) => ($(s)?.textContent || "").trim();
  const attr = (s,n) => $(s)?.getAttribute(n) || "";
  const token = (s) => (String(s).match(/[$€£]\s?\d[\d.,]+/) || [""])[0];
  const normT = (t) => (Array.isArray(t) ? t : (t ? [t] : [])).map(v => String(v).toLowerCase());
  const first = (a) => Array.isArray(a) ? a[0] : a;

  function absUrl(u) {
    try { return new URL(u, location.href).toString(); } catch { return u || ""; }
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
    } catch {
      return "";
    }
  }
  function looksLikePixel(u = "") {
    const x = String(u).toLowerCase();
    return !x || x.startsWith("data:") || x.endsWith(".svg") || /pixel|1x1|spacer|beacon/.test(x);
  }

  // ---------- JSON-LD parsing ----------
  function findProductNode(node) {
    try {
      if (!node || typeof node !== "object") return null;
      if (normT(node["@type"]).includes("product")) return node;
      if (Array.isArray(node)) {
        for (const x of node) { const hit = findProductNode(x); if (hit) return hit; }
      } else {
        if (node["@graph"]) {
          const hit = findProductNode(node["@graph"]); if (hit) return hit;
        }
        for (const k of Object.keys(node)) {
          const hit = findProductNode(node[k]); if (hit) return hit;
        }
      }
    } catch {}
    return null;
  }
  function parseLD() {
    const scripts = Array.from(document.querySelectorAll('script[type*="ld+json"]'));
    for (const s of scripts) {
      try {
        const json = JSON.parse((s.textContent || "").trim());
        const prod = findProductNode(json);
        if (prod) return prod;
      } catch {}
    }
    return null;
  }

  // PDP heuristic: JSON-LD Product present OR canonical looks like PDP
  const isPDP = () => {
    if (parseLD()) return true;
    const canon = document.querySelector('link[rel="canonical"]')?.href || "";
    return /\/p\/|\/prod\//i.test(canon || location.pathname);
  };

  // ---------- field extractors ----------
  function extractTitle() {
    return attr('meta[property="og:title"]','content') || txt("h1") || document.title;
  }
  function extractBrand() {
    const ld = parseLD();
    if (ld?.brand) return typeof ld.brand === "string" ? ld.brand : (ld.brand.name || "");
    return txt('[data-testid*="brand"], a[href*="/c/designers/"]') || "";
  }
  function extractImage() {
    // 1) OG image
    const og = attr('meta[property="og:image"]','content') || attr('meta[property="og:image:secure_url"]','content');
    if (og && !looksLikePixel(og)) return absUrl(og);

    // 2) JSON-LD image (string | array | {url})
    const ld = parseLD();
    if (ld?.image) {
      const v = Array.isArray(ld.image) ? ld.image[0] : ld.image;
      const url = typeof v === "string" ? v : (v && typeof v === "object" && v.url) ? v.url : "";
      if (url && !looksLikePixel(url)) return absUrl(url);
    }

    // 3) <picture><img> (srcset/src)
    const imgEl = document.querySelector("picture img") || document.querySelector("img");
    if (imgEl) {
      const ss = imgEl.getAttribute("srcset");
      const best = pickBestFromSrcset(ss);
      const src = absUrl(imgEl.getAttribute("src") || imgEl.src || "");
      if (best && !looksLikePixel(best)) return best;
      if (src && !looksLikePixel(src)) return src;
    }

    // 4) <picture><source srcset=...>
    const source = document.querySelector("picture source[srcset]");
    if (source) {
      const ss2 = source.getAttribute("srcset");
      const best2 = pickBestFromSrcset(ss2);
      if (best2 && !looksLikePixel(best2)) return best2;
    }

    // 5) Lazy attrs
    const lazyImg = document.querySelector("img[data-src], img[data-original], img[data-lazy]");
    if (lazyImg) {
      const lazySrc = absUrl(lazyImg.getAttribute("data-src") || lazyImg.getAttribute("data-original") || lazyImg.getAttribute("data-lazy"));
      if (lazySrc && !looksLikePixel(lazySrc)) return lazySrc;
    }

    // 6) Preloaded hero images
    const preload = Array.from(document.querySelectorAll('link[rel="preload"][as="image"]'))
      .map(l => absUrl(l.getAttribute("href") || l.href))
      .find(href => href && !looksLikePixel(href));
    if (preload) return preload;

    // 7) CSS background-image
    const bgEl = document.querySelector('[style*="background-image"]');
    if (bgEl) {
      const style = bgEl.getAttribute("style") || "";
      const m = style.match(/background-image\s*:\s*url\((['"]?)(.*?)\1\)/i);
      const url = m && m[2] ? absUrl(m[2]) : "";
      if (url && !looksLikePixel(url)) return url;
    }

    // 8) Twitter card (sometimes present)
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
    const mp = attr('meta[itemprop="price"]','content') ||
               attr('meta[property="product:price:amount"]','content') ||
               attr('meta[property="og:price:amount"]','content');
    if (mp) { const n = Number(mp); return Number.isFinite(n) ? `$ ${n.toFixed(2)}` : token(mp); }

    const cand = Array.from(document.querySelectorAll('[class*="price"], [data-testid*="price"], span, div'))
      .map(el => el.textContent && el.textContent.trim())
      .filter(Boolean)
      .find(t => /[$€£]\s?\d/.test(t));
    return cand ? token(cand) : "";
  }

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
    if (!HAS_EXT) { log("context invalidated — refresh page"); return; }
    try {
      chrome.runtime.sendMessage({ action: "ADD_ITEM", item }, () => {
        if (chrome.runtime?.lastError) log("sendMessage lastError", chrome.runtime.lastError.message);
      });
    } catch (e) {
      log("sendMessage exception", e);
    }
  }

  // ---------- dual-shot scrape (quick + settled) ----------
  let sentQuick = false, sentSettled = false, lastAt = 0, lastKey = "";
  const debounce = (key, ms) => { const now = Date.now(); if (key === lastKey && now - lastAt < ms) return false; lastKey = key; lastAt = now; return true; };

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
  function sendQuick() {
    if (!isPDP() || sentQuick) return;
    if (!debounce(location.href, 200)) return;
    const item = buildItem();
    if (!item.title) return;
    log("ADD_ITEM quick", item);
    sendItemSafe(item);
    sentQuick = true;
  }
  async function sendSettled() {
    if (!isPDP() || sentSettled) return;
    const item = await settleThenScrape(1000);
    if (!item.title) return;
    log("ADD_ITEM settled", item);
    sendItemSafe(item);
    sentSettled = true;
  }

  // ---------- button matching ----------
  const POS = /\badd to bag\b|\badd to cart\b|\bbuy now\b/i;
  const NEG = /\b(add to wish|wishlist|favorites|list|registry|address|payment|card|newsletter)\b/i;

  function looksLikeAdd(node) {
    if (!node || node.nodeType !== 1) return false;
    const s = [
      node.textContent || "",
      node.getAttribute?.("aria-label") || "",
      node.getAttribute?.("data-testid") || "",
      node.getAttribute?.("id") || "",
      node.getAttribute?.("name") || "",
      node.getAttribute?.("class") || ""
    ].join(" ").toLowerCase();
    if (s.includes("adding")) return false;
    if (NEG.test(s)) return false;
    return POS.test(s);
  }
  function pathHasAdd(e) {
    const path = (e.composedPath && e.composedPath()) || [];
    for (const n of path) if (looksLikeAdd(n)) return true;
    return false;
  }

  ["mousedown","pointerdown","touchstart"].forEach(t =>
    document.addEventListener(t, e => { if (pathHasAdd(e)) sendQuick(); }, true)
  );
  ["click","pointerup","touchend","submit","keydown"].forEach(t =>
    document.addEventListener(t, e => { if (pathHasAdd(e)) setTimeout(sendSettled, 140); }, true)
  );

  // ---------- debug helper ----------
  window.__UC_BG_DEBUG = () => {
    const og = attr('meta[property="og:image"]','content') || attr('meta[property="og:image:secure_url"]','content');
    const ld = parseLD();
    const img = document.querySelector("picture img, img");
    const imgSrc = img?.getAttribute("src") || "";
    const imgSrcset = img?.getAttribute("srcset") || "";
    const source = document.querySelector("picture source[srcset]");
    const sourceSrcset = source?.getAttribute("srcset") || "";
    const preload = Array.from(document.querySelectorAll('link[rel="preload"][as="image"]')).map(l => l.getAttribute("href") || l.href);
    const bgEl = document.querySelector('[style*="background-image"]');
    const bgStyle = bgEl?.getAttribute("style") || "";
    const best = extractImage();
    const out = { href: location.href, og, ldImage: ld?.image || null, imgSrc, imgSrcset, sourceSrcset, preload, bgStyle, picked: best };
    console.log("[UnifiedCart-Bergdorf DEBUG]", out);
    return out;
  };

  log("loaded", { href: location.href, isPDP: isPDP() });
})();