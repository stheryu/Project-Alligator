// content-scripts/shopbopAddListener.js
(() => {
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Shopbop]", ...a);

  // --- de-dupe / throttling per page ---
  let lastSentKey = "";
  let lastSentAt = 0;
  let lastUIClickAt = 0;

  function debounceSend(key, windowMs = 4000) {
    const now = Date.now();
    if (key === lastSentKey && now - lastSentAt < windowMs) return false;
    lastSentKey = key;
    lastSentAt = now;
    return true;
  }

  // Tightened: remove generic "add" catch-all to reduce false positives
  const ADD_BTN_RE = /(add( to)? (cart|bag|basket)|buy now|checkout|add item)/i;

  function pickBestFromSrcset(ss) {
    if (!ss) return "";
    try {
      const parts = ss.split(",").map(s => s.trim());
      const candidates = parts
        .map(p => {
          const [url, w] = p.split(/\s+/);
          const width = parseInt((w || "").replace(/[^0-9]/g, ""), 10) || 0;
          return { url, width };
        })
        .sort((a, b) => b.width - a.width);
      const best = candidates[0]?.url || "";
      return best.startsWith("data:") ? "" : best;
    } catch {
      return "";
    }
  }

  const text = sel => document.querySelector(sel)?.textContent?.trim() || "";

  function extractImage() {
    const galleryImg =
      document.querySelector('img[srcset*="/prod/products/"]') ||
      document.querySelector('img[src*="/prod/products/"]');
    if (galleryImg) {
      const ss = galleryImg.getAttribute("srcset");
      const best = pickBestFromSrcset(ss) || galleryImg.getAttribute("src") || "";
      if (best && !best.startsWith("data:")) return best;
    }
    const anyImg = document.querySelector("main img, [data-testid*='image'] img, img");
    const src = anyImg?.getAttribute("src") || "";
    if (/p13n\.gif|pixel|1x1|spacer|beacon/i.test(src) || src.startsWith("data:") || src.endsWith(".svg"))
      return "";
    return src;
  }

  function extractPrice() {
    const offer = document.querySelector(
      '[data-testid="product-offer-price"], [data-test="product-offer-price"]'
    );
    if (offer) return offer.textContent.trim();
    const compare = document.querySelector(
      '[data-testid*="compare"], [data-test*="compare"], del, s'
    );
    const compareText = compare?.textContent?.trim() || "";
    const priceLike = Array.from(
      document.querySelectorAll('[class*="Price"], [data-testid*="price"], span, div')
    )
      .map(el => el.textContent && el.textContent.trim())
      .filter(Boolean)
      .find(t => /[$€£]\s?\d/.test(t) && t !== compareText);
    return priceLike || "";
  }

  function extractBrand() {
    const brandEl =
      document.querySelector('[data-testid*="brand"]') ||
      document.querySelector('a[href*="/brands/"]');
    return brandEl?.textContent?.trim() || "";
  }

  function extractTitle() {
    return text('[data-testid="product-title"], h1, [itemprop="name"]') || document.title;
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

  function scrapeWithRetries(tries = 8, delay = 150) {
    return new Promise(resolve => {
      const attempt = n => {
        const item = buildItem();
        if ((item.title && (item.price || item.img)) || n <= 0) return resolve(item);
        setTimeout(() => attempt(n - 1), delay);
      };
      attempt(tries);
    });
  }

  async function sendItem(reason) {
    const key = location.href;
    if (!debounceSend(key)) { log("debounced", reason); return; }
    const item = await scrapeWithRetries();
    if (!item.title) { log("No title; skip"); return; }
    log("ADD_ITEM", reason, item);
    chrome.runtime.sendMessage({ action: "ADD_ITEM", item });
  }

  // --- Event wiring ---
  function uiHandler(e) {
    const node = e.target?.closest(
      'button, a, [role="button"], [data-testid], [data-test], [aria-label]'
    );
    if (!node) return;

    const textBits = [
      node.textContent || "",
      node.getAttribute?.("aria-label") || "",
      node.getAttribute?.("data-testid") || "",
      node.getAttribute