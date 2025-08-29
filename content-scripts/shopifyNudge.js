// content-scripts/shopifyNudge.js
(() => {
  const DEBUG = false;
  const log = (...a) => DEBUG && console.debug("[UC shopify]", ...a);

  // ---- meta scraper (unchanged except your improvements) ----
  function scrapeMeta() {
    const q = (s) => document.querySelector(s);
    const attr = (s, a) => q(s)?.getAttribute(a);
    const text = (s) => (q(s)?.textContent || "").trim();

    let ld = null;
    try {
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        const t = s.textContent?.trim(); if (!t) continue;
        const j = JSON.parse(t); const arr = Array.isArray(j) ? j : [j];
        for (const node of arr) {
          const type = node && (node['@type'] || (Array.isArray(node['@type']) && node['@type'][0]));
          if (/Product/i.test(type || "")) { ld = node; break; }
        }
        if (ld) break;
      }
    } catch {}

    const title =
      attr('meta[property="og:title"]','content') ||
      text('h1.product__title, h1[itemprop="name"], .product-title, .product__title, .ProductMeta__Title') ||
      (ld && (ld.name || ld.title)) || document.title;

    const rawPrice =
      attr('meta[property="product:price:amount"]','content') ||
      attr('meta[itemprop="price"]','content') ||
      (ld && (ld.offers?.price || (Array.isArray(ld.offers) && ld.offers[0]?.price))) ||
      text('[itemprop="price"], .price__current, .product__price, .ProductMeta__Price, .price-item--regular, .price .money');

    const currency =
      attr('meta[property="product:price:currency"]','content') ||
      (ld && (ld.offers?.priceCurrency || (Array.isArray(ld.offers) && ld.offers[0]?.priceCurrency))) ||
      attr('meta[name="shop-currency"]','content') || "USD";

    let price = String(rawPrice || "").trim();
    if (/^\d+(?:\.\d{2})?$/.test(price)) {
      const sym = ({ USD:"$", CAD:"$", AUD:"$", EUR:"€", GBP:"£" }[currency.toUpperCase()] || "");
      price = sym ? `${sym}${price}` : price;
    }

    // image: metas first, then common PDP nodes
    let img =
      attr('meta[property="og:image"]','content') ||
      attr('meta[name="twitter:image"]','content') ||
      attr('img[itemprop="image"]','src');
    if (!img) {
      const el = document.querySelector('.product-media img, .media img, img[srcset], .product__media img');
      if (el?.currentSrc) img = el.currentSrc;
      else if (el?.srcset) img = String(el.srcset).split(/\s*,\s*/).pop()?.split(/\s+/)[0];
      else if (el?.src) img = el.src;
    }

    const brand =
      attr('meta[property="og:site_name"]','content') ||
      (ld && (typeof ld.brand === "string" ? ld.brand : ld.brand?.name)) ||
      (window.Shopify && Shopify.shop) ||
      location.hostname.replace(/^www\./, "");

    return { title, price, img, brand, link: location.href };
  }

  let lastSentAt = 0;
  function sendAdd() {
    const now = Date.now();
    if (now - lastSentAt < 500) return; // debounce
    lastSentAt = now;

    const m = scrapeMeta();
    const item = {
      id:   (m.link || "") + "|shopify",
      pid:  null,
      title:m.title || null,
      brand:m.brand || null,
      price:m.price || null,
      img:  m.img || null,
      link: m.link || null,
      qty:  1
    };
    try { chrome.runtime.sendMessage({ action: "ADD_ITEM", source: "shopify", item }); } catch {}
  }

  // Handle background nudges (live add) + pending nudges (after nav)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action === "SHOPIFY_NETWORK_NUDGE") {
      log("nudge", msg.url);
      setTimeout(sendAdd, 60);
    }
  });

  chrome.runtime.sendMessage({ action: "SHOPIFY_QUERY_PENDING" }, (resp) => {
    try {
      if (resp?.data?.url) {
        log("pending nudge", resp.data.url);
        setTimeout(sendAdd, 120);
      }
    } catch {}
  });

  // Optional safety net if you want (works only in MAIN world)
  const _fetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      const url = typeof input === "string" ? input : input?.url || "";
      const method = (init?.method || (typeof input !== "string" ? input?.method : "") || "GET").toUpperCase();
      if (method === "POST" && /\/cart\/(add(?:\.js)?|add_item|addItem|update(?:\.js)?|change(?:\.js)?)\b/i.test(url)) {
        setTimeout(sendAdd, 0);
      }
    } catch {}
    return _fetch.apply(this, arguments);
  };
})();