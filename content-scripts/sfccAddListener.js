// content-scripts/sfccAddListener.js
(() => {
  // Prevent double registration if multiple content_script blocks match
  if (window.__UC_SFCC_CS__) return;
  window.__UC_SFCC_CS__ = true;

  // Never run SFCC hook logic on Hybris hosts
  const H = location.hostname;
  if (
    /(^|\.)zara\.com$/i.test(H) ||
    /(^|\.)mango\.com$/i.test(H) ||
    /(^|\.)shop\.mango\.com$/i.test(H)
  ) return;

  const INPAGE_PATH = "Inpage/pageHook.sfcc.inpage.js";
  const FORCE_HOSTS = [/\.jcrew\.com$/i, /\.jcrewfactory\.com$/i, /\.abercrombie\.com$/i, /\.hollisterco\.com$/i, /\.anf\.com$/i];

  const looksLikeSFCC = () => {
    try {
      const hasStatic  = [...document.scripts].some(s => /on\/demandware\.static\//i.test(s.src || ""));
      const hasForms   = !!document.querySelector('form[action*="/on/demandware.store/"]');
      const hasCookies = /dwsid|dwpersonalization|dwanonymous/i.test(document.cookie || "");
      return hasStatic || hasForms || hasCookies;
    } catch { return false; }
  };

  const injectInpage = () => {
    if (document.documentElement.dataset.alSfccInjected === "1") return false;
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL(INPAGE_PATH);
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    document.documentElement.dataset.alSfccInjected = "1";
    s.remove();
    return true;
  };

  const hostBrand = (host) => {
    host = String(host || "").toLowerCase();
    if (/\bjcrewfactory\.com$/.test(host)) return "J.Crew Factory";
    if (/\bjcrew\.com$/.test(host))        return "J.Crew";
    if (/\babercrombie\.com$/.test(host))  return "Abercrombie";
    if (/\bhollisterco\.com$/.test(host))  return "Hollister Co.";
    if (/\banf\.com$/.test(host))          return "Abercrombie";
    return null;
  };

  const firstMoney = (s) => {
    // Grab first $12.34 (or 12.34) in a string
    if (!s) return "";
    const m = String(s).match(/(?:\$?\s*)\d{1,3}(?:[,\s]\d{3})*(?:\.\d{2})?/);
    return m ? m[0].replace(/\s+/g, "").replace(/^\$/, "$") : "";
  };

  function scrapeMeta() {
    const q = (sel) => document.querySelector(sel);
    const text = (sel) => q(sel)?.textContent?.trim();
    const attr = (sel, a) => q(sel)?.getAttribute(a);
    let ld = null;

    // Try to locate a Product node in any ld+json block
    try {
      for (const b of document.querySelectorAll('script[type="application/ld+json"]')) {
        const t = b.textContent?.trim(); if (!t) continue;
        let j;
        try { j = JSON.parse(t); } catch { continue; }
        const arr = Array.isArray(j) ? j : [j];
        for (const node of arr) {
          const tpe = node && (node['@type'] || (Array.isArray(node['@type']) && node['@type'][0]));
          if (tpe && /Product/i.test(String(tpe))) { ld = node; break; }
          // Some sites nest: { "@graph": [ ... ] }
          if (!ld && node && Array.isArray(node['@graph'])) {
            for (const g of node['@graph']) {
              const gt = g && (g['@type'] || (Array.isArray(g['@type']) && g['@type'][0]));
              if (gt && /Product/i.test(String(gt))) { ld = g; break; }
            }
          }
        }
        if (ld) break;
      }
    } catch {}

    const title =
      attr('meta[property="og:title"]', 'content') ||
      text('h1.product-name, h1[itemprop="name"], .product-name, .pdp-product-name, .product-detail > h1, [data-test*="product-name"]') ||
      (ld && (ld.name || ld.title)) ||
      document.title;

    // Price: try meta + ld; then DOM fallbacks including data-test hooks
    let price =
      attr('meta[itemprop="price"]', 'content') ||
      attr('meta[property="product:price:amount"]', 'content') ||
      (ld && (ld.offers?.price || (Array.isArray(ld.offers) && ld.offers[0]?.price))) ||
      text('[itemprop="price"], .product-price .price, .price .value, [data-price], .sales .value, .price__sales, [data-test*="price"], [data-test*="Price"], .prices .price, .pdp-price, .pdp__price');

    if (!price) {
      // As a last resort parse any $12.34-looking string on common price containers
      const maybe = text('.product-price, .pdp-price, [data-test*="price"], [class*="price"]');
      price = firstMoney(maybe);
    }
    price = String(price || "").trim();

    const img =
      attr('meta[property="og:image"]', 'content') ||
      attr('img[itemprop="image"], .primary-image img, .pdp-main-image img, .product-image img, [data-test*="image"] img', 'src') ||
      (ld && (Array.isArray(ld.image) ? ld.image[0] : ld.image)) || "";

    const brand =
      attr('meta[property="og:brand"]', 'content') ||
      text('[itemprop="brand"], .product-brand, .brand-name') ||
      (ld && (typeof ld.brand === "string" ? ld.brand : ld.brand?.name)) ||
      attr('meta[property="og:site_name"]', 'content') ||
      hostBrand(location.hostname) || null;

    const isLikelyPdp =
      !!(ld && /Product/i.test(ld['@type'] || "")) ||
      !!q('button[type="submit"][name*="add"], [data-test*="add-to-bag"], [data-test*="AddToBag"], [aria-label*="Add to Bag"], [aria-label*="Add to Cart"]') ||
      !!price;

    return {
      title,
      price,
      img,
      brand,
      link: location.href,
      isLikelyPdp
    };
  }

  function sendAdd(payload) {
    const meta = scrapeMeta();
    const pid = payload?.pid ? String(payload.pid) : null;
    const qty = Number(payload?.quantity || 1);

    // Guard: if we don’t have a pid and we failed to find a price (likely a category/landing page), skip.
    if (!pid && !meta.price) {
      console.debug("[UC sfcc] skip add (no pid & no price)", meta.title);
      return;
    }

    const item = {
      id: pid || (meta.link || "") + "|sfcc",
      pid,
      title: meta.title || null,
      brand: meta.brand || null,
      price: meta.price || null,
      img: meta.img || null,
      link: meta.link || null,
      qty: qty > 0 ? qty : 1
    };

    console.debug("[UC sfcc] sendAdd", item);
    try { chrome.runtime.sendMessage({ action: "ADD_ITEM", source: "sfcc", item }); } catch {}
  }

  // ---- Decide + inject in-page hook (best-effort) ----
  try {
    if (FORCE_HOSTS.some(rx => rx.test(H)) || looksLikeSFCC()) {
      injectInpage();
    }
  } catch {}

  // ---- ALWAYS ask for pending SFCC nudge on likely/known SFCC pages ----
  const SHOULD_ASK_PENDING = FORCE_HOSTS.some(rx => rx.test(H)) || looksLikeSFCC();
  if (SHOULD_ASK_PENDING) {
    const ask = () => chrome.runtime.sendMessage({ action: "SFCC_QUERY_PENDING" }, (resp) => {
      const data = resp && resp.data;
      if (data && (data.pid || data.quantity)) sendAdd({ pid: data.pid, quantity: data.quantity });
    });
    try { ask(); setTimeout(() => { try { ask(); } catch {} }, 250); } catch {}
  }

  // ---- Relay from in-page SFCC hook → background ----
  window.addEventListener("message", (ev) => {
    const data = ev?.data;
    if (!data || data.__from !== "alligator-sfcc") return;
    if (data.type === "SFCC_ADD_TO_CART" && data.payload) sendAdd(data.payload);
  });

  // ---- Respond to background network nudges ----
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action === "SFCC_NETWORK_NUDGE" && msg.data) {
      const { pid, quantity } = msg.data;
      sendAdd({ pid, quantity });
    }
  });
})();