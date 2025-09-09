/* popup.js — stable drop-in + DRAG-REORDER *inside Manage Lists*
   - Side tabs unchanged (no drag); order reflects saved ORDER
   - Manage Lists modal: drag rows to reorder (Default pinned, not draggable)
   - Cancel (pink) discards changes; Done (green) saves; “X” hidden
   - Original list/card behavior preserved
*/
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
  const manageClose = document.getElementById("manageClose"); // we hide this; Cancel replaces it
  const addListBtn  = document.getElementById("addList");     // removed UI
  const doneManage  = document.getElementById("doneManage");
  const modalFoot   = manageModal ? manageModal.querySelector(".modal-foot") : null;

  // Ensure footer has Cancel (pink) + Done (green); hide X and remove legacy +New
  if (manageClose) manageClose.style.display = "none";
  if (addListBtn) addListBtn.remove();
  if (modalFoot) {
    // style Done green
    if (doneManage) {
      doneManage.classList.add("btn");
      doneManage.style.background = "var(--green)";
      doneManage.style.color = "#fff";
      doneManage.style.borderColor = "var(--green)";
      doneManage.style.fontWeight = "800";
    }
    // inject / restyle Cancel pink
    let cancelManage = modalFoot.querySelector("#cancelManage");
    if (!cancelManage) {
      cancelManage = document.createElement("button");
      cancelManage.id = "cancelManage";
      cancelManage.className = "btn";
      modalFoot.insertBefore(cancelManage, doneManage || null);
    }
    cancelManage.textContent = "Cancel";
    cancelManage.style.background = "var(--pink)";
    cancelManage.style.color = "#fff";
    cancelManage.style.borderColor = "var(--pink)";
    cancelManage.style.fontWeight = "800";
  }
  const cancelManageBtn = modalFoot ? modalFoot.querySelector("#cancelManage") : null;

  // ---------- State ----------
  let LISTS = Object.create(null);   // { name: Item[] }
  let ACTIVE = "Default";
  let ORDER  = [];                   // ["Default", "Work", "Gifts", ...] for side tabs
  const selected = new Set();

  // Draft buffers while Manage is open
  let DRAFT = null;
  let DRAFT_ORDER = null;
  let ACTIVE_DRAFT = null;
  let manageDragWired = false;
  let draggingRow = null;
  let hintTarget  = null;
  let hintBefore  = false;

