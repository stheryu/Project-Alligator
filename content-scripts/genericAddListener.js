// content-scripts/genericAddListener.js
(() => {
  // Only run in the TOP frame (avoids ad/analytics iframes)
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Generic]", ...a);

  // ------------ send with fallback ------------
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
    } catch (e) {
      log("storage fallback error", e);
    }
  }
  function sendItemSafe(item) {
    try {
      if (chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ action: "ADD_ITEM", item }, () => {
          if (chrome.runtime?.lastError) {
            // e.g., "Could not establish connection. Receiving end does not exist."
            // or "Extension context invalidated."
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

  // ------------ utils ------------
  const $   = (sel, root = document) => root.querySelector(sel);
  const txt = (sel, root = document) => (root.querySelector(sel)?.textContent || "").trim();
  const attr= (sel, name, root = document) => root.querySelector(sel)?.getAttribute(name) || "";

  const currencyToken = (s) => (String(s).match(/[$€£]\s?\d[\d,]*(?:\.\d{2})?/) || [""])[0];
  const first = (a) => Array.isArray(a) ? a[0] : a;

  // ------------ site detection ------------
  const host = location.hostname;
  const IS_EBAY = /\.ebay\./i.test(host);

  // ------------ PDP filter ------------
  function isEligibleContext() {
    // Generic PDP test: URL has product-y segments OR JSON-LD Product exists
    if (IS_EBAY) {
      // eBay PDPs are usually /itm/<itemId>
      return /\/itm\//.test(location.pathname) || !!parseJSONLDProduct();
    }
    return !!parseJSONLDProduct() || /product|item|buy|detail/i.test(location.pathname);
  }

  // ------------ JSON-LD (generic) ------------
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
        // sometimes inside @graph
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

  // ------------ eBay-specific extraction ------------
  function getEbayItemId() {
    const m = location.pathname.match(/\/itm\/(\d+)/);
    return m ? m[1] : location.href;
  }
  function extractEbay() {
    // Title
    let title = txt("#itemTitle") || txt("h1[itemprop='name']") || txt("h1");
    // eBay sometimes prefixes "Details about  " in #itemTitle with a nested <span>
    if (title) title = title.replace(/^Details about\s+/i, "").trim();

    // Price: try a few known elements and choose the lowest numeric (deal price)
    const priceNodes = [
      "#prcIsum",           // main price
      "#mm-saleDscPrc",     // sale price
      "#convbinPrice",      // converted price
      ".x-price-primary span[itemprop='price']",
      ".notranslate"
    ];
    const prices = priceNodes
      .map(sel => txt(sel))
      .filter(Boolean)
      .map(v => ({ raw: v.trim(), num: parseFloat((v.replace(/[^0-9.]/g, "") || "0")) }))
      .filter(p => p.raw && !Number.isNaN(p.num));

    let price = "";
    if (prices.length) {
      prices.sort((a,b) => a.num - b.num);
      price = prices[0].raw; // pick the smallest "to pay" price
    } else {
      // fallback: scan some text for the first currency token
      price = currencyToken(txt(".x-price-primary") || txt("body"));
    }

    // Image
    const img = attr("#icImg", "src") ||
                attr('meta[property="og:image"]', "content") ||
                $("img")?.src || "";

    // Brand (best-effort)
    let brand = txt("[itemprop='brand']") ||
                txt("div.ux-labels-values__values span.ux-textspans") || // new UX specifics
                txt("h2#viTabs_0_is") || // item specifics section heading
                attr('meta[property="og:site_name"]', 'content') || "eBay";

    // Link + id
    const id = getEbayItemId();

    return {
      id,
      title: title || document.title,
      brand: brand || "eBay",
      price: price || "",
      img: img || "",
      link: location.href
    };
  }

  // ------------ generic extraction (fallback) ------------
  function extractViaOG() {
    const q = (sel) => document.querySelector(sel)?.getAttribute("content") || "";
    const title = q('meta[property="og:title"]') || document.querySelector("h1")?.textContent?.trim() || document.title;
    const img = q('meta[property="og:image"]') || document.querySelector("img")?.src || "";
    let price = q('meta[property="product:price:amount"]') || q('meta[property="og:price:amount"]') || q('meta[name="twitter:data1"]') || "";
    if (!price) {
      const hit = currencyToken(document.body?.innerText || "");
      price = hit || "";
    }
    const brand = q('meta[property="og:site_name"]') || q('meta[name="brand"]') || "";
    return { title, img, price, brand, link: location.href };
  }

  function extractViaJSONLD() {
    const product = parseJSONLDProduct();
    if (!product) return null;
    const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
    return {
      title: product.name || "",
      brand: (product.brand && (product.brand.name || product.brand)) || "",
      price: (offers && (offers.priceCurrency ? `${offers.priceCurrency} ${offers.price}` : offers.price)) || "",
      img: Array.isArray(product.image) ? product.image[0] : product.image || "",
      link: location.href
    };
  }

  function buildItem() {
    if (IS_EBAY) {
      const ebay = extractEbay();
      const ld = extractViaJSONLD();
      // Merge LD (if present) but keep eBay id/title/price when they exist
      return {
        id: ebay.id,
        title: ebay.title || ld?.title || document.title,
        brand: ld?.brand || ebay.brand || "eBay",
        price: ebay.price || ld?.price || "",
        img: ebay.img || ld?.img || "",
        link: ebay.link
      };
    }
    const og = extractViaOG();
    const ld = extractViaJSONLD();
    return Object.assign(
      { id: location.href, title: document.title, brand: "", price: "", img: "", link: location.href },
      og || {},
      ld || {}
    );
  }

  // ------------ dual-shot sending ------------
  let sentQuick = false;
  let sentSettled = false;
  let lastKey = "";
  let lastAt = 0;

  function debounce(key, ms = 800) {
    const now = Date.now();
    if (key === lastKey && now - lastAt < ms) return false;
    lastKey = key; lastAt = now; return true;
    }

  function getProductKey() {
    if (IS_EBAY) return getEbayItemId() || location.href;
    return location.href;
  }

  // Wait for DOM to settle (prices/images often update post-click)
  function settleThenScrape(timeoutMs = 800) {
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
        if (item.price || item.img) {
          clearTimeout(timer); resolved = true; obs.disconnect(); resolve(item);
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    });
  }

  function sendQuick(reason = "ui-quick") {
    if (sentQuick) return;
    const key = getProductKey();
    if (!debounce(key, 200)) return;
    const item = buildItem();
    if (!item.title) return;
    log("ADD_ITEM", reason, item);
    sendItemSafe(item);
    sentQuick = true;
  }

  async function sendSettled(reason = "ui-settled") {
    if (sentSettled) return;
    const key = getProductKey();
    if (!debounce(key, 600)) { /* allow one more */ }
    const item = await settleThenScrape(900);
    if (!item.title) return;
    log("ADD_ITEM", reason, item);
    sendItemSafe(item);
    sentSettled = true;
  }

  // ------------ UI detection ------------
  // Narrower than before; avoid generic “add” to reduce false positives
  const ADD_RE = /\badd to (cart|bag)\b|\bbuy now\b|\bcheckout\b/i;

  function uiLooksLikeAdd(node) {
    const s = [
      node.textContent || "",
      node.getAttribute?.("aria-label") || "",
      node.getAttribute?.("data-testid") || "",
      node.getAttribute?.("data-test") || "",
      node.getAttribute?.("id") || "",
      node.getAttribute?.("name") || "",
      node.getAttribute?.("class") || ""
    ].join(" ").toLowerCase();
    return ADD_RE.test(s);
  }

  function earlyHandler(e) {
    // Fire QUICK snapshot before navigation
    if (!isEligibleContext()) return;
    const node = e.target?.closest?.('button, a, [role="button"], [data-testid], [data-test], [aria-label], input[type="submit"]');
    if (node && uiLooksLikeAdd(node)) sendQuick("ui-quick");
  }
  function lateHandler(e) {
    // Fire SETTLED snapshot after UI updates
    if (!isEligibleContext()) return;
    const node = e.target?.closest?.('button, a, [role="button"], [data-testid], [data-test], [aria-label], input[type="submit"]');
    if (node && uiLooksLikeAdd(node)) setTimeout(() => sendSettled("ui-settled"), 140);
  }

  ["mousedown","pointerdown","touchstart"].forEach(t => document.addEventListener(t, earlyHandler, true));
  ["click","pointerup","touchend","submit","keydown"].forEach(t => document.addEventListener(t, lateHandler, true));

  // ------------ optional pageHook (no-op if not present) ------------
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (d && d.source === "UnifiedCartPage" && d.type === "ADD_EVENT") {
      setTimeout(() => { if (isEligibleContext()) sendSettled("pageHook-" + (d.via || "unknown")); }, 150);
    }
  });

  log("loaded (top-frame, dual-shot, safe-send)");
})();