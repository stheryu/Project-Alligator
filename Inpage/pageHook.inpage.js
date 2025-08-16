// Inpage/pageHook.inpage.js
(() => {
  if (window.__UC_HOOK__) return;
  window.__UC_HOOK__ = true;

  const SHOPIFY_RE = /\/cart\/add(?:\.(?:js|json))?\b/i;
  const SFCC_RE    = /\/Cart-(?:Add|MiniAdd)Product(?:LineItem)?\b/i;
  const HYBRIS_RE  = /\/carts?\/[^/]+\/entries\b/i; // Zara
  const GENERIC_RE = /(?:^|\/)AddToCart\b/i;
  const AMZ_RE     = /\/(?:gp\/product\/handle-buy-box|cart\/add-to-cart|gp\/add-to-cart|gp\/item-dispatch)\b/i;

  const isAmazonHost = /\bamazon\./i.test(location.hostname);

  // Amazon: require real Add click shortly before the network call
  const AMZ_ADD_SELECTORS = [
    "#add-to-cart-button","#add-to-cart-button-ubb",
    'input[name="submit.add-to-cart"]',
    'form[action*="handle-buy-box"] [type="submit"]',
    "[data-action='add-to-cart']","[aria-labelledby*='add-to-cart-button']"
  ].join(",");
  let lastAmzAddClickTs = 0;
  document.addEventListener("click", (e) => {
    try { if (e.target?.closest?.(AMZ_ADD_SELECTORS)) lastAmzAddClickTs = Date.now(); } catch {}
  }, true);
  const clickedAmzRecently = (ms = 8000) => (Date.now() - lastAmzAddClickTs) < ms;

  function bodyHasQty(body) {
    try {
      if (!body) return false;
      if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
        const v = body.get("quantity") || body.get("qty") || body.get("quantityToAdd");
        return v && Number(v) > 0;
      }
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        const v = body.get("quantity") || body.get("qty") || body.get("quantityToAdd");
        return v && Number(v) > 0;
      }
      if (typeof body === "string") {
        if (body.includes("=") && body.includes("&")) {
          const sp = new URLSearchParams(body);
          const v = sp.get("quantity") || sp.get("qty") || sp.get("quantityToAdd");
          if (v && Number(v) > 0) return true;
        }
        if (body.trim().startsWith("{")) {
          try {
            const j = JSON.parse(body);
            const v = j?.quantity ?? j?.qty ?? j?.quantityToAdd;
            return v && Number(v) > 0;
          } catch {}
        }
      }
    } catch {}
    return false;
  }

  function isAddUrl(url, method = "GET", body = null) {
    const u = String(url || "");
    const m = String(method || "GET").toUpperCase();

    if (isAmazonHost) {
      return m === "POST" && AMZ_RE.test(u) && clickedAmzRecently();
    }
    if (SHOPIFY_RE.test(u)) return true;
    if (SFCC_RE.test(u)) return true;

    // Hybris (Zara): must be POST/PUT/PATCH and contain quantity
    if (HYBRIS_RE.test(u)) {
      if (!/^(POST|PUT|PATCH)$/.test(m)) return false;
      return bodyHasQty(body);
    }

    if (GENERIC_RE.test(u)) return true;

    if (m === "POST" && /\/cart\b/i.test(u) && /\badd\b/i.test(u)) return true; // avoids “address”
    return false;
  }

  const post = (payload) => { try { window.postMessage({ source: "UnifiedCartPage", type: "ADD_EVENT", ...payload }, "*"); } catch {} };

  // fetch
  const of = window.fetch;
  if (typeof of === "function") {
    window.fetch = async function(input, init) {
      try {
        const url = String(input && input.url ? input.url : input || "");
        const method = String((init && init.method) || "GET").toUpperCase();
        const body = init && init.body;
        if (isAddUrl(url, method, body)) {
          const res = await of.apply(this, arguments);
          Promise.resolve().then(() => post({ via: "fetch", url, method }));
          return res;
        }
      } catch {}
      return of.apply(this, arguments);
    };
  }

  // XHR
  const oo = XMLHttpRequest.prototype.open;
  const os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    try {
      this.__uc_method = String(method || "GET").toUpperCase();
      this.__uc_url = String(url || "");
      this.addEventListener("loadend", () => {
        try { if (isAddUrl(this.__uc_url, this.__uc_method, this.__uc_body)) post({ via: "xhr", url: this.__uc_url, method: this.__uc_method }); } catch {}
      });
    } catch {}
    return oo.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(body) { try { this.__uc_body = body; } catch {} return os.call(this, body); };

  // SFCC forms / link fallbacks
  document.addEventListener("submit", (e) => {
    try {
      const form = e?.target;
      const action = (form && form.action) || location.href;
      const method = String((form && form.method) || "POST").toUpperCase();
      let body = null; try { body = new FormData(form); } catch {}
      if (isAddUrl(action, method, body)) post({ via: "submit", url: action, method });
    } catch {}
  }, true);

  document.addEventListener("click", (e) => {
    try { const a = e?.target?.closest?.("a[href]"); if (a && isAddUrl(a.href, "GET", null)) post({ via: "link", url: a.href, method: "GET" }); } catch {}
  }, true);

  try { console.debug("[UnifiedCart] inpage hook active"); } catch {}
})();