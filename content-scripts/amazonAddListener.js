// content-scripts/amazonAddListener.js
(() => {
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Amazon]", ...a);

  let lastKey = "", lastAt = 0, lastUIClickAt = 0;
  function debounceSend(key, ms = 1500) {
    const now = Date.now();
    if (key === lastKey && now - lastAt < ms) return false;
    lastKey = key; lastAt = now; return true;
  }

  // --- robust sender ---
  function saveToStorageDirect(item) {
    try {
      chrome.storage.sync.get({ cart: [] }, (res) => {
        let items = Array.isArray(res.cart) ? res.cart : [];
        const id = String(item.id || ""); const link = String(item.link || "");
        items = items.filter(it => String(it.id||"") !== id && String(it.link||"") !== link);
        items.push(item);
        chrome.storage.sync.set({ cart: items });
      });
    } catch (e) { log("storage fallback error", e); }
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
    } catch (e) { log("sendItemSafe exception → fallback:", e); saveToStorageDirect(item); }
  }

  const $ = (s) => document.querySelector(s);
  const txt = (s) => $(s)?.textContent?.trim() || "";
  const attr = (s, n) => $(s)?.getAttribute(n) || "";

  function getASIN() {
    return (
      $("#ASIN")?.value ||
      $("[data-asin]")?.getAttribute("data-asin") ||
      (location.pathname.match(/\/dp\/([A-Z0-9]{10})/i) || [])[1] ||
      new URLSearchParams(location.search).get("ASIN") ||
      location.href
    );
  }

  function cleanBrand(t="") {
    return t.replace(/^Visit the\s+/i, "")
            .replace(/\s+Store$/i, "")
            .replace(/^Brand:\s*/i, "")
            .trim();
  }

  // --- IMAGE: old-hires → dynamic → landing/wrapper ---
  function extractImage() {
    const oldHires = $('img[data-old-hires]')?.getAttribute("data-old-hires");
    if (oldHires) return oldHires;

    const dyn = $('img[data-a-dynamic-image]')?.getAttribute("data-a-dynamic-image");
    if (dyn) {
      try {
        const map = JSON.parse(dyn); // {url: [w,h], ...}
        const best = Object.entries(map)
          .map(([url, size]) => ({ url, w: Number(size?.[0]) || 0 }))
          .sort((a,b) => b.w - a.w)[0];
        if (best?.url) return best.url;
      } catch {}
    }

    const landing = $("#landingImage")?.getAttribute("src");
    if (landing) return landing;
    const wrap = $("#imgTagWrapperId img")?.getAttribute("src");
    if (wrap) return wrap;
    return $("img")?.getAttribute("src") || "";
  }

  // --- PRICE: JSON-LD → “to pay” → known containers (filter out unit/strike) ---
  function extractPrice() {
    try {
      const blocks = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .map(s => { try { return JSON.parse(s.textContent.trim()); } catch { return null; } })
        .filter(Boolean);
      const flat = blocks.flat ? blocks.flat() : [].concat(...blocks);
      const arr = Array.isArray(flat) ? flat : [flat];
      const product = arr.find(x => {
        const t = x && x['@type']; const list = Array.isArray(t) ? t : (t ? [t] : []);
        return list.map(v => String(v).toLowerCase()).includes('product');
      });
      if (product?.offers?.price) {
        const cur = product.offers.priceCurrency || "USD";
        return `${cur === "USD" ? "$" : cur} ${product.offers.price}`;
      }
    } catch {}

    // explicit "price to pay"
    const p1 = txt("#corePrice_feature_div .reinventPriceAccordionT2 .a-offscreen");
    if (p1) return p1;

    const containers = [
      "#corePriceDisplay_desktop_feature_div",
      "#corePrice_feature_div",
      "#apex_desktop",
      "#ppd",
      "#centerCol",
      "#buybox"
    ];
    for (const cSel of containers) {
      const c = document.querySelector(cSel);
      if (!c) continue;
      const nodes = Array.from(c.querySelectorAll(".a-price .a-offscreen"));
      const clean = nodes.filter(n =>
        !n.closest(".a-text-price, .priceBlockStrikePriceString, del, s") &&
        !n.closest(".pricePerUnit, .basisPriceLegalMessage, .a-size-mini") &&
        /[$€£]\s?\d/.test(n.textContent)
      );
      if (clean.length) {
        const nums = clean.map(n => {
          const m = n.textContent.replace(/[, ]/g, "").match(/([€£$])\s?(\d+(?:\.\d{2})?)/);
          return m ? { raw: n.textContent.trim(), num: parseFloat(m[2]) } : null;
        }).filter(Boolean);
        if (nums.length) return nums.sort((a,b) => a.num - b.num)[0].raw; // deal price
      }
    }

    const any = Array.from(document.querySelectorAll("#centerCol span.a-price .a-offscreen"))
      .filter(n => !n.closest(".a-text-price, .priceBlockStrikePriceString, .pricePerUnit"))
      .map(n => n.textContent?.trim())
      .find(v => v && /[$€£]\s?\d/.test(v));
    return any || "";
  }

  function extractTitle() {
    return txt("#productTitle") || txt("#titleSection") || txt('meta[property="og:title"]') || document.title;
  }
  function extractBrand() {
    return cleanBrand(
      txt("#bylineInfo") ||
      txt('[data-feature-name="brandByline"]') ||
      txt("#brand") ||
      ""
    );
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

  function scrapeWithRetries(tries = 12, delay = 120) {
    return new Promise(resolve => {
      const attempt = (n) => {
        const it = buildItem();
        if ((it.title && (it.price || it.img)) || n <= 0) return resolve(it);
        setTimeout(() => attempt(n - 1), delay);
      };
      attempt(tries);
    });
  }

  async function sendItem(reason) {
    const key = getASIN() || location.href;
    if (!debounceSend(key)) { log("debounced"); return; }
    const item = await scrapeWithRetries();
    if (!item.title) return;
    log("ADD_ITEM", reason, item);
    sendItemSafe(item);
  }

  // Gate network triggers: only after a real Add click recently
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action === "ADD_TRIGGERED") {
      if (Date.now() - lastUIClickAt <= 2500) {
        setTimeout(() => sendItem("webRequest-after-click"), 120);
      } else {
        log("ignore webRequest (no recent UI click)", msg.url);
      }
    }
  });

  // UI detection
  function uiHandler(e) {
    const node = e.target?.closest(
      "#add-to-cart-button, #add-to-cart-button-ubb, input#add-to-cart-button, #buy-now-button, button, input[type='submit']"
    );
    if (!node) return;
    const label = (node.textContent || node.value || node.getAttribute?.("aria-label") || "").toLowerCase();
    if (!/add|buy now/.test(label) && !node.id?.includes("add-to-cart")) return;
    lastUIClickAt = Date.now();
    setTimeout(() => sendItem("ui-click"), 140);
  }
  ["click","mousedown","pointerup","touchend","submit","keydown"].forEach(t =>
    document.addEventListener(t, uiHandler, true)
  );

  console.log("[UnifiedCart-Amazon] stabilized listener loaded");
})();