/* popup.js — block layout + multi-select + totals + logo fix + robust X-delete */
(() => {
  // Ensure logo path resolves inside extension
  try {
    const logo = document.getElementById("logo");
    if (logo) logo.src = chrome.runtime.getURL("icons/alligator_icon.png");
  } catch {}

  const listEl = document.getElementById("list");
  const toggleAllEl = document.getElementById("toggleAll");
  const deleteSelEl = document.getElementById("deleteSel");
  const countEl = document.getElementById("count");
  const selectedTotalEl = document.getElementById("selectedTotal");
  const allTotalEl = document.getElementById("allTotal");
  const mixHintEl = document.getElementById("mixHint");

  let CART = [];
  const selected = new Set();

  // ---------- currency parsing / totals ----------
  const CUR_SYM = { "$":"USD", "€":"EUR", "£":"GBP", "¥":"JPY", "₹":"INR" };
  const PRICE_RE = /([$€£¥₹])\s*([0-9][\d.,]*)|(?:\b(USD|CAD|EUR|GBP|JPY|INR|AUD|CHF|SEK|NOK|DKK)\b)\s*([0-9][\d.,]*)|([0-9][\d.,]*)\s*(USD|CAD|EUR|GBP|JPY|INR|AUD|CHF|SEK|NOK|DKK)\b/i;

  function parsePrice(str) {
    const s = String(str || "").trim();
    const m = s.match(PRICE_RE);
    if (!m) return null;
    const rawNum = m[2] || m[4] || m[5] || "";
    const num = rawNum.replace(/[^\d.,]/g,"").replace(/[.,](?=\d{3}\b)/g,"").replace(",",".");
    const f = parseFloat(num);
    if (!Number.isFinite(f)) return null;
    const sym = m[1];
    const code = (m[3] || m[6] || (sym && CUR_SYM[sym]) || "USD").toUpperCase();
    return { code, cents: Math.round(f * 100) };
  }

  function sumByCurrency(items) {
    const map = {};
    for (const it of items) {
      const p = parsePrice(it.price);
      if (!p) continue;
      map[p.code] = (map[p.code] || 0) + p.cents;
    }
    return map;
  }

  function fmt(code, cents) {
    const amount = (cents/100).toFixed(2);
    if (code === "USD") return `$${amount}`;
    return `${code} ${amount}`;
  }

  function formatTotals(map) {
    const order = ["USD","CAD","EUR","GBP","JPY","INR","AUD","CHF","SEK","NOK","DKK"];
    const parts = [];
    for (const k of order) if (map[k]) parts.push(fmt(k, map[k]));
    for (const k of Object.keys(map)) if (!order.includes(k)) parts.push(fmt(k, map[k]));
    return parts.join(", ") || "$0.00";
  }

  function updateTotals() {
    const allMap = sumByCurrency(CART);
    const selMap = sumByCurrency(CART.filter(it => selected.has(keyOf(it))));
    allTotalEl.textContent = formatTotals(allMap);
    selectedTotalEl.textContent = formatTotals(selMap);
    const mix = (Object.keys(allMap).length > 1 || Object.keys(selMap).length > 1);
    mixHintEl.textContent = mix ? "Mixed currencies shown separately." : "";
  }

  // ---------- storage ----------
  function loadCart(cb) {
    try {
      chrome.storage.sync.get({ cart: [] }, ({ cart }) => {
        CART = Array.isArray(cart) ? cart : [];
        cb?.();
      });
    } catch { CART = []; cb?.(); }
  }
  function saveCart(next, cb) {
    try { chrome.storage.sync.set({ cart: next }, cb); } catch { cb?.(); }
  }

  // ---------- rendering ----------
  const keyOf = (it) => (String(it.id || it.link || "")).toLowerCase();

  function domainOf(link="") {
    try { return new URL(String(link)).hostname.replace(/^www\./,""); } catch { return ""; }
  }

  function escapeHtml(s){
    return String(s||"").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function render() {
    listEl.innerHTML = "";
    selected.clear();
    toggleAllEl.indeterminate = false;
    toggleAllEl.checked = false;

    if (!CART.length) {
      countEl.textContent = "0 items";
      listEl.innerHTML = `<div class="empty">No items saved yet.</div>`;
      updateTotals();
      updateDeleteBtn();
      return;
    }

    countEl.textContent = `${CART.length} item${CART.length>1?"s":""}`;

    for (const it of CART) {
      const id = keyOf(it);
      const dom = domainOf(it.link);
      const card = document.createElement("div");
      card.className = "item";
      card.dataset.id = id;

      // selection (left)
      const sel = document.createElement("label");
      sel.className = "sel";
      sel.innerHTML = `<input type="checkbox" class="selbox" aria-label="Select item" />`;
      card.appendChild(sel);

      // thumbnail
      const img = document.createElement("img");
      img.className = "thumb";
      img.src = it.img || "";
      img.alt = "";
      card.appendChild(img);

      // meta (clickable to product page)
      const a = document.createElement("a");
      a.className = "meta";
      a.href = it.link || "#";
      a.target = "_blank";
      a.rel = "noreferrer";
      a.innerHTML = `
        <div class="line1">
          <div class="title" title="${escapeHtml(it.title||"")}">${escapeHtml(it.title||"")}</div>
          <div class="price">${escapeHtml(it.price||"")}</div>
        </div>
        <div class="line2">
          <div class="brand" title="${escapeHtml(it.brand||"")}">${escapeHtml(it.brand||"")}</div>
          <div class="dot"></div>
          <div class="domain" title="${dom}">${dom}</div>
        </div>`;
      card.appendChild(a);

      // delete (small, top-right, dark gray)
      const del = document.createElement("button");
      del.type = "button";
      del.className = "del";
      del.setAttribute("aria-label", "Remove");
      del.textContent = "×";
      card.appendChild(del);

      listEl.appendChild(card);
    }

    updateTotals();
    updateDeleteBtn();
  }

  // ---------- actions ----------
  function reflectSelectAll() {
    if (!CART.length) { toggleAllEl.checked = false; toggleAllEl.indeterminate = false; return; }
    const total = CART.length;
    const selCount = CART.reduce((n, it) => n + (selected.has(keyOf(it)) ? 1 : 0), 0);
    toggleAllEl.checked = selCount === total;
    toggleAllEl.indeterminate = selCount > 0 && selCount < total;
  }

  function updateDeleteBtn() {
    deleteSelEl.disabled = selected.size === 0;
  }

  function removeOne(id) {
    const next = CART.filter(it => keyOf(it) !== id);
    saveCart(next, () => {
      CART = next;
      render();
    });
  }

  function removeSelected() {
    if (!selected.size) return;
    const next = CART.filter(it => !selected.has(keyOf(it)));
    saveCart(next, () => {
      CART = next;
      render();
    });
  }

  // ---------- delegated events (fixes X-click conflicts) ----------
  // Item clicks: open link unless clicking select box or delete
  listEl.addEventListener("click", (e) => {
    const delBtn = e.target.closest(".del");
    if (delBtn) {
      e.preventDefault(); e.stopPropagation();
      const card = delBtn.closest(".item");
      if (card) removeOne(card.dataset.id);
      return;
    }
    const inSel = e.target.closest(".sel");
    if (inSel) return; // checkbox area; change handler will process

    const card = e.target.closest(".item");
    if (card) {
      const a = card.querySelector(".meta");
      if (a) a.click();
    }
  });

  // Selection toggles
  listEl.addEventListener("change", (e) => {
    const box = e.target.closest(".selbox");
    if (!box) return;
    const card = e.target.closest(".item");
    if (!card) return;
    const id = card.dataset.id;
    if (box.checked) selected.add(id); else selected.delete(id);
    reflectSelectAll();
    updateDeleteBtn();
    updateTotals();
  });

  // ---------- wire UI ----------
  toggleAllEl.addEventListener("change", () => {
    const check = toggleAllEl.checked;
    selected.clear();
    if (check) CART.forEach(it => selected.add(keyOf(it)));
    document.querySelectorAll(".item .selbox").forEach(cb => { cb.checked = check; });
    reflectSelectAll();
    updateDeleteBtn();
    updateTotals();
  });

  deleteSelEl.addEventListener("click", removeSelected);

  // live updates from background
  try {
    chrome.runtime.onMessage.addListener((m) => {
      if (m && m.action === "CART_UPDATED" && Array.isArray(m.items)) {
        CART = m.items;
        render();
      }
    });
  } catch {}

  // init
  loadCart(render);
})();