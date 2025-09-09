/* popup.js — original 4-line card, right-side post-it tabs (10ch + ...),
   working select-all, X-delete, Move To, in-popup Manage (Default undeletable)
   + Manage modal now uses DRAFT (Done = save, Cancel/backdrop/X = discard)
   + “New List” is an always-visible last row with textbox + Add button */
(() => {
  // ---------- Logo ----------
  try {
    const logo = document.getElementById("logo");
    if (logo) logo.src = chrome.runtime.getURL("icons/alligator_icon.png");
  } catch {}

  // ---------- DOM ----------
  const listEl = document.getElementById("list");
  const toggleAllEl = document.getElementById("toggleAll");
  const deleteSelEl = document.getElementById("deleteSel");
  const moveBtn = document.getElementById("moveBtn");
  const moveMenu = document.getElementById("moveMenu");
  const tabsEl = document.getElementById("tabs");
  const frameEl = document.getElementById("frame");
  const countEl = document.getElementById("count");
  const selectedTotalEl = document.getElementById("selectedTotal");
  const allTotalEl = document.getElementById("allTotal");
  const mixHintEl = document.getElementById("mixHint");

  // Manage modal
  const manageModal = document.getElementById("manageModal");
  const manageList  = document.getElementById("manageList");
  const manageClose = document.getElementById("manageClose");   // old “X” (we keep it, acts like Cancel)
  const addListBtn  = document.getElementById("addList");
  if (addListBtn) addListBtn.remove();
  const doneManage  = document.getElementById("doneManage");
  const modalFoot   = document.querySelector("#manageModal .modal-foot");

  // ---------- State ----------
  let LISTS = Object.create(null); // { listName: Item[] }
  let ACTIVE = "Default";
  const selected = new Set();      // keys for ACTIVE list

  // DRAFT state for Manage modal (only committed on Done)
  let DRAFT = null;
  let ACTIVE_DRAFT = null;

  // ---------- Helpers ----------
  const keyOf = it => (String(it?.id || it?.link || "")).toLowerCase();
  const domainOf = (link="") => { try { return new URL(String(link)).hostname.replace(/^www\./,""); } catch { return ""; } };
  const escapeHtml = s => String(s||"").replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dedupe = (arr)=>{ const seen=new Set(), out=[]; for(const it of arr||[]){ const k=keyOf(it); if(k && !seen.has(k)){ seen.add(k); out.push(it); } } return out; };

  // price parsing for totals
  const CUR_SYM = { "$":"USD", "€":"EUR", "£":"GBP", "¥":"JPY", "₹":"INR" };
  const PRICE_RE=/([$€£¥₹])\s*([0-9][\d.,]*)|(?:\b(USD|CAD|EUR|GBP|JPY|INR|AUD|CHF|SEK|NOK|DKK)\b)\s*([0-9][\d.,]*)|([0-9][\d.,]*)\s*(USD|CAD|EUR|GBP|JPY|INR|AUD|CHF|SEK|NOK|DKK)\b/i;
  function parsePrice(str){
    const s=String(str||"").trim(); const m=s.match(PRICE_RE); if(!m) return null;
    const raw=m[2]||m[4]||m[5]||""; const num=raw.replace(/[^\d.,]/g,"").replace(/[.,](?=\d{3}\b)/g,"").replace(",",".");
    const f=parseFloat(num); if(!Number.isFinite(f)) return null;
    const sym=m[1]; const code=(m[3]||m[6]||(sym&&CUR_SYM[sym])||"USD").toUpperCase();
    return { code, cents: Math.round(f*100) };
  }
  function sumByCurrency(items){ const map={}; for(const it of items||[]){ const p=parsePrice(it.price); if(!p) continue; map[p.code]=(map[p.code]||0)+p.cents; } return map; }
  const fmt=(code,cents)=> code==="USD" ? `$${(cents/100).toFixed(2)}` : `${code} ${(cents/100).toFixed(2)}`;
  function formatTotals(map){
    const order=["USD","CAD","EUR","GBP","JPY","INR","AUD","CHF","SEK","NOK","DKK"], parts=[];
    for(const k of order) if(map[k]) parts.push(fmt(k,map[k]));
    for(const k of Object.keys(map)) if(!order.includes(k)) parts.push(fmt(k,map[k]));
    return parts.join(", ") || "$0.00";
  }

  // ---------- Storage ----------
  function loadAll(cb){
    try {
      chrome.storage.sync.get({ uc_lists:null, uc_active:null, cart:[] }, (res)=>{
        LISTS = res.uc_lists && typeof res.uc_lists==="object" ? res.uc_lists : { "Default": [] };
        if (!("Default" in LISTS)) LISTS["Default"] = LISTS["Default"] || [];
        ACTIVE = (typeof res.uc_active==="string" && res.uc_active in LISTS) ? res.uc_active : "Default";
        // migrate legacy single cart
        const legacy = Array.isArray(res.cart) ? res.cart : [];
        if (legacy.length){
          LISTS[ACTIVE] = dedupe([...(LISTS[ACTIVE]||[]), ...legacy]);
          chrome.storage.sync.set({ uc_lists: LISTS, cart: [] }, ()=>cb?.());
        } else cb?.();
      });
    } catch { LISTS = { "Default": [] }; ACTIVE="Default"; cb?.(); }
  }
  const saveLists = (cb)=> chrome.storage.sync.set({ uc_lists: LISTS, uc_active: ACTIVE }, cb);

  // ---------- Tabs (right-side “post-it”) ----------
  const shortTab = (s) => {
    const t = String(s || "");
    const up = t.toUpperCase();
    return up.length > 10 ? up.slice(0,10) + "..." : up;
  };

  function renderTabs(){
    tabsEl.innerHTML = "";
    Object.keys(LISTS).forEach(name=>{
      const tab = document.createElement("div");
      tab.className = "tab" + (name===ACTIVE ? " active" : "");
      tab.title = name;
      tab.innerHTML = `<span class="label">${escapeHtml(shortTab(name))}</span>`;
      tab.addEventListener("click", ()=>{
        if (ACTIVE !== name){
          ACTIVE = name;
          selected.clear();
          saveLists(()=>{ renderTabs(); renderList(); });
        }
      });
      tabsEl.appendChild(tab);
    });
  }

  // ---------- Totals & Select-all ----------
  function updateTotals(){
    const items=LISTS[ACTIVE]||[];
    const all=sumByCurrency(items);
    const sel=sumByCurrency(items.filter(it=>selected.has(keyOf(it))));
    allTotalEl.textContent = formatTotals(all);
    selectedTotalEl.textContent = formatTotals(sel);
    mixHintEl.textContent = (Object.keys(all).length>1 || Object.keys(sel).length>1) ? "Mixed currencies shown separately." : "";
  }
  function reflectSelectAll(){
    const items=LISTS[ACTIVE]||[];
    if(!items.length){
      toggleAllEl.checked=false; toggleAllEl.indeterminate=false; deleteSelEl.disabled=true; return;
    }
    const total=items.length;
    const selCount=items.reduce((n,it)=>n+(selected.has(keyOf(it))?1:0),0);
    toggleAllEl.checked = selCount===total;
    toggleAllEl.indeterminate = selCount>0 && selCount<total;
    deleteSelEl.disabled = selCount===0;
  }

  // ---------- Render list (4-line card + price) ----------
  function renderList(){
    const items=LISTS[ACTIVE]||(LISTS[ACTIVE]=[]);
    listEl.innerHTML="";
    selected.clear();
    reflectSelectAll();
    countEl.textContent = `${items.length} item${items.length===1?"":"s"}`;

    if(!items.length){
      listEl.innerHTML=`<div class="empty" style="padding:16px;color:#6b7280;">No items in “${escapeHtml(ACTIVE)}”.</div>`;
      updateTotals();
      return;
    }

    for(const it of items){
      const id=keyOf(it), dom=domainOf(it.link);
      const card=document.createElement("div"); card.className="item"; card.dataset.id=id;

      const sel=document.createElement("label"); sel.className="sel";
      sel.innerHTML=`<input type="checkbox" class="selbox" aria-label="Select item" />`;
      card.appendChild(sel);

      const img=document.createElement("img"); img.className="thumb"; img.src=it.img||""; img.alt="";
      card.appendChild(img);

      const a=document.createElement("a"); a.className="meta"; a.href=it.link||"#"; a.target="_blank"; a.rel="noreferrer";
      a.innerHTML = `
        <div class="title" title="${escapeHtml(it.title||"")}">${escapeHtml(it.title||"")}</div>
        <div class="brand" title="${escapeHtml(it.brand||"")}">${escapeHtml(it.brand||"")}</div>
        <div class="domain" title="${dom}">${dom}</div>
        <div class="price">${escapeHtml(it.price||"")}</div>`;
      card.appendChild(a);

      const del=document.createElement("button");
      del.type="button"; del.className="del"; del.setAttribute("aria-label","Remove"); del.textContent="×";
      card.appendChild(del);

      listEl.appendChild(card);
    }

    updateTotals();
  }

  // ---------- Mutations ----------
  function removeOne(id){
    LISTS[ACTIVE]=(LISTS[ACTIVE]||[]).filter(it=>keyOf(it)!==id);
    saveLists(()=>{ renderList(); renderTabs(); });
  }
  function removeSelected(){
    if (!selected.size) return;
    LISTS[ACTIVE]=(LISTS[ACTIVE]||[]).filter(it=>!selected.has(keyOf(it)));
    saveLists(()=>{ renderList(); renderTabs(); });
  }
  function moveSelectedTo(name){
    if(!name || !selected.size) return;
    if(!LISTS[name]) LISTS[name]=[];
    const take=(LISTS[ACTIVE]||[]).filter(it=>selected.has(keyOf(it)));
    LISTS[name]=dedupe([...(LISTS[name]||[]), ...take]);
    LISTS[ACTIVE]=(LISTS[ACTIVE]||[]).filter(it=>!selected.has(keyOf(it)));
    saveLists(()=>{ renderTabs(); renderList(); });
  }

  // ---------- Events ----------
  toggleAllEl.addEventListener("change", ()=>{
    const items=LISTS[ACTIVE]||[];
    selected.clear();
    if (toggleAllEl.checked) items.forEach(it=>selected.add(keyOf(it)));
    listEl.querySelectorAll(".selbox").forEach(cb => { cb.checked = toggleAllEl.checked; });
    reflectSelectAll(); updateTotals();
  });

  listEl.addEventListener("click", (e)=>{
    const t=e.target;

    if (t.classList.contains("selbox")){
      const id=t.closest(".item")?.dataset?.id; if(!id) return;
      if (t.checked) selected.add(id); else selected.delete(id);
      reflectSelectAll(); updateTotals(); return;
    }

    if (t.classList.contains("del")){
      const id=t.closest(".item")?.dataset?.id; if(!id) return;
      removeOne(id); return;
    }
  }, true);

  deleteSelEl.addEventListener("click", removeSelected);

  // ---------- Move menu ----------
function openMoveMenu(){
  const names = Object.keys(LISTS);
  moveMenu.innerHTML = [
    ...names.map(n => `<div class="mi" data-name="${escapeHtml(n)}">${escapeHtml(n)}</div>`),
    `<div class="mi manage" data-act="manage">Add/Manage Lists</div>`
  ].join("");

  // show so we can measure
  moveMenu.hidden = false;

  const btnRect = moveBtn.getBoundingClientRect();
  const menuRect = moveMenu.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  // place just below the button
  let left = btnRect.left;
  let top  = btnRect.bottom + 6;

  // clamp horizontally so it stays inside the popup
  if (left + menuRect.width > vw - 8) left = vw - 8 - menuRect.width;
  if (left < 8) left = 8;

  // if there's not enough space below, flip it above the button
  if (top + menuRect.height > vh - 8) top = btnRect.top - 6 - menuRect.height;
  if (top < 8) top = 8;

  moveMenu.style.left = `${Math.round(left)}px`;
  moveMenu.style.top  = `${Math.round(top)}px`;
}

function closeMoveMenu(){
  moveMenu.hidden = true;
  moveMenu.style.left = "-9999px";
  moveMenu.style.top  = "-9999px";
}

  moveBtn.addEventListener("click",(e)=>{
    e.stopPropagation();
    if (!moveMenu.hidden) { closeMoveMenu(); return; }
    openMoveMenu();
  });
  document.addEventListener("click",(e)=>{
    if (!moveMenu.hidden && !moveMenu.contains(e.target) && e.target!==moveBtn) closeMoveMenu();
  }, true);
  document.addEventListener("keydown",(e)=>{
    if (e.key==="Escape" && !moveMenu.hidden) closeMoveMenu();
  });

  moveMenu.addEventListener("click",(e)=>{
    const node=e.target.closest(".mi"); if(!node) return;
    const act=node.dataset.act||"";
    if (act==="new"){
      openManageModal(); // open modal; last row has textbox + Add
      closeMoveMenu();
      return;
    }
    if (act==="manage"){
      closeMoveMenu();
      openManageModal();
      return;
    }
    const name=node.dataset.name; if(name) moveSelectedTo(name);
    closeMoveMenu();
  });

  // ---------- Manage lists modal (DRAFT; Default locked; inline Add row) ----------

  function initDraftIfNeeded(){
    if (!DRAFT){
      DRAFT = JSON.parse(JSON.stringify(LISTS));
      ACTIVE_DRAFT = ACTIVE;
    }
  }

  function renderManage(){
    // rows from DRAFT; lock Default (no Rename/Delete)
    const names = Object.keys(DRAFT);
    const rows = names.map(n => {
      const isDefault = /^default$/i.test(n);
      const actions = isDefault
        ? "" // no actions for Default
        : `<a class="link rn" style="color:#111;">Rename</a>
           <a class="link rm" style="color:#B91C1C;">Delete</a>`;
      return `
        <div class="manage-row" data-name="${escapeHtml(n)}" data-lock="${isDefault ? "1" : "0"}">
          <div class="nm">${escapeHtml(n)}</div>
          ${actions}
        </div>`;
    }).join("");

    // Always-visible "New List" row at the end
    const newRow = `
      <div class="manage-row new-row" data-new="1">
        <input class="rename-input new-name" placeholder="New list name" maxlength="48" style="width:220px;max-width:220px;" />
        <a class="link new-add">Add</a>
      </div>`;

    manageList.innerHTML = rows + newRow;

    // Hide the old “X” visually (still wired as Cancel)
    if (manageClose) manageClose.style.display = "none";

    // Footer buttons: ensure Cancel (pink) exists & is wired; style Done (green)
    if (modalFoot){
      let cancelBtn = document.getElementById("cancelManage");
      if (!cancelBtn){
        cancelBtn = document.createElement("button");
        cancelBtn.id = "cancelManage";
        cancelBtn.type = "button";
        cancelBtn.textContent = "Cancel";
        cancelBtn.style.cssText = "height:36px;padding:0 14px;border-radius:10px;border:1.5px solid var(--pink);background:var(--pink);color:#fff;font-weight:700;cursor:pointer;";
        modalFoot.insertBefore(cancelBtn, modalFoot.firstChild);
      }
      // always (re)bind to be safe
      cancelBtn.onclick = cancelManage;

      if (doneManage){
        doneManage.textContent = "Done";
        doneManage.style.cssText = "height:36px;padding:0 14px;border-radius:10px;border:1.5px solid var(--green);background:var(--green);color:#fff;font-weight:700;cursor:pointer;";
        // ensure single binding
        doneManage.onclick = commitManage;
      }
    }

    // Focus input for quick adding
    const input = manageList.querySelector(".new-name");
    if (input) input.focus();
  }

  function openManageModal(){
    initDraftIfNeeded();
    renderManage();
    manageModal.hidden = false;
  }

  function commitManage(){
    if (!DRAFT){ manageModal.hidden = true; return; }
    LISTS = DRAFT;
    ACTIVE = (ACTIVE_DRAFT && (ACTIVE_DRAFT in LISTS)) ? ACTIVE_DRAFT
            : (LISTS["Default"] ? "Default" : (Object.keys(LISTS)[0] || "Default"));
    DRAFT = null; ACTIVE_DRAFT = null;
    saveLists(()=>{ renderTabs(); renderList(); });
    manageModal.hidden = true;
  }

  function cancelManage(){
    // discard draft, do NOT save
    DRAFT = null; ACTIVE_DRAFT = null;
    manageModal.hidden = true;
  }

  // Clicks & keys inside the modal list
  manageList.addEventListener("click",(e)=>{
    e.preventDefault();

    // Add new list
    if (e.target.classList.contains("new-add")){
      const input = manageList.querySelector(".new-name");
      if (!input) return;
      const n = (input.value || "").trim();
      if (!n) return;
      if (DRAFT[n]) { alert("A list with that name already exists."); return; }
      DRAFT[n] = [];
      ACTIVE_DRAFT = n;
      renderManage();
      return;
    }

    const row = e.target.closest(".manage-row");
    if (!row || row.dataset.new === "1") return;

    const name = row.dataset.name || "";
    const isDefault = row.dataset.lock === "1" || /^default$/i.test(name);
    if (isDefault) return; // no actions on Default

    // Delete (in DRAFT)
    if (e.target.classList.contains("rm")){
      if (confirm(`Delete list “${name}”?`)){
        const wasActive = (name===ACTIVE_DRAFT);
        delete DRAFT[name];
        if (wasActive){
          ACTIVE_DRAFT = DRAFT["Default"] ? "Default" : (Object.keys(DRAFT)[0] || "Default");
        }
        renderManage();
      }
      return;
    }

    // Rename (in DRAFT)
    if (e.target.classList.contains("rn")){
      const nm = row.querySelector(".nm");
      const original = name;
      const input = document.createElement("input");
      input.className = "rename-input";
      input.value = original;
      input.setAttribute("maxlength","48");
      input.style.width = "220px";
      input.style.maxWidth = "220px";
      nm.replaceWith(input);
      input.focus();
      input.select();

      const commit = ()=> {
        const newName = (input.value || "").trim();
        if (!newName || newName === original) { renderManage(); return; }
        if (DRAFT[newName]) { alert("A list with that name already exists."); renderManage(); return; }
        DRAFT[newName] = DRAFT[original];
        delete DRAFT[original];
        if (ACTIVE_DRAFT === original) ACTIVE_DRAFT = newName;
        renderManage();
      };

      input.addEventListener("keydown",(ev)=>{
        if (ev.key==="Enter") commit();
        if (ev.key==="Escape") renderManage();
      });
      input.addEventListener("blur", commit);
    }
  });

  // Enter to add from the new-name input
  manageList.addEventListener("keydown",(e)=>{
    if (e.target && e.target.classList.contains("new-name") && e.key === "Enter"){
      e.preventDefault();
      const input = e.target;
      const n = (input.value || "").trim();
      if (!n) return;
      if (DRAFT[n]) { alert("A list with that name already exists."); return; }
      DRAFT[n] = [];
      ACTIVE_DRAFT = n;
      renderManage();
    }
  });

  // Footer buttons (also bound in renderManage for safety)
  if (doneManage) doneManage.addEventListener("click", commitManage);
  if (manageClose) manageClose.addEventListener("click", cancelManage); // “X” behaves like Cancel
  manageModal.addEventListener("click",(e)=>{
    if (e.target.classList.contains("modal-backdrop")) cancelManage();
  });

  // Replace “Add List” behavior: open modal (no prompt)
  addListBtn.addEventListener("click", ()=>{ openManageModal(); });

  // ---------- Init ----------
  loadAll(()=>{ renderTabs(); renderList(); });
})();