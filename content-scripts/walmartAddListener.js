// content-scripts/walmartAddListener.js
(() => {
  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Walmart]", ...a);

  let lastKey = ""; let lastAt = 0;
  function debounceSend(key, ms = 1200) {
    const now = Date.now(); if (key === lastKey && now - lastAt < ms) return false;
    lastKey = key; lastAt = now; return true;
  }

  const get = s => document.querySelector(s);
  const txt = s => get(s)?.textContent?.trim() || "";
  const attr = (s,n) => get(s)?.getAttribute(n) || "";

  function extractViaJSONLD() {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    for (const s of scripts) {
      try {
        const json = JSON.parse(s.textContent.trim());
        const arr = Array.isArray(json) ? json : [json];
        const product = arr.find(x => {
          const t = x && x['@type']; const list = Array.isArray(t) ? t : (t ? [t] : []);
          return list.map(v => String(v).toLowerCase()).includes('product');
        });
        if (product) {
          const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
          return {
            title: product.name || "",
            brand: (product.brand && (product.brand.name || product.brand)) || "",
            price: (offers && (offers.priceCurrency ? `${offers.priceCurrency} ${offers.price}` : offers.price)) || "",
            img: Array.isArray(product.image) ? product.image[0] : product.image || "",
            link: location.href
          };
        }
      } catch(_) {}
    }
    return null;
  }

  function extractTitle() {
    return txt('h1[data-automation-id="product-title"]') || txt("h1[itemprop='name']") || txt("h1") || document.title;
  }

  function extractPrice() {
    const metaPrice = attr('meta[itemprop="price"]', "content");
    const metaCur = attr('meta[itemprop="priceCurrency"]', "content");
    if (metaPrice) return `${metaCur === "USD" || !metaCur ? "$" : metaCur} ${metaPrice}`;

    const offer = txt('[data-automation-id="ppd-new-price"] [aria-hidden="true"]') ||
                  txt('[data-automation-id="product-price"]') ||
                  txt('[data-testid="price"]');
    if (offer) return offer;

    const any = Array.from(document.querySelectorAll('[class*="price"], [data-automation-id*="price"], [data-testid*="price"], span, div'))
      .map(el => el.textContent?.trim())
      .filter(Boolean)
      .find(t => /[$€£]\s?\d/.test(t));
    return any || "";
  }

  function extractImage() {
    const main = get('img[data-automation-id="main-image"]') || get('img[src*="walmartimages"]');
    return main?.getAttribute("src") || main?.src || "";
  }

  function extractBrand() {
    return txt('a[data-automation-id="brand-link"]') || txt("[data-testid='brandName']") || "";
  }

  function buildItem() {
    const viaLD = extractViaJSONLD();
    const fb = {
      title: extractTitle(),
      brand: extractBrand(),
      price: extractPrice(),
      img: extractImage(),
      link: location.href
    };
    const merged = { id: location.href, title: "", brand: "", price: "", img: "", link: location.href };
    Object.assign(merged, fb, viaLD || {});
    return merged;
  }

  function scrapeWithRetries(tries = 6, delay = 180) {
    return new Promise(resolve => {
      const attempt = (n) => {
        const item = buildItem();
        if (item.title && (item.price || item.img) || n <= 0) return resolve(item);
        setTimeout(() => attempt(n-1), delay);
      };
      attempt(tries);
    });
  }

  async function sendItem(reason) {
    const key = location.href;
    if (!debounceSend(key)) { log("debounced"); return; }
    const item = await scrapeWithRetries();
    if (!item.title) return;
    log("ADD_ITEM", reason, item);
    chrome.runtime.sendMessage({ action: "ADD_ITEM", item });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action === "ADD_TRIGGERED") setTimeout(() => sendItem("webRequest"), 120);
  });

  function uiHandler(e) {
    const node = e.target?.closest("button, [role='button'], [aria-label], [data-automation-id], [data-testid]");
    if (!node) return;
    const label = [
      node.textContent || "",
      node.getAttribute?.("aria-label") || "",
      node.getAttribute?.("data-automation-id") || "",
      node.getAttribute?.("data-testid") || ""
    ].join(" ").toLowerCase();
    if (/(add( to)? (cart|bag|basket)|add\b|buy now|checkout)/i.test(label) ||
        /add-to-cart/.test(node.getAttribute?.("data-automation-id") || "")) {
      setTimeout(() => sendItem("ui-click"), 120);
    }
  }
  ["click","pointerup","submit","keydown"].forEach(t => document.addEventListener(t, uiHandler, true));

  console.log("[UnifiedCart-Walmart] loaded");
})();