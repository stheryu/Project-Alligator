// content-scripts/genericAddListener.js
(() => {
  const DEBUG = true;
  const log = (...args) => DEBUG && console.log("[UnifiedCart-Generic]", ...args);
  const ADD_BTN_RE = /(add( to)? (cart|bag|basket)|add to shopping|buy now|checkout|add item|add\b)/i;

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
      } catch (_) {}
    }
    return null;
  }

  function extractViaOG() {
    const q = (sel) => document.querySelector(sel)?.getAttribute("content") || "";
    const title = q('meta[property="og:title"]') || document.querySelector("h1")?.textContent?.trim() || document.title;
    const img = q('meta[property="og:image"]') || document.querySelector("img")?.src || "";
    let price = q('meta[property="product:price:amount"]') || q('meta[property="og:price:amount"]') || q('meta[name="twitter:data1"]') || "";
    if (!price) {
      const txts = Array.from(document.querySelectorAll("body *")).slice(0, 400).map(el => el.textContent?.trim()).filter(Boolean);
      const hit = txts.find(t => /[$€£]\s?\d/.test(t));
      price = hit ? (hit.match(/[$€£]\s?\d[\d,]*(?:\.\d{2})?/)?.[0] || "") : "";
    }
    const brand = q('meta[property="og:site_name"]') || q('meta[name="brand"]') || "";
    return { title, img, price, brand, link: location.href };
  }

  function extractItem() {
    const viaLD = extractViaJSONLD();
    const viaOG = extractViaOG();
    const item = { id: location.href, title: "", brand: "", price: "", img: "", link: location.href };
    Object.assign(item, viaOG || {});
    Object.assign(item, viaLD || {});
    if (!item.title) item.title = document.title;
    return item;
  }

  function onAddAttempt(reason) {
    const item = extractItem();
    if (!item || !item.title) return log("Extraction failed", reason);
    log("Sending ADD_ITEM", reason, item);
    chrome.runtime.sendMessage({ action: "ADD_ITEM", item });
  }

  // From pageHook (network)
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (d && d.source === "UnifiedCartPage" && d.type === "ADD_EVENT") {
      log("pageHook add via", d.via);
      setTimeout(() => onAddAttempt("pageHook-" + d.via), 150);
    }
  });

  // UI fallback
  function uiHandler(e) {
    const node = e.target?.closest('button, a, [role="button"], [data-testid], [data-test], [aria-label]');
    if (!node) return;
    const textBits = [
      node.textContent || "",
      node.getAttribute?.("aria-label") || "",
      node.getAttribute?.("data-testid") || "",
      node.getAttribute?.("data-test") || ""
    ].join(" ").toLowerCase();
    if (ADD_BTN_RE.test(textBits)) setTimeout(() => onAddAttempt("ui-click"), 150);
  }
  ["click", "pointerup", "submit"].forEach((t) => document.addEventListener(t, uiHandler, true));

  console.log("[UnifiedCart-Generic] loaded");
})();