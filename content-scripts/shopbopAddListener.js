// content-scripts/shopbopAddListener.js
(() => {
  // Run only in TOP frame
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Shopbop]", ...a);

  // ---------- safe send (with storage fallback) ----------
  function saveToStorageDirect(item) {
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
    try {
      if (chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ action: "ADD_ITEM", item }, () => {
          if (chrome.runtime?.lastError) {
            log("sendMessage lastError → fallback:", chrome.runtime.lastError.message);
            saveToStorageDirect(item);
          }
        });
      } else {
        saveToStorageDirect(item);
      }
    } catch (e) {
      log("sendItemSafe exception → fallback:", e);
      saveToStorageDirect(item);
    }
  }

  // ---------- PDP gate ----------
  function parseJSONLDProduct() {
    const scripts = Array.from(document.querySelectorAll('script[type*="ld+json"]'));
    for (const s of scripts) {
      try {
        const raw = (s.textContent || "").trim(); if (!raw) continue;
        const json = JSON.parse(raw);
        const arr = Array.isArray(json) ? json : [json];
        for (const obj of arr) {
          const t = obj && obj['@type'];
          const list = Array.isArray(t) ? t : (t ? [t] : []);
          if (list.map(v => String(v).toLowerCase()).includes('product')) return obj;
        }
        if (json && json['@graph']) {
          for (const g of json['@graph']) {
            const t = g && g['@type'];
            const list = Array.isArray(t) ? t : (t ? [t] : []);
            if (list.map(v => String(v).toLowerCase()).includes('product')) return g;
          }
        }
      } catch {}
    }
    return null;
  }
  function isPdp() {
    try {
      const path = (location.pathname || "").toLowerCase();
      if (/\/(cart|bag|checkout)(\/|$)/.test(path)) return false;

      // URL hints Shopbop typically uses: /products/, /product/, sometimes /vp/ or legacy /c/brands/...
      const urlHint = /\/(products?|vp)\/|\/prod\//i.test(path);

      // Product signals from DOM/meta
      const hasTitle = !!document.querySelector('[data-testid="product-title"], h1[itemprop="name"], h1');
      const hasPrice = !!document.querySelector('[data-testid*="price"], [class*="Price"]');
      const ogType = (document.querySelector('meta[property="og:type"]')?.getAttribute('content') || "").toLowerCase() === "product";
      const ld = !!parseJSONLDProduct();

      const eligible = ogType || ld || urlHint || (hasTitle && hasPrice);
      log("PDP gate:", { path, urlHint, hasTitle, hasPrice, ogType, ld, eligible });
      return eligible;
    } catch { return false; }
  }

  // ---------- helpers & extractors ----------
  const pickBestFromSrcset = (ss) => {
    if (!ss) return "";
    try {
      const best = ss.split(",")
        .map(s => s.trim())
        .map(p => {
          const [url, w] = p.split(/\s+/);
          return { url, w: parseInt((w || "").replace(/\D/g, ""), 10) || 0 };
        })
        .sort((a,b) => b.w - a.w)[0]?.url || "";
      return (!best || /^data:/.test(best) || /\.svg$/i.test(best)) ? "" : best;
    } catch { return ""; }
  };
  const currencyToken = (s) => (String(s).match(/[$€£]\s?\d[\d,]*(?:\.\d{2})?/) || [""])[0];
  const $   = (sel) => document.querySelector(sel);
  const txt = (sel) => (document.querySelector(sel)?.textContent || "").trim();

  function extractTitle() {
    return txt('[data-testid="product-title"]') || txt("h1[itemprop='name']") || txt("h1") || document.title;
  }
  function extractBrand() {
    const el =
      document.querySelector('[data-testid*="brand"]') ||
      document.querySelector('a[href*="/brands/"]');
    return el?.textContent?.trim() || "Shopbop";
  }
  function extractPrice() {
    const offer = document.querySelector('[data-testid="product-offer-price"], [data-test="product-offer-price"]');
    if (offer) {
      const tok = currencyToken(offer.textContent);
      if (tok) return tok;
    }
    const compare = document.querySelector('[data-testid*="compare"], [data-test*="compare"], del, s');
    const compareText = compare?.textContent?.trim() || "";
    const priceLike = Array.from(document.querySelectorAll('[class*="Price"], [data-testid*="price"], span, div'))
      .map(el => el.textContent && el.textContent.trim())
      .filter(Boolean)
      .find(t => /[$€£]\s?\d/.test(t) && t !== compareText);
    return currencyToken(priceLike) || "";
  }
  function extractImage() {
    const gallery =
      document.querySelector('img[srcset*="/prod/products/"]') ||
      document.querySelector('img[src*="/prod/products/"]');
    if (gallery) {
      const best = pickBestFromSrcset(gallery.getAttribute("srcset")) || gallery.getAttribute("src") || "";
      if (best) return best;
    }
    const anyImg = document.querySelector("main img, [data-testid*='image'] img, img");
    const src = anyImg?.getAttribute("src") || "";
    if (/p13n\.gif|pixel|1x1|spacer|beacon/i.test(src) || /^data:/.test(src) || /\.svg$/i.test(src)) return "";
    return src;
  }
  function buildItem() {
    return {
      id: location.href,
      title: extractTitle(),
      brand: extractBrand(),
      price: extractPrice(),
      img: extractImage(),
      link: location.href
    };
  }

  // ---------- dual-shot (quick + settled) ----------
  let sentQuick = false, sentSettled = false;
  let lastKey = "", lastAt = 0;
  const debounce = (key, ms) => {
    const now = Date.now(); if (key === lastKey && now - lastAt < ms) return false;
    lastKey = key; lastAt = now; return true;
  };

  function settleThenScrape(timeoutMs = 900) {
    return new Promise((resolve) => {
      let resolved = false;
      const initial = buildItem();
      if (initial.price || initial.img) { resolved = true; return resolve(initial); }

      const timer = setTimeout(() => {
        if (!resolved) { resolved = true; obs.disconnect(); resolve(buildItem()); }
      }, timeoutMs);

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
    if (!isPdp()) { log("skip quick: not PDP"); return; }
    const key = location.href;
    if (!debounce(key, 200)) return;
    const item = buildItem();
    if (!item.title) return;
    log("ADD_ITEM", reason, item);
    sendItemSafe(item);
    sentQuick = true;
  }
  async function sendSettled(reason = "ui-settled") {
    if (sentSettled) return;
    if (!isPdp()) { log("skip settled: not PDP"); return; }
    const key = location.href;
    if (!debounce(key, 600)) { /* allow one more */ }
    const item = await settleThenScrape(900);
    if (!item.title) return;
    log("ADD_ITEM", reason, item);
    sendItemSafe(item);
    sentSettled = true;
  }

  // ---------- explicit Shopbop add buttons + fallback regex ----------
  // Try explicit selectors first (fewer false positives, faster)
  const BUTTON_SELECTORS = [
    'button[data-testid="add-to-cart-button"]',
    '[data-testid="add-to-cart-button"]',
    'button[aria-label*="add to bag" i]',
    'button[aria-label*="add to cart" i]',
    'button:has(span), [role="button"]:has(span)' // fallback; we’ll still verify text below
  ];
  const ADD_TEXT_RE = /\badd to (bag|cart)\b|\bbuy now\b/i;

  function nodeLooksLikeAdd(node) {
    const s = [
      node.textContent || "",
      node.getAttribute?.("aria-label") || "",
      node.getAttribute?.("data-testid") || "",
      node.getAttribute?.("data-test") || "",
      node.getAttribute?.("id") || "",
      node.getAttribute?.("name") || "",
      node.getAttribute?.("class") || ""
    ].join(" ").toLowerCase();
    if (s.includes("adding")) return false;
    return ADD_TEXT_RE.test(s);
  }

  function findAddNodeInPath(e) {
    const path = (e.composedPath && e.composedPath()) || [];
    for (const n of path) {
      if (!n || n.nodeType !== 1) continue;
      if (nodeLooksLikeAdd(n)) return n;
    }
    // selector-based fallback
    for (const sel of BUTTON_SELECTORS) {
      const cand = document.querySelector(sel);
      if (cand && nodeLooksLikeAdd(cand)) return cand;
    }
    return null;
  }

  function earlyHandler(e) {
    const node = findAddNodeInPath(e);
    if (node) sendQuick("ui-quick");
  }
  function lateHandler(e) {
    const node = findAddNodeInPath(e);
    if (node) setTimeout(() => sendSettled("ui-settled"), 140);
  }

  ["mousedown","pointerdown","touchstart"].forEach(t => document.addEventListener(t, earlyHandler, true));
  ["click","pointerup","touchend","submit","keydown"].forEach(t => document.addEventListener(t, lateHandler, true));

  // ---------- SPA reset when URL changes ----------
  let lastHref = location.href;
  const resetIfChanged = () => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      sentQuick = false; sentSettled = false; lastKey = ""; lastAt = 0;
      log("route change → reset");
    }
  };
  setInterval(resetIfChanged, 500);

  // Debug helpers
  window.__UC_SHOPBOP_DEBUG = () => {
    const i = buildItem();
    const pdp = isPdp();
    console.log("[UnifiedCart-Shopbop] DEBUG item", i, "isPdp:", pdp);
    return { pdp, item: i, href: location.href };
  };
  window.__UC_PING = () => {
    try {
      chrome.runtime.sendMessage({ action: "PING" }, (resp) => {
        console.log("[UnifiedCart] PING resp:", resp, "lastError:", chrome.runtime.lastError);
      });
    } catch (e) {
      console.log("[UnifiedCart] PING failed:", e);
    }
  };

  log("loaded (PDP gate+, selectors+, dual-shot, safe-send)");
})();