// Inpage/pageHook.inpage.js
(() => {
  if (window.__UC_HOOK__) return;
  window.__UC_HOOK__ = true;

  // --- SAFETY: Only activate on these hosts ---
  const ALLOW_HOST = /(\.|^)uniqlo\.com$|(\.|^)brooklinen\.com$/i;
  if (!ALLOW_HOST.test(location.hostname.toLowerCase())) return;

  // --- Endpoint signatures (keep tight) ---
  const SHOPIFY_RE = /\/cart\/add(?:\.(?:js|json))?\b/i;                      // Brooklinen
  const SFCC_RE    = /\/Cart-(?:Add|MiniAdd)Product(?:LineItem)?\b/i;         // Uniqlo (SFCC)
  const GENERIC_RE = /(?:^|\/)AddToCart\b/i;

  // Hybris kept for completeness (we're not allowlisting Zara here)
  const HYBRIS_RE  = /\/carts?\/[^/]+\/entries\b/i;

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

    if (SHOPIFY_RE.test(u)) return m === "POST";
    if (SFCC_RE.test(u))    return m === "POST";
    if (GENERIC_RE.test(u)) return true;

    // Hybris-style (extra guard: must carry a qty)
    if (HYBRIS_RE.test(u))  return /^(POST|PUT|PATCH)$/.test(m) && bodyHasQty(body);

    // Last-ditch heuristic: POST to /cart ... add
    if (m === "POST" && /\/cart\b/i.test(u) && /\badd\b/i.test(u)) return true;

    return false;
  }

  // Match genericAddListener.js expectation
  const postHit = (payload) => {
    try {
      window.postMessage(
        { __UC_ADD_HIT: true, source: "UnifiedCartPage", ...payload },
        "*"
      );
    } catch {}
  };

  // ---- fetch hook (non-invasive) ----
  try {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch === "function") {
      window.fetch = function(input, init) {
        const url    = String(input && input.url ? input.url : input || "");
        const method = String((init && init.method) || "GET").toUpperCase();
        const body   = init && init.body;

        const p = nativeFetch.apply(this, arguments);
        if (isAddUrl(url, method, body)) {
          // Only fire on success to avoid false positives
          p.then(res => { if (res && res.ok) postHit({ via: "fetch", url, method, status: res.status }); })
           .catch(() => {});
        }
        return p;
      };
    }
  } catch {}

  // ---- XHR hook (non-invasive) ----
  try {
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const _open = XHR.prototype.open;
      const _send = XHR.prototype.send;

      XHR.prototype.open = function(method, url) {
        try {
          this.__uc_method = String(method || "GET").toUpperCase();
          this.__uc_url    = String(url || "");
          this.addEventListener("load", () => {
            try {
              if (this.status >= 200 && this.status < 400 &&
                  isAddUrl(this.__uc_url, this.__uc_method, this.__uc_body)) {
                postHit({ via: "xhr", url: this.__uc_url, method: this.__uc_method, status: this.status });
              }
            } catch {}
          });
        } catch {}
        return _open.apply(this, arguments);
      };
      XHR.prototype.send = function(body) {
        try { this.__uc_body = body; } catch {}
        return _send.apply(this, arguments);
      };
    }
  } catch {}

  // ---- Form / link fallbacks (e.g., SFCC plain POST forms) ----
  document.addEventListener("submit", (e) => {
    try {
      const form   = e?.target;
      const action = (form && form.action) || location.href;
      const method = String((form && form.method) || "POST").toUpperCase();
      let body = null; try { body = new FormData(form); } catch {}
      if (isAddUrl(action, method, body)) postHit({ via: "submit", url: action, method });
    } catch {}
  }, true);

  document.addEventListener("click", (e) => {
    try {
      const a = e?.target?.closest?.("a[href]");
      if (a && isAddUrl(a.href, "GET", null)) postHit({ via: "link", url: a.href, method: "GET" });
    } catch {}
  }, true);

  try { console.debug("[UnifiedCart] inpage hook active (uniqlo/brooklinen)"); } catch {}
})();