function clearRowHints(){
  manageList.querySelectorAll(".manage-row").forEach(r=>{
    r.classList.remove("drop-before","drop-after","dragging");
  });
  hintTarget = null; hintBefore = false;
}

  // ---------- Helpers ----------
  const keyOf = it => String(it?.id || it?.link || "").toLowerCase();
  const domainOf = (link="") => { try { return new URL(String(link)).hostname.replace(/^www\./,""); } catch { return ""; } };
  const escapeHtml = s => String(s||"").replace(/[&<>"']/g, c => (
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  ));
  const dedupe = (arr=[]) => { const seen=new Set(), out=[]; for(const it of arr){ const k=keyOf(it); if(k && !seen.has(k)){ seen.add(k); out.push(it); } } return out; };
  const deepCopy = (obj) => JSON.parse(JSON.stringify(obj));

  function ensureOrder(base = LISTS, order = ORDER){
    const names = Object.keys(base);
    const out = [];
    if (names.includes("Default")) out.push("Default"); // pin first
    (order||[]).forEach(n => { if (n !== "Default" && names.includes(n) && !out.includes(n)) out.push(n); });
    names.forEach(n => { if (n !== "Default" && !out.includes(n)) out.push(n); });
    return out;
  }

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
      chrome.storage.sync.get({ uc_lists:null, uc_active:null, uc_order:null, cart:[] }, (res)=>{
        LISTS = res.uc_lists && typeof res.uc_lists==="object" ? res.uc_lists : { "Default": [] };
        if (!("Default" in LISTS)) LISTS["Default"] = LISTS["Default"] || [];
        ACTIVE = (typeof res.uc_active==="string" && res.uc_active in LISTS) ? res.uc_active : "Default";
        ORDER  = Array.isArray(res.uc_order) ? res.uc_order.slice() : [];
        ORDER  = ensureOrder(LISTS, ORDER);

        // migrate legacy cart
        const legacy = Array.isArray(res.cart) ? res.cart : [];
        if (legacy.length){
          LISTS[ACTIVE] = dedupe([...(LISTS[ACTIVE]||[]), ...legacy]);
          chrome.storage.sync.set({ uc_lists: LISTS, cart: [] }, ()=>cb?.());
        } else cb?.();
      });
    } catch {
      LISTS = { "Default": [] }; ACTIVE="Default"; ORDER=["Default"]; cb?.();
    }
  }
  const saveLists = (cb)=> chrome.storage.sync.set(
    { uc_lists: LISTS, uc_active: ACTIVE, uc_order: ORDER },
    cb
  );

  // ---------- Tabs (no drag here; just render in ORDER) ----------
  const shortTab = (s) => {
    const up = String(s || "").toUpperCase();
    return up.length > 10 ? up.slice(0,10) + "..." : up;
  };
  function renderTabs(){
    tabsEl.innerHTML = "";
    ORDER = ensureOrder(LISTS, ORDER);
    ORDER.forEach(name=>{
      if (!(name in LISTS)) return;
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

  // ---------- Render list ----------
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

  // ---------- Move menu (no + New; bold green Add/Manage) ----------
  function openMoveMenu(){
    const names=ensureOrder(LISTS, ORDER);
    moveMenu.innerHTML = [
      ...names.map(n=>`<div class="mi" data-name="${escapeHtml(n)}">${escapeHtml(n)}</div>`),
      `<div class="mi manage" data-act="manage">Add/Manage Lists…</div>`
    ].join("");
    const r = moveBtn.getBoundingClientRect();
    moveMenu.style.top  = Math.round(r.bottom + 6) + "px";
    moveMenu.style.left = Math.round(r.left) + "px";
    moveMenu.hidden=false;
  }
  function closeMoveMenu(){
    moveMenu.hidden=true;
    moveMenu.style.top="-9999px"; moveMenu.style.left="-9999px";
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
    if (act==="manage"){
      closeMoveMenu();
      openManageModal();
      return;
    }
    const name=node.dataset.name; if(name) moveSelectedTo(name);
    closeMoveMenu();
  });

  // ---------- Manage lists (drag inside modal) ----------
  function openManageModal(){
    // seed drafts
    DRAFT = deepCopy(LISTS);
    DRAFT_ORDER = ensureOrder(DRAFT, ORDER);
    ACTIVE_DRAFT = ACTIVE;
    renderManageList();
    if (manageModal) manageModal.hidden=false;
  }
  function closeManageModal(){ if (manageModal) manageModal.hidden=true; }

  function rowHtml(name){
    const isDefault = /^default$/i.test(name);
    const actions = isDefault ? "" :
      `<a class="link rn" style="color:#111;">Rename</a>
       <a class="link rm" style="color:#B91C1C;">Delete</a>`;
    const dragAttr = isDefault ? "" : ` draggable="true"`;
    return `
      <div class="manage-row" data-name="${escapeHtml(name)}" data-lock="${isDefault ? "1" : "0"}"${dragAttr}>
        <div class="nm">${escapeHtml(name)}</div>
        ${actions}
      </div>`;
  }

  function renderManageList(){
    if (!manageList) return;
    const names = (DRAFT_ORDER || ensureOrder(DRAFT, ORDER)).filter(n => n in DRAFT);
    manageList.innerHTML =
      names.map(rowHtml).join("") +
      `<div class="manage-row new-row" data-new="1">
         <input class="rename-input new-name" placeholder="New list name" maxlength="48" style="width:220px;max-width:220px;" />
         <a class="link new-add" style="color:#058E3F;font-weight:700;">Add</a>
       </div>`;
    wireManageDrag();
  }

  function getDraggableRows(){
    // skip Default and the bottom "new-row"
    return Array.from(manageList.querySelectorAll('.manage-row[draggable="true"]'));
  }
  function clearRowHints(){
    manageList.querySelectorAll(".manage-row").forEach(r=>{
      r.classList.remove("drop-before","drop-after","dragging");
    });
    hintTarget = null; hintBefore = false;
  }
  // Replace existing computeDropFromY with this:
function computeDropFromY(clientY){
  const rows = Array.from(manageList.querySelectorAll('.manage-row[draggable="true"]'));
  if (!rows.length) return { target:null, before:false };

  // If we're above the first draggable row's midline → "before first"
  const firstRect = rows[0].getBoundingClientRect();
  if (clientY < (firstRect.top + firstRect.height/2)) {
    return { target: rows[0], before: true };
  }

  // Otherwise, find the first row whose midline is below the pointer
  for (let i = 0; i < rows.length; i++){
    const rect = rows[i].getBoundingClientRect();
    if (clientY < (rect.top + rect.height/2)){
      return { target: rows[i], before: true };
    }
  }

  // Pointer is below all mids → after the last draggable row
  return { target: rows[rows.length - 1], before: false };
}
  function wireManageDrag(){
  // Wire per-row handlers (these rows are re-rendered each time)
  Array.from(manageList.querySelectorAll('.manage-row[draggable="true"]')).forEach(row=>{
    const name = row.dataset.name;

    row.addEventListener("dragstart",(e)=>{
      draggingRow = name;
      row.classList.add("dragging");
      try {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", name);
        // tiny transparent drag image to remove weird default ghosts
        const ghost = document.createElement("canvas");
        ghost.width = 1; ghost.height = 1;
        e.dataTransfer.setDragImage(ghost, 0, 0);
      } catch {}
    });

    row.addEventListener("dragend",()=>{
      draggingRow = null;
      clearRowHints();
    });

    // keep default prevented so drops are allowed
    row.addEventListener("dragover",(e)=>{ e.preventDefault(); });
    row.addEventListener("drop",(e)=>{ e.preventDefault(); }); // handled by container
  });

  // Attach container-level handlers ONLY ONCE
  if (manageDragWired) return;
  manageDragWired = true;

  manageList.addEventListener("dragover",(e)=>{
    if (!draggingRow) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "move"; } catch {}

    const { target, before } = computeDropFromY(e.clientY);
    clearRowHints();
    if (target){
      hintTarget = target; hintBefore = before;
      target.classList.add(before ? "drop-before" : "drop-after");
    }
  });

  manageList.addEventListener("drop",(e)=>{
    if (!draggingRow) return;
    e.preventDefault();

    // Recompute on drop to match the visible guide line exactly
    let { target, before } = computeDropFromY(e.clientY);
    clearRowHints();

    const fromIdx = DRAFT_ORDER.indexOf(draggingRow);
    if (fromIdx < 0) return;

    // Compute insertion index in DRAFT_ORDER
    let toIdx;
    if (target){
      const overName = target.dataset.name;
      const overIdx  = DRAFT_ORDER.indexOf(overName);
      if (overIdx < 0) return;
      toIdx = before ? overIdx : overIdx + 1;
    } else {
      toIdx = DRAFT_ORDER.length; // append
    }

    // Never allow placing before index 0 (Default is pinned there)
    if (toIdx <= 0) toIdx = 1;

    // Standard remove-then-insert with forward-shift correction
    const arr = DRAFT_ORDER.slice();
    arr.splice(fromIdx, 1);
    if (fromIdx < toIdx) toIdx -= 1;
    if (toIdx === fromIdx) return;

    arr.splice(toIdx, 0, draggingRow);
    DRAFT_ORDER = arr;

    // Re-render to reflect the new order
    renderManageList();
  });
}

  // clicks inside Manage: add / rename / delete
  if (manageList){
    manageList.addEventListener("click",(e)=>{
      const row = e.target.closest(".manage-row");
      if (!row) return;

      // Add new
      if (e.target.classList.contains("new-add")){
        const inp = row.querySelector(".new-name");
        const name = (inp && inp.value || "").trim();
        if (!name) return;
        if (DRAFT[name]) { alert("A list with that name already exists."); return; }
        DRAFT[name] = [];
        DRAFT_ORDER.push(name);
        renderManageList();
        return;
      }

      const name = row.dataset.name || "";
      const isDefault = row.dataset.lock === "1" || /^default$/i.test(name);

      // Delete
      if (e.target.classList.contains("rm")){
        if (isDefault) return;
        if (confirm(`Delete list “${name}”?`)){
          const wasActive = (name===ACTIVE_DRAFT);
          delete DRAFT[name];
          DRAFT_ORDER = DRAFT_ORDER.filter(n => n !== name);
          if (wasActive){
            ACTIVE_DRAFT = "Default";
            if (!DRAFT["Default"]) DRAFT["Default"] = [];
            if (!DRAFT_ORDER.includes("Default")) DRAFT_ORDER.unshift("Default");
          }
          renderManageList();
        }
        return;
      }

      // Rename
      if (e.target.classList.contains("rn")){
        if (isDefault) return;
        const nm = row.querySelector(".nm");
        const original = name;
        const input = document.createElement("input");
        input.className = "rename-input";
        input.value = original;
        input.setAttribute("maxlength","48");
        nm.replaceWith(input);
        input.focus(); input.select();

        const commit = ()=> {
          const newName = (input.value || "").trim();
          if (!newName || newName === original) { renderManageList(); return; }
          if (DRAFT[newName]) { alert("A list with that name already exists."); renderManageList(); return; }
          DRAFT[newName] = DRAFT[original];
          delete DRAFT[original];
          const idx = DRAFT_ORDER.indexOf(original);
          if (idx !== -1) DRAFT_ORDER.splice(idx, 1, newName);
          if (ACTIVE_DRAFT === original) ACTIVE_DRAFT = newName;
          renderManageList();
        };

        input.addEventListener("keydown",(ev)=>{
          if (ev.key==="Enter") commit();
          if (ev.key==="Escape") renderManageList();
        });
        input.addEventListener("blur", commit);
      }
    });
  }

  // Cancel (pink) => discard drafts and close
  if (cancelManageBtn){
    cancelManageBtn.addEventListener("click", ()=>{
      DRAFT = null; DRAFT_ORDER = null; ACTIVE_DRAFT = null;
      closeManageModal();
    });
  }

  // Done (green) => commit drafts & order
  if (doneManage){
    doneManage.addEventListener("click", ()=>{
      if (DRAFT){
        LISTS = DRAFT; DRAFT=null;
        ORDER = ensureOrder(LISTS, DRAFT_ORDER || ORDER);
        ACTIVE = (ACTIVE_DRAFT && (ACTIVE_DRAFT in LISTS)) ? ACTIVE_DRAFT : ACTIVE;
        DRAFT_ORDER = null; ACTIVE_DRAFT = null;
        saveLists(()=>{ renderTabs(); renderList(); });
      }
      closeManageModal();
    });
  }

  // Backdrop click = cancel (discard)
  if (manageModal){
    manageModal.addEventListener("click",(e)=>{
      if (e.target.classList.contains("modal-backdrop")){
        DRAFT = null; DRAFT_ORDER = null; ACTIVE_DRAFT=null;
        closeManageModal();
      }
    });
  }

  // ---------- Init ----------
  loadAll(()=>{ renderTabs(); renderList(); });
})();