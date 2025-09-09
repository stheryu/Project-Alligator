/* popup.js — original 4-line card, right-side post-it tabs, working select-all, X-delete, in-popup Manage (Default undeletable) */
(() => {
  // Logo
  try {
    const logo = document.getElementById("logo");
    if (logo) logo.src = chrome.runtime.getURL("icons/alligator_icon.png");
  } catch {}

  // DOM
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

  // State
  let LISTS = Object.create(null);
  let ACTIVE = "Default";
  const selected = new Set();

  // Helpers
  const keyOf = it => (String(it?.id || it?.link || "")).toLowerCase();
  const domainOf = (link="") => { try { return new URL(String(link)).hostname.replace(/^www\./,""); } catch { return ""; } };
  const escapeHtml = s => String(s||"").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dedupe = (arr)=>{ const seen=new Set(), out=[]; for(const it of arr||[]){ const k=keyOf(it); if(k && !seen.has(k)){ seen.add(k); out.push(it); } } return out; };

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

  // Storage
  function loadAll(cb){
    try {
      chrome.storage.sync.get({ uc_lists:null, uc_active:null, cart:[] }, (res)=>{
        LISTS = res.uc_lists && typeof res.uc_lists==="object" ? res.uc_lists : { "Default": [] };
        if (!("Default" in LISTS)) LISTS["Default"] = LISTS["Default"] || [];
        ACTIVE = typeof res.uc_active==="string" && res.uc_active in LISTS ? res.uc_active : "Default";
        const legacy = Array.isArray(res.cart) ? res.cart : [];
        if (legacy.length){
          LISTS[ACTIVE] = dedupe([...(LISTS[ACTIVE]||[]), ...legacy]);
          chrome.storage.sync.set({ uc_lists: LISTS, cart: [] }, ()=>cb?.());
        } else cb?.();
      });
    } catch { LISTS = { "Default": [] }; ACTIVE="Default"; cb?.(); }
  }
  const saveLists = (cb)=> chrome.storage.sync.set({ uc_lists: LISTS, uc_active: ACTIVE }, cb);

  // Tabs
  const shortTab = (s)=> (s && s.length>12) ? s.slice(0,12)+"…" : (s||"");
  function renderTabs(){
    tabsEl.innerHTML="";
    Object.keys(LISTS).forEach(name=>{
      const tab=document.createElement("div");
      tab.className="tab"+(name===ACTIVE?" active":"");
      tab.textContent = shortTab(name);
      tab.title = name;
      tab.addEventListener("click", ()=>{
        if (ACTIVE!==name){
          ACTIVE=name; selected.clear();
          saveLists(()=>{ renderTabs(); renderList(); });
        }
      });
      tabsEl.appendChild(tab);
    });
  }

  // Totals + select-all reflect
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
    if(!items.length){ toggleAllEl.checked=false; toggleAllEl.indeterminate=false; deleteSelEl.disabled=true; return; }
    const total=items.length;
    const selCount=items.reduce((n,it)=>n+(selected.has(keyOf(it))?1:0),0);
    toggleAllEl.checked = selCount===total;
    toggleAllEl.indeterminate = selCount>0 && selCount<total;
    deleteSelEl.disabled = selCount===0;
  }

  // Build list (4-line card + price at right)
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
      con