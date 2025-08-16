// Inpage/pageHook.zara.inpage.js — Zara only: tighten intent + qty + shorter window + ignore variant widgets
(() => {
  if (!/(\.|^)zara\.com$/i.test(location.hostname)) return;
  if (window.__UC_HOOK_ZARA__) return;
  window.__UC_HOOK_ZARA__ = true;

  const HYBRIS_RE = /\/carts?\/[^/]+\/entries\b/i;
  const BAG_RE    = /\/(?:shopping-?bag|bag)\/entries?\b/i;
  const GQL_RE    = /\/graphql\b/i;

  // ----- CTA intent (strict, short window) -----
  const IGNORE_INTENT_CONTAINER = [
    '[data-testid*="color"]','[class*="color"]','[data-qa*="color"]',
    '[data-testid*="size"]','[class*="size"]','[data-qa*="size"]',
    'header','nav','footer'
  ].join(',');
  let lastAddTs = 0;
  const INTENT_MS = 3500;

  document.addEventListener("click", (e) => {
    try {
      const el = e.target?.closest?.('button, [role="button"], input[type="submit"], a');
      if (!el) return;
      if (el.closest(IGNORE_INTENT_CONTAINER)) return; // ignore color/size/nav clicks

      const txt = (el.textContent || el.getAttribute("aria-label") || "").toLowerCase();
      const idc = ((el.id || "") + " " + (el.className || "")).toLowerCase();
      // must mention "add" AND "(cart|bag)"
      const looksAdd = /(add).*(cart|bag|basket)/.test(txt)
                    || /(add[-\s]?to[-\s]?(cart|bag)|addtobag|addtocart)/.test(txt)
                    || /(addtobag|addtocart)/.test(idc);
      if (looksAdd) lastAddTs = Date.now();
    } catch {}
  }, true);

  const clickedAddRecently = () => (Date.now() - lastAddTs) < INTENT_MS;

  // ----- helpers -----
  const qtyInQuery = (url) => {
    try {
      const sp = new URL(url, location.href).searchParams;
      const v = sp.get("quantity") || sp.get("qty") || sp.get("quantityToAdd");
      return v && Number(v) > 0;
    } catch { return false; }
  };
  const bodyHasQty = (body) => {
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
        if (body.includes("=")) {
          const sp = new URLSearchParams(body);
          const v = sp.get("quantity") || sp.get("qty") || sp.get("quantityToAdd");
          if (v && Number(v) > 0) return true;
        }
        const t = body.trim();
        if (t.startsWith("{") || t.startsWith("[")) {
          try {
            const j = JSON.parse(t);
            const v = j?.quantity ?? j?.qty ?? j?.quantityToAdd ?? j?.variables?.quantity ?? j?.input?.quantity;
            return v && Number(v) > 0;
          } catch {}
        }
      }
    } catch {}
    return false;
  };
  function normFetchArgs(input, init) {
    let url = "", method = "GET", body = null;
    try {
      if (input && typeof input === "object" && "url" in input) { // Request object
        url = String(input.url || "");
        method = String(input.method || method).toUpperCase();
      } else {
        url = String(input || "");
      }
      if (init) {
        if (init.method) method = String(init.method).toUpperCase();
        if ("body" in init) body = init.body;
      }
    } catch {}
    return { url, method, body };
  }

  function isZaraAdd(url, method, body) {
    const u = String(url || "");
    const m = String(method || "GET").toUpperCase();
    if (!clickedAddRecently()) return false;

    // Hybris/bag: must be POST/PUT/PATCH + qty present
    if ((HYBRIS_RE.test(u) || BAG_RE.test(u)) && /^(POST|PUT|PATCH)$/.test(m)) {
      return qtyInQuery(u) || bodyHasQty(body);
    }
    // GraphQL: mutation name contains add + has quantity
    if (GQL_RE.test(u) && m === "POST" && typeof body === "string") {
      const t = body.toLowerCase();
      const mentions = t.includes("addtobag") || t.includes("addtocart") || t.includes("cartadd") || t.includes("addcartitem");
      const hasQty = /"quantity"\s*:\s*(\d+)/.test(t);
      return mentions && hasQty;
    }
    return false;
  }

  const post = (payload) => { try { window.postMessage({ source: "UnifiedCartPage", type: "ADD_EVENT", ...payload }, "*"); } catch {} };

  // fetch
  const of = window.fetch;
  if (typeof of === "function") {
    window.fetch = async function(input, init) {
      try {
        const { url, method, body } = normFetchArgs(input, init);
        if (isZaraAdd(url, method, body)) {
          const res = await of.apply(this, arguments);
          Promise.resolve().then(() => post({ via: "fetch", url, method }));
          return res;
        }
      } catch {}
      return of.apply(this, arguments);
    };
  }
  // XHR
  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    try {
      this.__uc_m = String(method || "GET").toUpperCase();
      this.__uc_u = String(url || "");
      this.addEventListener("loadend", () => {
        try { if (isZaraAdd(this.__uc_u, this.__uc_m, this.__uc_b)) post({ via: "xhr", url: this.__uc_u, method: this.__uc_m }); } catch {}
      });
    } catch {}
    return oo.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body){ try { this.__uc_b = body; } catch {} return os.apply(this, arguments); };

  try { console.debug("[UnifiedCart] Zara hook active"); } catch {}
})();