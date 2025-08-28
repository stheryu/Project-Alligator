// Inpage/pageHook.sfcc.inpage.js  (runs in page context)
(() => {
  if (window.__ALLIGATOR_SFCC_HOOKED__) return;
  window.__ALLIGATOR_SFCC_HOOKED__ = true;

  const DEBUG = false;
  const dbg = (...a) => { if (DEBUG) try { console.debug("[SFCC hook]", ...a); } catch {} };

  const SRC_TAG = "alligator-sfcc";

  // Classic controller (Cart-AddProduct, AddToCart, ProductList-AddProduct)
  const RE_SFCC_CLASSIC =
    /\/on\/demandware\.store\/.*\/(?:Cart-(?:Add|AddMultiple)Product|AddToCart|ProductList-AddProduct)\b/i;

  // OCAPI (dw/shop/vXX[_YY]/baskets/{id}/items) – also allow "/s/-/" prefix
  const RE_OCAPI_ITEMS =
    /\/(?:s\/-\/)?dw\/shop\/v\d+(?:_\d+)?\/baskets\/[^/]+\/items\b/i;

  // SCAPI – cover:
  //  - /api/checkout/vX[.Y]?/baskets/{id}/items
  //  - /api/checkout/vX[.Y]?/baskets/current/items
  //  - /api/checkout/vX[.Y]?/baskets/{id}/shipments/{m}/items
  //  - /api/checkout/vX[.Y]?/baskets/{id}/line-items
  const RE_SCAPI_ITEMS =
    /\/api\/checkout\/v\d+(?:\.\d+)?\/baskets\/[^/]+(?:\/shipments\/[^/]+)?\/(?:items|line-items)\b/i;

  function isSfccFormAction(url) {
    try {
      const p = new URL(url, location.href).pathname;
      const hit = RE_SFCC_CLASSIC.test(p) || RE_OCAPI_ITEMS.test(p) || RE_SCAPI_ITEMS.test(p);
      if (DEBUG) dbg("check url:", p, "→", hit);
      return hit;
    } catch { return false; }
  }

  const parseKVBody = (bodyString) => {
    const out = {};
    try {
      const params = new URLSearchParams(bodyString);
      for (const [k, v] of params) out[k] = v;
    } catch {}
    return out;
  };

  const parseBody = (body) => {
    // Returns { pid, quantity, raw, items? }
    const result = { pid: undefined, quantity: undefined, raw: null, items: undefined };
    if (!body) return result;

    // FormData
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const kv = {};
      for (const [k, v] of body.entries()) kv[k] = v;
      result.raw = kv;
      result.pid = kv.pid || kv.product_id || kv.productID || kv.id || kv.masterPid || undefined;
      result.quantity = kv.quantity || kv.qty || kv.Qty || kv.Quantity || undefined;
      return result;
    }

    // String (may be urlencoded or JSON)
    if (typeof body === "string") {
      const kv = parseKVBody(body);
      result.raw = kv;
      result.pid = kv.pid || kv.product_id || kv.productID || kv.id || kv.masterPid || undefined;
      result.quantity = kv.quantity || kv.qty || kv.Qty || kv.Quantity || undefined;
      try {
        const json = JSON.parse(body);
        if (json && typeof json === "object") {
          result.raw = json;
          result.pid = result.pid || json.pid || json.product_id || json.id;
          result.quantity = result.quantity || json.quantity || json.qty;
          if (Array.isArray(json.items)) result.items = json.items;
        }
      } catch {}
      return result;
    }

    // URLSearchParams
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      const kv = {};
      for (const [k, v] of body.entries()) kv[k] = v;
      result.raw = kv;
      result.pid = kv.pid || kv.product_id || kv.productID || kv.id || kv.masterPid || undefined;
      result.quantity = kv.quantity || kv.qty || kv.Qty || kv.Quantity || undefined;
      return result;
    }

    // JSON-like
    if (typeof body === "object") {
      result.raw = body;
      if (Array.isArray(body.items)) result.items = body.items;
      result.pid = body.pid || body.product_id || body.productID || body.id || body.masterPid;
      result.quantity = body.quantity || body.qty || body.Qty || body.Quantity;
      return result;
    }

    return result;
  };

  const postAdd = (payload) => {
    try {
      if (DEBUG) dbg("postAdd", payload);
      window.postMessage({ __from: SRC_TAG, type: "SFCC_ADD_TO_CART", payload }, "*");
    } catch {}
  };

  // --- Hook forms (fires before navigation) ---
  document.addEventListener("submit", (ev) => {
    try {
      const form = ev.target;
      if (!(form instanceof HTMLFormElement)) return;
      const action = form.getAttribute("action") || "";
      if (!isSfccFormAction(action)) return;

      const data = new FormData(form);
      const parsed = parseBody(data);
      if (!parsed.pid) {
        parsed.pid = form.querySelector('[name="pid"],[name="product_id"],[name="id"]')?.value || undefined;
      }
      if (!parsed.quantity) {
        parsed.quantity = form.querySelector('[name="quantity"],[name="qty"],[name="Quantity"]')?.value || "1";
      }
      postAdd({
        url: new URL(action, location.href).href,
        method: (form.method || "POST").toUpperCase(),
        pid: parsed.pid,
        quantity: parsed.quantity || "1",
        raw: parsed.raw || null,
        ts: Date.now()
      });
    } catch {}
  }, true);

  // --- Hook fetch (emit immediately; do NOT await) ---
  const _fetch = window.fetch;
  window.fetch = function patchedFetch(input, init = {}) {
    try {
      const url    = typeof input === "string" ? input : (input && input.url) || "";
      const method = (init.method || (typeof input !== "string" ? input?.method : "") || "GET").toUpperCase();
      if (["POST", "PUT", "PATCH"].includes(method) && isSfccFormAction(url)) {
        const parsed = parseBody(init.body);
        if (parsed.items && parsed.items.length) {
          for (const it of parsed.items) {
            postAdd({
              url: new URL(url, location.href).href,
              method, pid: it.product_id || it.pid, quantity: String(it.quantity || 1),
              raw: it, ts: Date.now()
            });
          }
        } else {
          postAdd({
            url: new URL(url, location.href).href,
            method, pid: parsed.pid, quantity: String(parsed.quantity || 1),
            raw: parsed.raw || null, ts: Date.now()
          });
        }
      }
    } catch {}
    return _fetch.apply(this, arguments);
  };

  // --- Hook XHR (instance listener) ---
  const XHR = window.XMLHttpRequest;
  const _open = XHR.prototype.open;
  const _send = XHR.prototype.send;

  XHR.prototype.open = function(method, url) {
    try { this.__al_method = (method || "GET").toUpperCase(); this.__al_url = url; } catch {}
    return _open.apply(this, arguments);
  };
  XHR.prototype.send = function(body) {
    try {
      if (["POST", "PUT", "PATCH"].includes(this.__al_method || "") && isSfccFormAction(this.__al_url || "")) {
        const parsed = parseBody(body);
        if (parsed.items && parsed.items.length) {
          for (const it of parsed.items) {
            postAdd({
              url: new URL(this.__al_url, location.href).href,
              method: this.__al_method, pid: it.product_id || it.pid, quantity: String(it.quantity || 1),
              raw: it, ts: Date.now()
            });
          }
        } else {
          postAdd({
            url: new URL(this.__al_url, location.href).href,
            method: this.__al_method, pid: parsed.pid, quantity: String(parsed.quantity || 1),
            raw: parsed.raw || null, ts: Date.now()
          });
        }
      }
    } catch {}
    return _send.apply(this, arguments);
  };

  dbg("hook active on", location.hostname, location.pathname);
})();