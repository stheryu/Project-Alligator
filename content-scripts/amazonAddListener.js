// content-scripts/amazonAddListener.js
(() => {
  // Only run in the top page, not inside iframes
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...args) => DEBUG && console.log("[UnifiedCart-Amazon]", ...args);

  // --- de-dupe / throttling per page ---
  let lastKey = ""; let lastAt = 0;
  function debounceSend(key, ms = 1500) {
    const now = Date.now();
    if (key === lastKey && now - lastAt < ms) return false;
    lastKey = key; lastAt = now; return true;
  }

  const $ = (sel) => document.querySelector(sel);
  const txt = (sel) => $(sel)?.textContent?.trim() || "";
  const attr = (sel, name) => $(sel)?.getAttribute(name) || "";

  function getASIN() {
    return (
      $("#ASIN")?.value ||
      $("[data-asin]")?.getAttribute("data-asin") ||
      (location.pathname.match(/\/dp\/([A-Z0-9]{10})/i) || [])[1] ||
      new URLSearchParams(location.search).get("ASIN") ||
      location.href
    );
  }

  function cleanBrand(t) {
    return (t || "")
      .replace(/^Visit the\s+/i, "")
      .replace(/\s+Store$/i, "")
      .replace(/^Brand:\s*/i, "")
      .trim();
  }

  // ---- IMAGE: prefer highest quality, but stable ----
  function extractImage() {
    // 1) High-res if available
    const oldHires = $('img[data-old-hires]')?.getAttribute("data-old-hires");
    if (oldHires) return oldHires;

    // 2) Dynamic image map (pick largest width)
    const dynAttr = $('img[data-a-dynamic-image]')?.getAttribute("data-a-dynamic-image");
    if (dynAttr) {
      try {
        const map = JSON.parse(dynAttr); // {url: [w,h], ...}
        const best = Object.entries(map)
          .map(([url, arr]) => ({ url, w: Number(arr?.[0]) || 0 }))
          .sort((a, b) => b.w - a.w)[0];
        if (best?.url) return best.url;
      } catch {}
    }

    // 3) Landing/wrapper
    const landing = $("#landingImage")?.getAttribute("src");
    if (landing) return landing;
    const wrap = $("#imgTagWrapperId img")?.getAttribute("src");
    if (wrap) return wrap;

    // 4) Fallback: any img
    return $("img")?.getAttribute("src") || "";
  }

  // ---- PRICE: prefer “price to pay”; exclude unit price & list/strike ----
  function extractPrice() {
    // A) The reinvented “price to pay” block (most reliable on modern pages)
    const t1 = txt("#corePrice_feature_div .reinventPriceAccordionT2 .a-offscreen");
    if (t1) return t1;

    // B) Sometimes the "price to pay" uses an aok-offscreen sibling; avoid unit price text (contains "per")
    const offscreenCandidates = Array.from(
      document.querySelectorAll(
        "#corePriceDisplay_desktop_feature_div .aok-offscreen, #corePrice_feature_div .aok-offscreen"
      )
    )
      .map(n => n.textContent?.trim())
      .filter(Boolean)
      .filter(v => /[$€£]\s?\d/.test(v) && !/\bper\b/i.test(v));
    if (offscreenCandidates.length) return offscreenCandidates[0];

    // C) Scan allowed containers but filter out unit price and list/strike price
    const containers = [
      "#corePrice_feature_div",
      "#corePriceDisplay_desktop_feature_div",
      "#apex_desktop",
      "#ppd"
    ];
    for (const cSel of containers) {
      const c = $(cSel);
      if (!c) continue;
      const nodes = Array.from(c.querySelectorAll(".a-price .a-offscreen"));
      const clean = nodes.filter(n =>
        !n.closest(".a-text-price") && // not list/strike
        !n.closest(".pricePerUnit") && // not unit price “per …”
        n.textContent && /[$€£]\s?\d/.test(n.textContent)
      );
      if (clean.length) return clean[0].textContent.trim();
    }

    // D) Last resort: any price on page excluding unit/list patterns
    const any = Array.from(document.querySelectorAll("span.a-price .a-offscreen"))
      .filter(n => !n.closest(".a-text-price") && !n.closest(".pricePerUnit"))
      .map(n => n.textContent?.trim())
      .filter(v => v && /[$€£]\s?\d/.test(v))[0];
    return any || "";
  }

  function extractTitle() {
    return txt("#productTitle") || txt('meta[property="og:title"]') || document.title;
  }

  function extractBrand() {
    return cleanBrand(txt("#bylineInfo") || txt('[data-feature-name="brandByline"]') || "");
  }

  function buildItem() {
    return {
      id: getASIN(),
      title: extractTitle(),
      brand: extractBrand(),
      price: extractPrice(),
      img: extractImage(),
      link: location.href
    };
  }

  function scrapeWithRetries(tries = 8, delay = 160) {
    return new Promise(resolve => {
      const attempt = (n) => {
        const item = buildItem();
        // Require a title and at least price or image (hydration/accordion updates)
        if ((item.title && (item.price || item.img)) || n <= 0) return resolve(item);
        setTimeout(() => attempt(n - 1), delay);
      };
      attempt(tries);
    });
  }

  async function sendItem(reason) {
    const key = getASIN() || location.href;
    if (!debounceSend(key)) { log("debounced"); return; }
    const item = await scrapeWithRetries();
    if (!item.title) { log("No title; skip"); return; }
    log("ADD_ITEM", reason, item);
    chrome.runtime.sendMessage({ action: "ADD_ITEM", item });
  }

  // From background (webRequest trigger)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action === "ADD_TRIGGERED") setTimeout(() => sendItem("webRequest"), 120);
  });

  // UI fallback (in case webRequest misses)
  function uiHandler(e) {
    const node = e.target?.closest(
      "#add-to-cart-button, #add-to-cart-button-ubb, input#add-to-cart-button, button, input[type='submit']"
    );
    if (!node) return;
    const label = (node.textContent || node.value || node.getAttribute?.("aria-label") || "").toLowerCase();
    if (!/add/.test(label) && !node.id?.includes("add-to-cart")) return;
    setTimeout(() => sendItem("ui-click"), 120);
  }
  ["click", "pointerup", "submit", "keydown"].forEach(t => document.addEventListener(t, uiHandler, true));

  console.log("[UnifiedCart-Amazon] loaded");
})();