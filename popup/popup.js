/* popup.js — original 4-line card, right-side post-it tabs (10ch + ...),
   working select-all, X-delete, Move To, in-popup Manage (Default undeletable) */
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
  const manageList = document.getElementById("manageList");
  const manageClose = document.getElementById("manageClose");
  const addListBtn = document.getElementById("addList");
  const doneManage = document.getElementById("doneManage");

  // ---------- State ----------
  let LISTS = Object.create(null); // { listName: Item[] }
  let ACTIVE = "Default";
  const selected = new Set();      // keys for ACTIVE list

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
  // 10-char truncate with "..." and ALL-CAPS
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
      // centered label; CSS rotates and centers it
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
    const names=Object.keys(LISTS);
    moveMenu.innerHTML = [
      `<div class="mi new" data-act="new">+ New List</div>`,
      ...names.map(n=>`<div class="mi" data-name="${escapeHtml(n)}">${escapeHtml(n)}</div>`),
      `<div class="mi manage" data-act="manage">Manage lists…</div>`
    ].join("");
    const r = moveBtn.getBoundingClientRect();
    const fr = frameEl.getBoundingClientRect();
    moveMenu.style.transform = `translate(${r.left - fr.left}px, ${r.bottom - fr.top + 6}px)`;
    moveMenu.hidden=false;
  }
  function closeMoveMenu(){ moveMenu.hidden=true; moveMenu.style.transform="translate(-9999px,-9999px)"; }

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
      const name=prompt("New list name:");
      if (name && name.trim()){
        const n=name.trim(); if(!LISTS[n]) LISTS[n]=[];
        moveSelectedTo(n);
      }
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

  // ---------- Manage lists modal (Default cannot be deleted) ----------
  function openManageModal(){
    const names=Object.keys(LISTS);
    manageList.innerHTML = names.map(n=>{
      const isDefault = /^default$/i.test(n);
      const deleteHTML = isDefault ? "" : `<a class="link rm" style="color:#B91C1C;">Delete</a>`;
      return `
        <div class="manage-row" data-name="${escapeHtml(n)}">
          <div class="nm">${escapeHtml(n)}</div>
          <a class="link rn" style="color:#111;">Rename</a>
          ${deleteHTML}
        </div>`;
    }).join("");
    manageModal.hidden=false;
  }
  function closeManageModal(){ manageModal.hidden=true; }

  manageList.addEventListener("click",(e)=>{
    e.preventDefault();
    const row = e.target.closest(".manage-row");
    if (!row) return;
    const name = row.dataset.name || "";

    // Delete list (guard Default)
    if (e.target.classList.contains("rm")){
      if (/^default$/i.test(name)) return;
      if (confirm(`Delete list “${name}”?`)){
        const wasActive = (name===ACTIVE);
        delete LISTS[name];
        if (wasActive){
          ACTIVE = "Default";
          if (!LISTS["Default"]) LISTS["Default"] = [];
        }
        saveLists(()=>{ renderTabs(); renderList(); openManageModal(); });
      }
      return;
    }

    // Rename list
    if (e.target.classList.contains("rn")){
      const nm = row.querySelector(".nm");
      const original = name;
      const input = document.createElement("input");
      input.value = original;
      input.setAttribute("maxlength","48");
      nm.replaceWith(input);
      input.focus();
      input.select();

      const commit = ()=> {
        const newName = (input.value || "").trim();
        if (!newName || newName === original) { openManageModal(); return; }
        if (LISTS[newName]) { alert("A list with that name already exists."); openManageModal(); return; }
        LISTS[newName] = LISTS[original];
        delete LISTS[original];
        if (ACTIVE === original) ACTIVE = newName;
        if (!LISTS["Default"]) LISTS["Default"] = [];
        saveLists(()=>{ renderTabs(); renderList(); openManageModal(); });
      };

      input.addEventListener("keydown",(ev)=>{
        if (ev.key==="Enter") commit();
        if (ev.key==="Escape") openManageModal();
      });
      input.addEventListener("blur", commit);
    }
  });

  manageClose.addEventListener("click", closeManageModal);
  doneManage.addEventListener("click", closeManageModal);
  addListBtn.addEventListener("click", ()=>{
    const name=prompt("New list name:");
    if (name && name.trim()){
      const n=name.trim(); if(!LISTS[n]) LISTS[n]=[];
      saveLists(()=>{ renderTabs(); renderList(); openManageModal(); });
    }
  });
  manageModal.addEventListener("click",(e)=>{
    if (e.target.classList.contains("modal-backdrop")) closeManageModal();
  });

  // ---------- Init ----------
  loadAll(()=>{ renderTabs(); renderList(); });
})();