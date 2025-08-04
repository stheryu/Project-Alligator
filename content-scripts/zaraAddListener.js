// content-scripts/zaraAddListener.js
(() => {
  // Run only in the top page (avoid iframes)
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[UnifiedCart-Zara]", ...a);

  // --- de-dupe per page ---
  let lastKey = "", lastAt = 0;
  function debounceSend(key, ms = 2500) {
    const now = Date.now();
    if (key === lastKey && now - lastAt < ms) return false;
    lastKey = key; lastAt = now; return true;
  }

  const $  = (sel) => document.querySelector(sel);
  const txt = (sel) => $(sel)?.textContent?.trim() || "";
  const attr = (sel, name) => $(sel)?.getAttribute(name) || "";

  // ===== field extractors =====
  function pickBestFromSrcset(ss) {
    if (!ss) return "";
    try {
      return ss.split(",")
        .map(s => s.trim())
        .map(p => {
          const [url, w] = p.split(/\s+/);
          return { url, w: parseInt((w||"").replace(/\D/g, ""), 10) || 0 };
        })
        .sort((a,b) => b.w - a.w)[0]?.url || "";
    } catch { return ""; }
  }

  function extractTitle() {
    const og = attr('meta[property="og:title"]', 'content');
    return og || txt("h1") || document.title;
  }

  function extractImage() {
    const og = attr('meta[property="og:image"]', 'content');
    if (og) return og;
    const img = document.querySelector("picture img") || document.querySelector("img");
    if (!img) return "";
    const ss = img.getAttribute("srcset");
    const best = pickBestFromSrcset(ss);
    return best || img.getAttribute("src") || img.src || "";
  }

  function extractPrice() {
    // Prefer schema/meta when present
    const metaPrice = attr('meta[itemprop="price"]', 'content')
                   || attr('meta[property="product:price:amount"]', 'content')
                   || attr('meta[property="og:price:amount"]', 'content');
    const metaCur   = attr('meta[itemprop="priceCurrency"]', 'content')
                   || attr('meta[property="product:price:currency"]', 'content');
    if (metaPrice) {
      const sym = !metaCur || metaCur === "USD" ? "$" : metaCur;
      return `${sym} ${metaPrice}`;
    }

    // Fallback: scan likely product containers first
    const containers = ['main', '[data-qa*="product"]', '[data-qa*="detail"]', 'body'];
    for (const cSel of containers) {
      const c = document.querySelector(cSel);
      if (!c) continue;
      const hit = Array.from(c.querySelectorAll("span, div, p, strong, b"))
        .map(n => n.textContent?.trim())
        .filter(Boolean)
        .find(t => /[$€£]\s?\d/.test(t));
      if (hit) return hit;
    }
    return "";
  }

  function buildItem() {
    return {
      id: location.href,
      title: extractTitle(),
      brand: "ZARA",
      price: extractPrice(),
      img: extractImage(),
      link: location.href
    };
  }

  function scrapeWithRetries(tries = 8, delay = 150) {
    return new Promise(resolve => {
      const attempt = (n) => {
        const item = buildItem();
        // Require title and at least price or image
        if ((item.title && (item.price || item.img)) || n <= 0) return resolve(item);
        setTimeout(() => attempt(n - 1), delay);
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

  // ===== UI detection (no background trigger needed) =====
  function looksLikeAdd(node) {
    if (!node) return false;
    const fields = [
      node.textContent || "",
      node.getAttribute?.("aria-label") || "",
      node.getAttribute?.("data-qa") || "",
      node.getAttribute?.("data-testid") || "",
      node.getAttribute?.("id") || "",
      node.getAttribute?.("name") || "",
      node.getAttribute?.("class") || ""
    ].join(" ").toLowerCase();
    // catch: add, add to bag/cart, buy now, checkout
    return /(add( to)? (bag|cart)|add\b|buy now|checkout)/i.test(fields);
  }

  function uiHandler(e) {
    const node = e.target?.closest("button, [role='button'], [data-qa], [aria-label], a");
    if (!node) return;
    if (!looksLikeAdd(node)) return;
    // Small delay so Zara updates DOM
    setTimeout(() => sendItem("ui-click"), 150);
  }
  ["click", "pointerup", "submit", "keydown"].forEach(t =>
    document.addEventListener(t, uiHandler, true)
  );

  console.log("[UnifiedCart-Zara] simple UI listener loaded");
})();