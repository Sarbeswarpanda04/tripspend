/* ============================================================
   TripSpend — app logic (classic script; shares globals with
   firebase-config.js + store.js). Data is stored in Firestore
   per signed-in Google account; no localStorage is used.
   ============================================================ */

/* ---- static data ---- */
let CATS = [];
let METHODS = {};
let CAT_ICONS = [];
let CAT_COLORS = [];
let currencyCode = '';
let currencySymbol = '';
let exchangeRates = {};
let catalogReady = false;
let pendingSettings = null;
let settingsReceived = false;

/* ---- in-memory state (populated by Firestore listeners) ---- */
let trips = [], expenses = [], customCats = [];
let activeTripId = null;
let settings = {theme:'light', homeCurrency:null, activeTripId:null};
let currentTab = 'trips';
let currentUser = null;
let currencyMigrationStarted = false;
let storeReady = false;
let initialLoadError = false;
let initialLoadErrorSource = null;
let inviteJoinInProgress = false;
let pendingJoinedTripId = null;
let discoverable = false;
let collaborationInvites = [];
let collaboratorSearchTimer = null;
let collaboratorSearchRun = 0;
let pendingInviteId = new URLSearchParams(window.location.search).get('invite');

const uid = ()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const icon = cls => `<i class="${cls}"></i>`;
const esc = s => (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ============ Auth + data sync ============ */
function showLogin(){
  document.getElementById('login').classList.add('show');
  document.getElementById('app').style.display='none';
}
function showApp(){
  document.getElementById('login').classList.remove('show');
  document.getElementById('app').style.display='flex';
  document.getElementById('splash').classList.remove('hide');
}
function hideSplash(){ document.getElementById('splash').classList.add('hide'); }

function initialAvatar(name){
  const ch=(name||'?').trim().charAt(0).toUpperCase()||'?';
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="40" fill="#6a6ff0"/><text x="40" y="52" font-family="Arial" font-size="36" font-weight="700" fill="#fff" text-anchor="middle">${ch}</text></svg>`;
  return 'data:image/svg+xml;utf8,'+encodeURIComponent(svg);
}
function setAvatar(user){
  const img=document.getElementById('avatarBtn');
  img.src = user.photoURL || initialAvatar(user.displayName||user.email);
  img.onerror=()=>{ img.onerror=null; img.src=initialAvatar(user.displayName||user.email); };
}

function onStoreData(kind, data){
  if(kind==='error'){
    handleErr(data?.error||data);
    if(!storeReady&&['trips','expenses','settings','catalog'].includes(data?.source)){
      initialLoadError=true;
      initialLoadErrorSource=data.source;
      storeReady=true;
      render();
    }
    return;
  }
  if(kind==='catalog'){
    if(!isValidCatalog(data)){
      onStoreData('error',{source:'catalog',error:new Error('Shared Firebase catalog is missing or invalid.')});
      return;
    }
    const migrationChanged=currencyCode!==data.currencyCode||
      JSON.stringify(exchangeRates)!==JSON.stringify(data.exchangeRates);
    CATS=data.categories;
    METHODS=data.paymentMethods;
    CAT_ICONS=data.categoryIcons;
    CAT_COLORS=data.categoryColors;
    currencyCode=data.currencyCode;
    currencySymbol=data.currencySymbol;
    exchangeRates=data.exchangeRates;
    catalogReady=true;
    if(initialLoadErrorSource==='catalog'){
      initialLoadError=false;
      initialLoadErrorSource=null;
    }
    if(migrationChanged) currencyMigrationStarted=false;
    if(settingsReceived) applyRemoteSettings(pendingSettings);
  } else if(kind==='trips'){
    trips = data;
  } else if(kind==='expenses'){
    expenses = data;
  } else if(kind==='settings'){
    pendingSettings=data;
    settingsReceived=true;
    if(catalogReady) applyRemoteSettings(data);
  } else if(kind==='cats'){
    customCats = data;
  } else if(kind==='discoverable'){
    discoverable = !!data;
    const displayName=currentUser?.displayName;
    const photoURL=currentUser?.photoURL||null;
    if(data && displayName &&
      (data.displayName!==displayName || (data.photoURL||null)!==photoURL)){
      Store.setDiscoverable(true,displayName,photoURL).catch(handleErr);
    }
  } else if(kind==='collaborationInvites'){
    collaborationInvites = data;
  } else if(kind==='ready'){
    storeReady=true;
    initialLoadError=!catalogReady;
    initialLoadErrorSource=initialLoadError?'catalog':null;
    hideSplash();
  }
  normalizeCurrencyData();
  if(storeReady) render();

  if(pendingJoinedTripId && getTrip(pendingJoinedTripId)){
    activeTripId=pendingJoinedTripId;
    pendingJoinedTripId=null;
    setTab('expenses');
    toast('You joined the trip');
  }
}

function isValidCatalog(data){
  const validIcon=value=>typeof value==='string'&&/^[A-Za-z0-9 -]{1,80}$/.test(value);
  return data&&
    typeof data.currencyCode==='string'&&/^[A-Z]{3}$/.test(data.currencyCode)&&
    typeof data.currencySymbol==='string'&&data.currencySymbol.length>0&&data.currencySymbol.length<=8&&
      !/[&<>"']/.test(data.currencySymbol)&&
    Array.isArray(data.categories)&&data.categories.length>0&&data.categories.every(category=>
      category&&typeof category.id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(category.id)&&
      typeof category.name==='string'&&category.name.length>0&&category.name.length<=40&&
      validIcon(category.ic)&&typeof category.c==='string'&&/^#[0-9A-Fa-f]{6}$/.test(category.c))&&
    Array.isArray(data.categoryIcons)&&data.categoryIcons.length>0&&data.categoryIcons.every(validIcon)&&
    Array.isArray(data.categoryColors)&&data.categoryColors.length>0&&data.categoryColors.every(color=>
      typeof color==='string'&&/^#[0-9A-Fa-f]{6}$/.test(color))&&
    data.paymentMethods&&typeof data.paymentMethods==='object'&&Object.keys(data.paymentMethods).length>0&&
    Object.entries(data.paymentMethods).every(([id,method])=>
      /^[A-Za-z0-9_-]{1,40}$/.test(id)&&method&&typeof method.name==='string'&&
      method.name.length>0&&method.name.length<=40&&validIcon(method.ic))&&
    data.exchangeRates&&typeof data.exchangeRates==='object'&&
    Object.entries(data.exchangeRates).every(([code,rate])=>
      /^[A-Z]{3}$/.test(code)&&Number.isFinite(rate)&&rate>0)&&
    Number.isFinite(data.exchangeRates[data.currencyCode])&&data.exchangeRates[data.currencyCode]>0;
}

function applyRemoteSettings(data){
  if(!catalogReady) return;
  if(data){
    if(data.theme) settings.theme=data.theme;
    if('activeTripId' in data) activeTripId=data.activeTripId;
    settings.homeCurrency=currencyCode;
    applyTheme();
    if(data.homeCurrency!==currencyCode){
      Store.saveSettings({homeCurrency:currencyCode}).catch(handleErr);
    }
  } else if(currentUser){
    settings.homeCurrency=currencyCode;
    Store.saveSettings({theme:settings.theme,homeCurrency:currencyCode,activeTripId}).catch(handleErr);
  }
}

function normalizeCurrencyData(){
  if(currencyMigrationStarted || !storeReady || !catalogReady) return;
  const ownedTrips=trips.filter(trip=>trip.ownerUid===currentUser?.uid);
  const missingRate=ownedTrips.find(trip=>trip.currency&&trip.currency!==currencyCode&&
    (!exchangeRates[trip.currency]||!exchangeRates[currencyCode]));
  if(missingRate){
    currencyMigrationStarted=true;
    handleErr(new Error(`Shared catalog is missing an exchange rate for ${missingRate.currency}.`));
    return;
  }
  currencyMigrationStarted = true;

  ownedTrips.forEach(trip=>{
    const from = trip.currency || currencyCode;
    if(from === currencyCode){
      if(trip.currency !== currencyCode){
        trip.currency = currencyCode;
        Store.saveTrip(trip).catch(handleErr);
      }
      return;
    }
    if(trip.budget) trip.budget = convert(trip.budget, from, currencyCode);
    trip.currency = currencyCode;
    Store.saveTrip(trip).catch(handleErr);
    expenses.filter(expense=>expense.ownerUid===currentUser?.uid&&expense.tripId===trip.id).forEach(expense=>{
      expense.amount = convert(expense.amount, from, currencyCode);
      delete expense.oc;
      delete expense.oa;
      Store.saveExpense(expense).catch(handleErr);
    });
  });

  expenses.filter(expense=>expense.ownerUid===currentUser?.uid&&(expense.oc || expense.oa != null)).forEach(expense=>{
    delete expense.oc;
    delete expense.oa;
    Store.saveExpense(expense).catch(handleErr);
  });
}

function handleErr(err){
  hideSplash();
  console.error('Firestore error:', err);
  if(err && err.code==='permission-denied'){
    toast('Access blocked — check Firestore rules');
  } else {
    toast('Sync error — check Firebase access');
  }
}
function loginMsg(t){ const el=document.getElementById('loginMsg'); if(el) el.textContent=t; }
function signIn(){
  loginMsg('Opening Google sign-in…');
  auth.signInWithPopup(googleProvider).catch(err=>{
    if(err.code==='auth/popup-blocked'||err.code==='auth/operation-not-supported-in-this-environment'){
      loginMsg('Redirecting to Google sign-in…');
      return auth.signInWithRedirect(googleProvider).catch(showSignInErr);
    }
    showSignInErr(err);
  });
}
function showSignInErr(err){
  console.error('Sign-in error:', err);
  if(err.code==='auth/unauthorized-domain'){
    loginMsg('This domain isn’t authorised in Firebase Auth settings.');
  } else if(err.code==='auth/popup-blocked'){
    loginMsg('Your browser blocked the sign-in window. Allow pop-ups and try again.');
  } else if(err.code==='auth/popup-closed-by-user'){
    loginMsg('Sign-in cancelled. Tap to try again.');
  } else {
    loginMsg('Could not sign in: '+(err.message||err.code||'unknown error'));
  }
}
function doSignOut(){
  closeSheet();
  auth.signOut().catch(()=>{});
}

function clearInviteFromUrl(){
  const url=new URL(window.location.href);
  url.searchParams.delete('invite');
  window.history.replaceState({},'',url);
  pendingInviteId=null;
}
async function joinPendingInvite(user){
  if(!pendingInviteId || inviteJoinInProgress) return;
  inviteJoinInProgress=true;
  try{
    const trip=await Store.acceptTripInvite(pendingInviteId);
    clearInviteFromUrl();
    pendingJoinedTripId=trip.tripId;
    activeTripId=trip.tripId;
    Store.saveSettings({activeTripId}).catch(handleErr);
    if(getTrip(trip.tripId)){
      pendingJoinedTripId=null;
      setTab('expenses');
    } else {
      toast(`Joined ${trip.tripName||'the trip'} — loading`);
    }
  } catch(err){
    console.error('Trip invite error:',err);
    toast(err.message||'Could not join this trip. Check Firebase access.');
  } finally {
    inviteJoinInProgress=false;
  }
}

auth.onAuthStateChanged(user=>{
  if(user){
    currentUser=user;
    CATS=[]; METHODS={}; CAT_ICONS=[]; CAT_COLORS=[];
    currencyCode=''; currencySymbol=''; exchangeRates={}; catalogReady=false;
    pendingSettings=null; settingsReceived=false; initialLoadErrorSource=null;
    currencyMigrationStarted=false;
    storeReady=false;
    initialLoadError=false;
    pendingJoinedTripId=null;
    setAvatar(user);
    showApp();
    Store.setUser(user.uid);
    Store.subscribe(onStoreData);
    joinPendingInvite(user);
  } else {
    currentUser=null;
    CATS=[]; METHODS={}; CAT_ICONS=[]; CAT_COLORS=[];
    currencyCode=''; currencySymbol=''; exchangeRates={}; catalogReady=false;
    pendingSettings=null; settingsReceived=false; initialLoadErrorSource=null;
    storeReady=false;
    initialLoadError=false;
    currencyMigrationStarted=false;
    discoverable=false;
    collaborationInvites=[];
    Store.stop();
    trips=[]; expenses=[]; customCats=[]; activeTripId=null;
    pendingJoinedTripId=null;
    loginMsg(pendingInviteId?'Sign in with Google to join this trip.':'Your data is private to your account.');
    showLogin();
  }
},err=>{
  console.error('Auth state error:',err);
  loginMsg('Sign-in session error: '+(err.message||err.code||'unknown error'));
});
/* Surface any redirect-based sign-in error. */
auth.getRedirectResult().catch(showSignInErr);

/* ============ helpers ============ */
const allCats = ()=> CATS.concat(customCats);
const catOf = id => allCats().find(c=>c.id===id) || CATS[0];
function convert(amt, from, to){
  if(from===to) return amt;
  const rf=exchangeRates[from], rt=exchangeRates[to];
  if(!Number.isFinite(rf)||rf<=0||!Number.isFinite(rt)||rt<=0){
    throw new Error(`Shared catalog is missing exchange rates for ${from} or ${to}.`);
  }
  return amt * rf / rt;
}
const getTrip = id => trips.find(t=>t.id===id);
const tripExpenses = id => expenses.filter(e=>e.tripId===id)
  .sort((a,b)=> b.date.localeCompare(a.date) || (b.createdAt||0)-(a.createdAt||0));
const spent = id => tripExpenses(id).reduce((s,e)=>s+e.amount,0);
const sym = () => currencySymbol;
const currencyLabel = () => `${currencySymbol} ${currencyCode}`;
function fmtNum(v){
  v = Math.round((v+Number.EPSILON)*100)/100;
  return v.toLocaleString(undefined,{minimumFractionDigits:(v%1?2:0),maximumFractionDigits:2});
}
function money(n, tripId){ return sym(tripId)+fmtNum(n); }
const todayISO = ()=>{
  const date=new Date();
  date.setMinutes(date.getMinutes()-date.getTimezoneOffset());
  return date.toISOString().slice(0,10);
};
function fmtDate(iso){
  const d=new Date(iso+'T00:00:00'); const t=new Date(todayISO()+'T00:00:00');
  const diff=Math.round((t-d)/864e5);
  if(diff===0) return 'Today';
  if(diff===1) return 'Yesterday';
  return d.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'});
}
const shortDate = iso => new Date(iso+'T00:00:00').toLocaleDateString(undefined,{day:'numeric',month:'short'});
function tripDates(t){
  if(t.startDate && t.endDate){
    const s=new Date(t.startDate+'T00:00:00'), e=new Date(t.endDate+'T00:00:00');
    const total=Math.round((e-s)/864e5)+1;
    const now=new Date(todayISO()+'T00:00:00');
    let elapsed = Math.round((now-s)/864e5)+1;
    elapsed = Math.max(0, Math.min(total, elapsed));
    const left = Math.max(0, total-elapsed);
    let status = now<s?'upcoming' : now>e?'ended' : 'active';
    return {total, elapsed, left, status, s, e};
  }
  return null;
}

let toastT;
function toast(msg){
  const el=document.getElementById('toast'); if(!el) return;
  el.textContent=msg; el.classList.add('show');
  clearTimeout(toastT); toastT=setTimeout(()=>el.classList.remove('show'),1900);
}

/* ---- navigation ---- */
function setTab(tab){
  currentTab = tab;
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById('s-'+tab).classList.add('active');
  document.querySelectorAll('.nav button[data-tab]').forEach(b=>
    b.classList.toggle('active', b.dataset.tab===tab));
  document.getElementById('s-'+tab).scrollTop=0;
  render();
}
/* ---- master render ---- */
function render(){
  if(initialLoadError){
    const errorHtml=`<div class="empty"><div class="em"><i class="fa-solid fa-cloud-arrow-down"></i></div>
      <h3>Could not load app data</h3><p>Check Firestore access and confirm the shared catalog exists, then try again.</p>
      <div style="margin-top:20px"><button class="btn sm" style="margin:0 auto" onclick="retryDataSync()">Try again</button></div></div>`;
    document.querySelectorAll('.screen').forEach(screen=>screen.innerHTML=errorHtml);
    hideSplash();
    return;
  }
  const t = getTrip(activeTripId);
  const header = document.getElementById('header');
  const needsTrip = ['expenses','analysis','budget'].includes(currentTab);
  header.classList.toggle('has-back', currentTab!=='trips' && !!t);
  if(currentTab==='trips'){
    document.getElementById('hTitle').textContent = greeting();
    document.getElementById('hSub').textContent = trips.length
      ? trips.length+' trip'+(trips.length>1?'s':'')+' · '+money(grandTotal())+' '+currencyCode
      : 'Let’s plan your first trip';
  } else if(t){
    document.getElementById('hTitle').textContent=t.name;
    const cap = {expenses:'Expenses',analysis:'Analysis',budget:'Budget'}[currentTab];
    document.getElementById('hSub').textContent=cap+' · '+money(spent(t.id),t.id)+' spent';
  } else {
    document.getElementById('hTitle').textContent=({expenses:'Expenses',analysis:'Analysis',budget:'Budget'}[currentTab])||'TripSpend';
    document.getElementById('hSub').textContent='No trip selected';
  }
  renderTrips();
  if(needsTrip && !t){ renderNoTrip(currentTab); return; }
  renderExpenses(); renderAnalysis(); renderBudget();
}
function retryDataSync(){
  initialLoadError=false;
  storeReady=false;
  showApp();
  Store.subscribe(onStoreData);
}
function greeting(){
  const h=new Date().getHours();
  const g = h<12?'Good morning':h<18?'Good afternoon':'Good evening';
  const n=(currentUser&&currentUser.displayName)?currentUser.displayName.split(' ')[0]:'';
  return n? `${g}, ${n}` : 'TripSpend';
}
function grandTotal(){
  return trips.reduce((s,t)=>s+spent(t.id),0);
}
function renderNoTrip(tab){
  document.getElementById('s-'+tab).innerHTML =
    `<div class="empty"><div class="em"><i class="fa-solid fa-compass"></i></div><h3>No trip selected</h3>
     <p>Create or open a trip first to track expenses here.</p>
     <div style="margin-top:20px"><button class="btn sm" style="margin:0 auto" onclick="setTab('trips')">Go to Trips</button></div></div>`;
}
/* ---- TRIPS screen ---- */
function renderTrips(){
  const el = document.getElementById('s-trips');
  const inviteInbox = collaborationInvites.length
    ? `<div class="section-title">Trip invitations</div>${collaborationInvites.map(invite=>`
        <div class="card">
          <div class="row between" style="gap:12px">
            <div style="min-width:0"><strong>${esc(invite.tripName)}</strong>
              <div class="small muted" style="margin-top:4px">${esc(invite.ownerName)} invited you to collaborate</div></div>
            <button class="btn sm" onclick="acceptCollaborationInvite('${esc(invite.id)}')">Accept</button>
          </div>
        </div>`).join('')}`
    : '';
  if(!trips.length){
    el.innerHTML = inviteInbox + `<div class="empty"><div class="em"><i class="fa-solid fa-suitcase-rolling"></i></div><h3>No trips yet</h3>
      <p>Create your first trip to start tracking where your money goes.</p>
      <div style="margin-top:20px"><button class="btn" style="max-width:230px;margin:0 auto" onclick="openTripSheet()">${icon('fa-solid fa-plus')} Create trip</button></div></div>`;
    return;
  }
  const grand = grandTotal();
  let h = inviteInbox + `<div class="grand"><div class="row between">
      <div><div class="lbl">Total across all trips</div>
        <div class="val">${money(grand)}</div></div>
      <div style="text-align:right"><div class="lbl">in ${currencyCode}</div>
        <div style="font-size:13px;margin-top:4px;font-weight:700">${trips.length} trip${trips.length>1?'s':''}</div></div>
    </div></div>
    <div class="row between" style="margin:2px 2px 6px">
      <div class="section-title" style="margin:0">Your trips</div>
      <button class="btn sm ghost" onclick="openTripSheet()">${icon('fa-solid fa-plus')} New</button></div>`;
  trips.slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).forEach(t=>{
    const sp=spent(t.id), b=t.budget||0;
    const pct = b? Math.min(100, sp/b*100) : 0;
    const over = b && sp>b, warn = b && !over && pct>=80;
    const rem = b - sp;
    const cnt = tripExpenses(t.id).length;
    const active = t.id===activeTripId;
    const d = tripDates(t);
    h += `<div class="card trip-card ${active?'active':''}" onclick="openTrip('${t.id}')">
      <span class="accent"></span>
      <div class="row between"><h3>${esc(t.name)}</h3>
        <div class="row">${t.ownerUid===currentUser?.uid?`<button class="link" onclick="openInviteFromCard(event,'${t.id}')">Invite</button>`:''}
        ${t.ownerUid!==currentUser?.uid?'<span class="pill">Shared</span>':''}<span class="pill">${esc(currencyLabel())}</span></div></div>
      ${d? `<div class="small muted" style="padding-left:8px;margin-top:3px">
        <i class="fa-regular fa-calendar"></i> ${shortDate(t.startDate)} – ${shortDate(t.endDate)}
        · ${d.status==='upcoming'?'upcoming':d.status==='ended'?'ended':d.left+' day'+(d.left!==1?'s':'')+' left'}</div>`:''}
      <div class="row between small" style="padding-left:8px;margin-top:6px">
        <span class="muted">${cnt} expense${cnt!==1?'s':''}</span>
        <span style="font-weight:800">${money(sp,t.id)}${b?` <span class="muted" style="font-weight:600">/ ${money(b,t.id)}</span>`:''}</span></div>`;
    if(b){
      h += `<div class="bar ${over?'over':warn?'warn':''}"><span style="width:${pct}%"></span></div>
        <div class="small" style="padding-left:8px;margin-top:7px;${over?'color:var(--red);font-weight:700':'color:var(--muted)'}">
          ${over? `Over budget by ${money(-rem,t.id)}` : `${money(rem,t.id)} remaining`}</div>`;
    }
    h += `</div>`;
  });
  el.innerHTML = h;
}
/* ---- EXPENSES screen ---- */
function renderExpenses(){
  const el = document.getElementById('s-expenses');
  const t = getTrip(activeTripId); if(!t) return;
  const list = tripExpenses(t.id);
  let h = `<div class="row between" style="margin:8px 2px 14px">
      <div><div class="small muted">Total spent</div>
        <div style="font-size:26px;font-weight:800">${money(spent(t.id),t.id)}</div></div>
      <button class="btn sm" onclick="openExpSheet()">${icon('fa-solid fa-plus')} Add</button></div>`;
  if(!list.length){
    el.innerHTML = h + `<div class="empty"><div class="em"><i class="fa-solid fa-receipt"></i></div><h3>No expenses yet</h3>
      <p>Tap “Add” or the ＋ button to log your first spend.</p></div>`;
    return;
  }
  const groups = {};
  list.forEach(e=>{ (groups[e.date]=groups[e.date]||[]).push(e); });
  Object.keys(groups).sort((a,b)=>b.localeCompare(a)).forEach(date=>{
    const items = groups[date];
    const dtot = items.reduce((s,e)=>s+e.amount,0);
    h += `<div class="day-group"><div class="day-head"><span>${fmtDate(date)}</span>
      <span class="dtot">${money(dtot,t.id)}</span></div>`;
    items.forEach(e=>{
      const c = catOf(e.category);
      const firstMethod=Object.values(METHODS)[0];
      const m = METHODS[e.method]||{name:e.method||firstMethod.name,ic:firstMethod.ic};
      const lead = e.photo
        ? `<img class="thumb" src="${e.photo}" alt="">`
        : `<div class="cat-ic" style="background:${c.c}22;color:${c.c}">${icon(c.ic)}</div>`;
      h += `<div class="exp" onclick="openExpSheet('${e.id}')">
        ${lead}
        <div class="info"><div class="t">${esc(e.note)||c.name}</div>
          <div class="d">${esc(c.name)} <span class="tag">${icon(m.ic)} ${esc(m.name)}</span></div></div>
        <div class="amt">${money(e.amount,t.id)}</div></div>`;
    });
    h += `</div>`;
  });
  el.innerHTML = h;
}
/* ---- ANALYSIS screen ---- */
function renderAnalysis(){
  const el = document.getElementById('s-analysis');
  const t = getTrip(activeTripId); if(!t) return;
  const list = tripExpenses(t.id);
  const sp = spent(t.id);
  if(!list.length){
    el.innerHTML = `<div class="empty"><div class="em"><i class="fa-solid fa-chart-simple"></i></div><h3>Nothing to analyse</h3>
      <p>Add some expenses and your spending breakdown will appear here.</p></div>`;
    return;
  }
  const days=[...new Set(list.map(e=>e.date))];
  const nDays=days.length, avg=sp/nDays;
  const dayTotals={}; list.forEach(e=> dayTotals[e.date]=(dayTotals[e.date]||0)+e.amount);
  const topDay=Object.entries(dayTotals).sort((a,b)=>b[1]-a[1])[0];
  const catTot={}; list.forEach(e=> catTot[e.category]=(catTot[e.category]||0)+e.amount);
  const catRows=Object.entries(catTot).sort((a,b)=>b[1]-a[1]);
  const maxCat=catRows[0][1]||1;

  let h = `<div class="stats" style="margin-top:8px">
    <div class="stat big"><div class="lbl">Total spent</div><div class="val" style="font-size:30px">${money(sp,t.id)}</div></div>
    <div class="stat"><div class="lbl">Avg / day</div><div class="val">${money(avg,t.id)}</div></div>
    <div class="stat"><div class="lbl">Days active</div><div class="val">${nDays}</div></div>
    <div class="stat"><div class="lbl">Transactions</div><div class="val">${list.length}</div></div>
    <div class="stat"><div class="lbl">Highest day</div><div class="val" style="font-size:17px">${money(topDay[1],t.id)}<div class="small muted" style="font-weight:600">${fmtDate(topDay[0])}</div></div></div>
    </div>`;

  if(t.budget){
    const rem=t.budget-sp, over=sp>t.budget, pct=Math.min(100,sp/t.budget*100);
    h += `<div class="card"><div class="row between" style="margin-bottom:8px">
        <span class="section-title" style="margin:0">Budget</span>
        <span class="small" style="font-weight:800;${over?'color:var(--red)':'color:var(--green)'}">${over?'Over by '+money(-rem,t.id):money(rem,t.id)+' left'}</span></div>
      <div class="bar ${over?'over':''}" style="height:13px"><span style="width:${pct}%"></span></div>
      <div class="small muted" style="margin-top:8px">${money(sp,t.id)} of ${money(t.budget,t.id)} · ${pct.toFixed(0)}%</div></div>`;
  }

  h += `<div class="section-title">By category</div><div class="card">`;
  catRows.forEach(([cid,amt])=>{ const c=catOf(cid); const p=amt/sp*100;
    h += `<div class="abar"><div class="top"><span>${icon(c.ic)} ${esc(c.name)}</span>
        <span>${money(amt,t.id)} <span class="muted">${p.toFixed(0)}%</span></span></div>
      <div class="track"><span style="width:${(amt/maxCat*100)}%;background:${c.c}"></span></div></div>`;
  });
  h += `</div>`;

  h += `<div class="section-title">Day by day</div><div class="card">`;
  const maxDay=Math.max(...Object.values(dayTotals))||1;
  Object.keys(dayTotals).sort((a,b)=>a.localeCompare(b)).forEach(d=>{ const amt=dayTotals[d];
    h += `<div class="abar"><div class="top"><span>${fmtDate(d)}</span><span>${money(amt,t.id)}</span></div>
      <div class="track"><span style="width:${amt/maxDay*100}%;background:var(--primary)"></span></div></div>`;
  });
  h += `</div>`;

  const mTot={}; list.forEach(e=>{ const k=e.method||Object.keys(METHODS)[0]; if(k) mTot[k]=(mTot[k]||0)+e.amount; });
  h += `<div class="section-title">By payment method</div><div class="card">`;
  Object.entries(mTot).sort((a,b)=>b[1]-a[1]).forEach(([k,amt])=>{ const firstMethod=Object.values(METHODS)[0]; const m=METHODS[k]||{name:k,ic:firstMethod.ic}; const p=amt/sp*100;
    h += `<div class="abar"><div class="top"><span>${icon(m.ic)} ${esc(m.name)}</span>
        <span>${money(amt,t.id)} <span class="muted">${p.toFixed(0)}%</span></span></div>
      <div class="track"><span style="width:${p}%;background:var(--primary-d)"></span></div></div>`;
  });
  h += `</div>`;

  const trav=t.travelers||[];
  if(trav.length){
    const st=computeSettle(t);
    h += `<div class="section-title">Split summary</div><div class="card">`;
    st.balances.forEach(b=>{ h += `<div class="bal"><span>${esc(b.name)}</span>
        <span class="${b.net>=0?'pos':'neg'}">${b.net>=0?'gets back ':'owes '}${money(Math.abs(b.net),t.id)}</span></div>`; });
    h += `</div>`;
    if(st.transfers.length){
      h += `<div class="section-title">Who pays whom</div><div class="card">`;
      st.transfers.forEach(x=>{ h += `<div class="settle"><span class="who">${esc(x.from)} → ${esc(x.to)}</span>
          <span class="amt">${money(x.amt,t.id)}</span></div>`; });
      h += `</div>`;
    } else h += `<div class="card small muted" style="text-align:center">All settled up 🎉</div>`;
  }
  el.innerHTML = h;
}
function computeSettle(t){
  const trav=t.travelers||[];
  const net={}; trav.forEach(v=>net[v.id]=0);
  tripExpenses(t.id).forEach(e=>{
    if(!e.paidBy || !e.participants || !e.participants.length) return;
    if(net[e.paidBy]==null) return;
    const participants=[...new Set(e.participants.filter(id=>net[id]!=null))];
    if(!participants.length) return;
    net[e.paidBy]+=e.amount;
    const share=e.amount/participants.length;
    participants.forEach(id=>{ net[id]-=share; });
  });
  const balances=trav.map(v=>({name:v.name, net:Math.round(net[v.id]*100)/100}));
  const cred=balances.filter(b=>b.net>0.005).map(b=>({...b})).sort((a,b)=>b.net-a.net);
  const debt=balances.filter(b=>b.net<-0.005).map(b=>({...b, net:-b.net})).sort((a,b)=>b.net-a.net);
  const transfers=[]; let i=0,j=0;
  while(i<debt.length && j<cred.length){
    const pay=Math.min(debt[i].net, cred[j].net);
    transfers.push({from:debt[i].name, to:cred[j].name, amt:Math.round(pay*100)/100});
    debt[i].net-=pay; cred[j].net-=pay;
    if(debt[i].net<0.005) i++;
    if(cred[j].net<0.005) j++;
  }
  return {balances, transfers};
}

/* ---- BUDGET screen ---- */
function renderBudget(){
  const el = document.getElementById('s-budget');
  const t = getTrip(activeTripId); if(!t) return;
  const sp=spent(t.id), b=t.budget||0, rem=b-sp, over=b&&sp>b;
  const pct = b? Math.min(100,sp/b*100):0;
  const list=tripExpenses(t.id);
  const days=[...new Set(list.map(e=>e.date))].length||1;
  const dailyBudget = b? b/Math.max(days,1):0;
  const avg = list.length? sp/days:0;

  let h = `<div class="stat big" style="text-align:center;padding:24px;margin-top:8px">
      <div class="lbl">${over?'Over budget':'Remaining'}</div>
      <div class="val" style="font-size:38px;${over?'color:#ffd9df':''}">${b? money(Math.abs(rem),t.id):'—'}</div>
      ${b?`<div class="small" style="color:#dbe4ff;margin-top:6px">of ${money(b,t.id)} budget</div>`:''}</div>`;

  if(b){
    h += `<div class="card">
      <div class="bar ${over?'over':''}" style="height:15px"><span style="width:${pct}%"></span></div>
      <div class="row between small" style="margin-top:10px">
        <span class="muted">Spent ${money(sp,t.id)}</span><span style="font-weight:800">${pct.toFixed(0)}%</span></div></div>
      <div class="stats">
        <div class="stat"><div class="lbl">Avg spend / day</div><div class="val" style="font-size:19px">${money(avg,t.id)}</div></div>
        <div class="stat"><div class="lbl">Budget / day</div><div class="val" style="font-size:19px">${money(dailyBudget,t.id)}</div></div></div>`;
    if(over) h+=`<div class="card" style="border-color:var(--red)"><div class="row" style="gap:12px">
        <span style="font-size:22px;color:var(--red)"><i class="fa-solid fa-triangle-exclamation"></i></span><div class="small">You've exceeded this trip's budget by <b style="color:var(--red)">${money(-rem,t.id)}</b>.</div></div></div>`;
  } else {
    h += `<div class="empty" style="padding:34px 10px"><div class="em"><i class="fa-solid fa-wallet"></i></div>
      <p>No budget set for this trip yet.</p></div>`;
  }
  const d=tripDates(t);
  if(d){
    h += `<div class="section-title">Trip dates</div><div class="card">
      <div class="row between" style="margin-bottom:12px">
        <span class="small muted"><i class="fa-regular fa-calendar"></i> ${shortDate(t.startDate)} – ${shortDate(t.endDate)}</span>
        <span class="pill">${d.status==='upcoming'?'Upcoming':d.status==='ended'?'Ended':'Active'}</span></div>
      <div class="stats" style="margin:0">
        <div class="stat"><div class="lbl">Day</div><div class="val" style="font-size:19px">${Math.min(d.elapsed,d.total)} / ${d.total}</div></div>
        <div class="stat"><div class="lbl">Days left</div><div class="val" style="font-size:19px">${d.left}</div></div></div>`;
    if(b && d.status!=='upcoming'){
      const expected=b*Math.min(d.elapsed,d.total)/d.total;
      const diff=sp-expected;
      const perDayLeft = d.left>0? (b-sp)/d.left : 0;
      h += `<div style="margin-top:14px" class="small">
        <div class="row between" style="padding:5px 0"><span class="muted">Expected by now</span><span style="font-weight:700">${money(expected,t.id)}</span></div>
        <div class="row between" style="padding:5px 0"><span class="muted">Pace</span>
          <span style="font-weight:800;color:${diff>0?'var(--red)':'var(--green)'}">${diff>0?money(diff,t.id)+' over':money(-diff,t.id)+' under'}</span></div>
        ${d.left>0?`<div class="row between" style="padding:5px 0"><span class="muted">Safe to spend / day</span>
          <span style="font-weight:800;color:${perDayLeft<0?'var(--red)':'var(--text)'}">${money(Math.max(0,perDayLeft),t.id)}</span></div>`:''}</div>`;
    }
    h += `</div>`;
  }
  h += `<button class="btn ghost" onclick="openBudgetSheet()">${b?'Edit budget':'Set a budget'}</button>
    ${t.ownerUid===currentUser?.uid?`<button class="btn ghost" style="margin-top:12px" onclick="openInviteSheet('${t.id}')">${icon('fa-solid fa-user-plus')} Invite collaborators</button>`:''}
    <button class="btn ghost" style="margin-top:12px" onclick="openTripSheet('${t.id}')">${icon('fa-solid fa-pen')} Edit trip details</button>
    ${t.ownerUid===currentUser?.uid?`<button class="btn danger" style="margin-top:12px" onclick="confirmDeleteTrip('${t.id}')">${icon('fa-solid fa-trash-can')} Delete this trip</button>`:''}`;
  el.innerHTML = h;
}
/* ============ Sheets / modals ============ */
const overlay = document.getElementById('overlay');
const sheet = document.getElementById('sheet');
function openSheet(html){ sheet.innerHTML='<div class="grab"></div>'+html; overlay.classList.add('open'); }
function closeSheet(){ overlay.classList.remove('open'); }
overlay.addEventListener('click', e=>{ if(e.target===overlay) closeSheet(); });

function openTrip(id){ activeTripId=id; Store.saveSettings({activeTripId:id}).catch(()=>{}); setTab('expenses'); }
function openInviteFromCard(event,id){
  event.stopPropagation();
  openInviteSheet(id);
}

function inviteUrl(inviteId){
  const url=new URL(window.location.href);
  url.searchParams.set('invite',inviteId);
  url.hash='';
  return url.toString();
}
function openInviteSheet(id){
  const trip=getTrip(id);
  if(!trip || trip.ownerUid!==currentUser?.uid){
    toast('Only the trip owner can create or manage invite links');
    return;
  }
  collaboratorSearchRun++;
  clearTimeout(collaboratorSearchTimer);
  const link=trip.inviteId?inviteUrl(trip.inviteId):'';
  openSheet(`<h2>Invite collaborators</h2>
    <p class="small muted" style="margin-bottom:16px">Invite a TripSpend user by display name, or share a link. Users must accept before they can access this trip.</p>
    <div class="field"><label>Collaborators</label>
      <div id="tripCollaborators" class="small muted">Loading collaborators…</div></div>
    <div class="field"><label>Find a user</label>
      <input id="collaboratorSearch" type="search" placeholder="Type at least 2 characters" oninput="searchCollaborators('${id}',this.value)">
      <div id="collaboratorResults" class="small muted" style="margin-top:10px">Only users who opted into discovery appear here.</div></div>
    ${link?`<div class="field"><label>Invite link</label><input id="inviteUrl" readonly value="${esc(link)}"></div>
      <button class="btn" onclick="shareInviteLink('${id}')">${icon('fa-solid fa-link')} Share invite link</button>
      <button class="btn danger" style="margin-top:10px" onclick="revokeTripInvite('${id}')">Revoke invite link</button>`
      :`<button class="btn" onclick="createTripInvite('${id}')">${icon('fa-solid fa-link')} Create invite link</button>`}
    <button class="btn ghost" style="margin-top:10px" onclick="closeSheet()">Done</button>`);
  loadTripCollaborators(id);
}
async function loadTripCollaborators(tripId){
  const run=collaboratorSearchRun;
  const box=document.getElementById('tripCollaborators');
  if(!box) return;
  try{
    const members=await Store.getTripMembers(currentUser.uid,tripId);
    if(run!==collaboratorSearchRun) return;
    if(!members.length){
      box.className='small muted';
      box.textContent='No collaborators have joined yet.';
      return;
    }
    box.className='';
    box.innerHTML=members.map(member=>`<div class="row between" style="gap:10px;padding:9px 0;border-bottom:1px solid var(--line)">
      <div class="row" style="gap:9px;min-width:0">
        <img class="collaborator-avatar" src="${esc(member.photoURL||initialAvatar(member.displayName||'Traveler'))}" alt="">
        <span style="font-weight:650">${esc(member.displayName||'Trip traveler')}</span></div>
      <button class="btn sm ghost" data-remove-uid="${esc(member.uid)}">Remove</button></div>`).join('');
    box.querySelectorAll('[data-remove-uid]').forEach(button=>button.addEventListener('click',()=>
      removeTripCollaborator(tripId,button.dataset.removeUid,button)));
  } catch(err){
    if(run!==collaboratorSearchRun) return;
    console.error('Collaborator list error:',err);
    box.className='small muted';
    box.textContent='Could not load collaborators.';
  }
}
async function removeTripCollaborator(tripId,memberUid,button){
  const trip=getTrip(tripId);
  if(!trip || trip.ownerUid!==currentUser?.uid || !button) return;
  if(!confirm('Remove this collaborator from the trip? They will immediately lose access.')) return;
  button.disabled=true;
  button.textContent='Removing…';
  try{
    const removed=await Store.removeTripMember(trip.ownerUid,trip.id,memberUid);
    if(!removed) throw new Error('This collaborator is no longer a member.');
    toast('Collaborator removed');
    loadTripCollaborators(tripId);
  } catch(err){
    console.error('Collaborator removal error:',err);
    button.disabled=false;
    button.textContent='Remove';
    toast(err.message||'Could not remove collaborator');
  }
}
function searchCollaborators(tripId,term){
  clearTimeout(collaboratorSearchTimer);
  const run=++collaboratorSearchRun;
  const box=document.getElementById('collaboratorResults');
  if(!box) return;
  const prefix=(term||'').trim();
  if(prefix.length<2){
    box.className='small muted';
    box.textContent='Type at least 2 characters to search opted-in users.';
    return;
  }
  box.className='small muted';
  box.textContent='Searching…';
  collaboratorSearchTimer=setTimeout(async()=>{
    try{
      const users=await Store.searchUsers(prefix);
      if(run!==collaboratorSearchRun) return;
      if(!users.length){ box.textContent='No available users found.'; return; }
      box.className='';
      box.innerHTML=users.map(user=>`<div class="row between" style="gap:10px;padding:9px 0;border-bottom:1px solid var(--line)">
        <div class="row" style="gap:9px;min-width:0">
          <img class="collaborator-avatar" src="${esc(user.photoURL||initialAvatar(user.displayName||'Traveler'))}" alt="">
          <span style="font-weight:650">${esc(user.displayName)}</span></div>
        <button class="btn sm ghost" data-invite-uid="${esc(user.uid)}">Invite</button></div>`).join('');
      box.querySelectorAll('[data-invite-uid]').forEach(button=>button.addEventListener('click',()=>
        sendCollaborationInvite(tripId,button.dataset.inviteUid,button)));
    } catch(err){
      if(run!==collaboratorSearchRun) return;
      console.error('Collaborator search error:',err);
      box.textContent='Could not search users. Check Firebase access.';
    }
  },250);
}
async function sendCollaborationInvite(tripId,inviteeUid,button){
  const trip=getTrip(tripId);
  if(!trip || trip.ownerUid!==currentUser?.uid || !button) return;
  button.disabled=true;
  button.textContent='Sending…';
  try{
    const result=await Store.sendCollaborationInvite(trip,inviteeUid,currentUser.displayName);
    button.textContent=result.alreadyMember?'Already added':result.alreadyInvited?'Pending':'Sent';
    if(result.alreadyMember) toast('This user already has trip access');
    else if(result.alreadyInvited) toast('Invite already pending');
    else toast('Collaboration invite sent');
  } catch(err){
    console.error('Collaboration invite error:',err);
    button.disabled=false;
    button.textContent='Invite';
    toast(err.message||'Could not send invite');
  }
}
async function acceptCollaborationInvite(inviteId){
  try{
    const result=await Store.acceptCollaborationInvite(inviteId);
    if(result.alreadyMember){
      toast('You already have access to this trip');
      return;
    }
    pendingJoinedTripId=result.tripId;
    activeTripId=result.tripId;
    Store.saveSettings({activeTripId}).catch(handleErr);
    if(getTrip(result.tripId)){
      pendingJoinedTripId=null;
      setTab('expenses');
    }
    toast(`Joined ${result.tripName}`);
  } catch(err){
    console.error('Collaboration invite acceptance error:',err);
    toast(err.message||'Could not accept collaboration invite');
  }
}
async function createTripInvite(id){
  const trip=getTrip(id);
  if(!trip || trip.ownerUid!==currentUser?.uid) return;
  try{
    trip.inviteId=await Store.createTripInvite(trip);
    openInviteSheet(id);
    toast('Invite link created');
  } catch(err){
    handleErr(err);
  }
}
async function shareInviteLink(id){
  const trip=getTrip(id);
  if(!trip || trip.ownerUid!==currentUser?.uid) return;
  if(!trip.inviteId){
    await createTripInvite(id);
    return;
  }
  const link=inviteUrl(trip.inviteId);
  try{
    if(navigator.share){
      await navigator.share({title:`Join ${trip.name} on TripSpend`,text:'Join this shared trip on TripSpend.',url:link});
    } else {
      await copyInviteLink(link);
      toast('Invite link copied');
    }
  } catch(err){
    if(err && err.name==='AbortError') return;
    console.error('Invite link share error:',err);
    try{
      await copyInviteLink(link);
      toast('Invite link copied');
    } catch(copyErr){
      const input=document.getElementById('inviteUrl');
      if(input) { input.focus(); input.select(); input.setSelectionRange(0,input.value.length); }
      toast('Link selected. Copy it to share.');
    }
  }
}
async function copyInviteLink(link){
  if(navigator.clipboard && window.isSecureContext){
    try{
      await navigator.clipboard.writeText(link);
      return;
    } catch(err){
      console.warn('Clipboard API unavailable; trying legacy copy.',err);
    }
  }
  const input=document.getElementById('inviteUrl');
  if(!input) throw new Error('Invite link field is unavailable');
  input.focus();
  input.select();
  input.setSelectionRange(0,input.value.length);
  if(!document.execCommand('copy')) throw new Error('Browser copy command failed');
}
async function revokeTripInvite(id){
  const trip=getTrip(id);
  if(!trip || trip.ownerUid!==currentUser?.uid || !trip.inviteId) return;
  try{
    await Store.revokeTripInvite(trip);
    trip.inviteId=null;
    openInviteSheet(id);
    toast('Invite link revoked');
  } catch(err){
    handleErr(err);
  }
}

/* --- Trip sheet --- */
let draftTravelers = [];
function renderTravelers(){
  const box=document.getElementById('f_travelers'); if(!box) return;
  box.innerHTML = draftTravelers.map((tv,i)=>`<div class="row" style="gap:8px;margin-bottom:8px">
      <input value="${esc(tv.name)}" placeholder="Traveler ${i+1}" oninput="draftTravelers[${i}].name=this.value" maxlength="24">
      <button class="hbtn" style="background:var(--surface2);color:var(--red);flex:0 0 auto" onclick="removeTraveler(${i})"><i class="fa-solid fa-xmark"></i></button>
    </div>`).join('') +
    `<button class="btn ghost sm" onclick="addTraveler()">${icon('fa-solid fa-user-plus')} Add traveler</button>`;
}
function addTraveler(){
  if(draftTravelers.length>=10){ toast('A trip can have up to 10 travelers'); return; }
  draftTravelers.push({id:uid(),name:''}); renderTravelers();
}
function removeTraveler(i){ draftTravelers.splice(i,1); renderTravelers(); }
function openTripSheet(id){
  const t = id? getTrip(id):null;
  draftTravelers = t&&t.travelers? t.travelers.map(x=>({...x})) : [];
  openSheet(`<h2>${t?'Edit trip':'New trip'}</h2>
    <div class="field"><label>Trip name</label>
      <input id="f_name" placeholder="e.g. Bali Getaway" value="${t?esc(t.name):''}" maxlength="40"></div>
    <div class="grid2">
      <div class="field"><label>Currency</label><div class="pill">${esc(currencyLabel())}</div></div>
      <div class="field"><label>Total budget (optional)</label>
        <input id="f_budget" type="number" inputmode="decimal" min="0" max="1000000000000" step="any" placeholder="0" value="${t&&t.budget?t.budget:''}"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>Start date</label>
        <input id="f_start" type="date" value="${t&&t.startDate?t.startDate:''}"></div>
      <div class="field"><label>End date</label>
        <input id="f_end" type="date" value="${t&&t.endDate?t.endDate:''}"></div>
    </div>
    <div class="field"><label>Travelers (for splitting)</label><div id="f_travelers"></div></div>
    <button class="btn" onclick="saveTrip('${id||''}')">${t?'Save changes':'Create trip'}</button>
    ${t?`<button class="btn ghost" style="margin-top:10px" onclick="closeSheet()">Cancel</button>`:''}`);
  renderTravelers();
  setTimeout(()=>{ const f=document.getElementById('f_name'); if(f) f.focus(); },260);
}
async function saveTrip(id){
  const name=document.getElementById('f_name').value.trim();
  const budgetInput=document.getElementById('f_budget').value;
  const budget=budgetInput===''?0:Number(budgetInput);
  const startDate=document.getElementById('f_start').value||'';
  const endDate=document.getElementById('f_end').value||'';
  if(!name){ toast('Enter a trip name'); return; }
  if(!Number.isFinite(budget)||budget<0||budget>1000000000000){ toast('Enter a budget between 0 and 1,000,000,000,000'); return; }
  if(startDate && endDate && endDate<startDate){ toast('End date is before start'); return; }
  const travelers=draftTravelers.filter(tv=>tv.name.trim()).map(tv=>({id:tv.id,name:tv.name.trim()}));
  let trip;
  if(id){
    const existing=getTrip(id); if(!existing){ closeSheet(); return; }
    trip={...existing,name,currency:currencyCode,budget,startDate,endDate,travelers};
  } else {
    trip={id:uid(),ownerUid:currentUser.uid,name,currency:currencyCode,budget,startDate,endDate,travelers,createdAt:Date.now()};
  }
  try{
    await Store.saveTrip(trip);
    if(id) trips=trips.map(existing=>existing.id===id&&existing.ownerUid===trip.ownerUid?trip:existing);
    else{
      trips.push(trip);
      activeTripId=trip.id;
      Store.saveSettings({activeTripId:trip.id}).catch(handleErr);
    }
    closeSheet();
    toast(id?'Trip updated':'Trip created');
    render();
  } catch(err){
    handleErr(err);
  }
}
/* --- Expense sheet --- */
let draftPhoto=null, draftPart=[];
function renderPhoto(){
  const box=document.getElementById('f_photo'); if(!box) return;
  box.innerHTML = draftPhoto
    ? `<div class="photo-prev"><img src="${draftPhoto}"><button class="rm" onclick="clearPhoto()"><i class="fa-solid fa-xmark"></i></button></div>`
    : `<label class="photo-box" for="f_file"><i class="fa-solid fa-camera"></i> Add receipt photo</label>
       <input id="f_file" type="file" accept="image/*" capture="environment" style="display:none" onchange="onPhoto(this)">`;
}
function onPhoto(input){
  const file=input.files[0]; if(!file) return;
  const r=new FileReader();
  r.onload=()=>{ const img=new Image(); img.onload=()=>{
      const max=640; let w=img.width,h=img.height;
      if(w>h && w>max){ h=Math.round(h*max/w); w=max; } else if(h>max){ w=Math.round(w*max/h); h=max; }
      const cv=document.createElement('canvas'); cv.width=w; cv.height=h;
      cv.getContext('2d').drawImage(img,0,0,w,h);
      draftPhoto=cv.toDataURL('image/jpeg',0.62); renderPhoto();
    }; img.src=r.result; };
  r.readAsDataURL(file);
}
function clearPhoto(){ draftPhoto=null; renderPhoto(); }
function openExpSheet(id){
  if(!activeTripId){ toast('Open a trip first'); setTab('trips'); return; }
  const t=getTrip(activeTripId); if(!t) return;
  const e = id? expenses.find(x=>x.id===id):null;
  draftPhoto = e&&e.photo? e.photo : null;
  const trav = t.travelers||[];
  const travelerIds=new Set(trav.map(v=>v.id));
  draftPart = e&&e.participants? [...new Set(e.participants.filter(id=>travelerIds.has(id)))]:trav.map(v=>v.id);
  const curCat = e?e.category:CATS[0].id;
  const chips = allCats().map(c=>`<div class="chip ${c.id===curCat?'sel':''}" data-cat="${c.id}"
      onclick="pickCat(this)">${icon(c.ic)} ${esc(c.name)}</div>`).join('');
  const curMethod = e&&METHODS[e.method]?e.method:Object.keys(METHODS)[0];
  const mchips = Object.entries(METHODS).map(([k,m])=>`<div class="chip ${k===curMethod?'sel':''}" data-m="${k}"
      onclick="pickMethod(this)">${icon(m.ic)} ${esc(m.name)}</div>`).join('');
  const curAmt = e? e.amount : '';
  let splitHtml='';
  if(trav.length){
    const paid = e&&trav.some(v=>v.id===e.paidBy)? e.paidBy : trav[0].id;
    const pchips = trav.map(v=>`<div class="chip ${v.id===paid?'sel':''}" data-p="${v.id}" onclick="pickPaidBy(this)">${esc(v.name)}</div>`).join('');
    const partChips = trav.map(v=>`<div class="chip ${draftPart.includes(v.id)?'sel':''}" data-pt="${v.id}" onclick="togglePart(this)">${esc(v.name)}</div>`).join('');
    splitHtml = `<div class="field"><label>Paid by</label><div class="chips" id="f_paid">${pchips}</div>
        <input type="hidden" id="f_paidv" value="${paid}"></div>
      <div class="field"><label>Split between</label><div class="chips" id="f_part">${partChips}</div></div>`;
  }
  openSheet(`<h2>${e?'Edit expense':'Add expense'}</h2>
    <div class="grid2">
      <div class="field"><label>Amount</label>
        <input id="f_amt" type="number" inputmode="decimal" min="0" max="1000000000000" step="any" placeholder="0.00" value="${curAmt}"></div>
      <div class="field"><label>Currency</label><div class="pill">${esc(currencyLabel())}</div></div>
    </div>
    <div class="field"><label>Category</label><div class="chips" id="f_cats">${chips}</div>
      <input type="hidden" id="f_cat" value="${curCat}"></div>
    <div class="field"><label>Payment method</label><div class="chips" id="f_methods">${mchips}</div>
      <input type="hidden" id="f_method" value="${curMethod}"></div>
    <div class="field"><label>Note (optional)</label>
      <input id="f_note" placeholder="e.g. Lunch at beach cafe" value="${e?esc(e.note):''}" maxlength="60"></div>
    <div class="field"><label>Date</label>
      <input id="f_date" type="date" value="${e?e.date:todayISO()}" max="${todayISO()}"></div>
    ${splitHtml}
    <div class="field"><label>Receipt</label><div id="f_photo"></div></div>
    <button class="btn" onclick="saveExp('${id||''}')">${e?'Save changes':'Add expense'}</button>
    ${e?`<button class="btn danger" style="margin-top:10px" onclick="deleteExp('${id}')">Delete expense</button>`:''}`);
  renderPhoto();
  setTimeout(()=>{ const f=document.getElementById('f_amt'); if(f) f.focus(); },260);
}
function pickCat(el){ document.querySelectorAll('#f_cats .chip').forEach(c=>c.classList.remove('sel'));
  el.classList.add('sel'); document.getElementById('f_cat').value=el.dataset.cat; }
function pickMethod(el){ document.querySelectorAll('#f_methods .chip').forEach(c=>c.classList.remove('sel'));
  el.classList.add('sel'); document.getElementById('f_method').value=el.dataset.m; }
function pickPaidBy(el){ document.querySelectorAll('#f_paid .chip').forEach(c=>c.classList.remove('sel'));
  el.classList.add('sel'); document.getElementById('f_paidv').value=el.dataset.p; }
function togglePart(el){ el.classList.toggle('sel');
  const id=el.dataset.pt; if(draftPart.includes(id)) draftPart=draftPart.filter(x=>x!==id); else draftPart.push(id); }
async function saveExp(id){
  const t=getTrip(activeTripId); if(!t) return;
  const raw=parseFloat(document.getElementById('f_amt').value);
  const cat=document.getElementById('f_cat').value;
  const method=document.getElementById('f_method').value;
  const note=document.getElementById('f_note').value.trim();
  const date=document.getElementById('f_date').value||todayISO();
  if(!Number.isFinite(raw)||raw<=0||raw>1000000000000){ toast('Enter an amount greater than 0 and at most 1,000,000,000,000'); return; }
  if(date>todayISO()){ toast('Expense date cannot be in the future'); return; }
  const rec={ownerUid:t.ownerUid,amount:raw, category:cat, method, note, date, photo:draftPhoto||null};
  if((t.travelers||[]).length){
    if(!draftPart.length){ toast('Select at least one traveler for the split'); return; }
    rec.paidBy=document.getElementById('f_paidv').value;
    rec.participants=draftPart.slice();
  } else { rec.paidBy=null; rec.participants=null; }
  let expense;
  if(id){
    const existing=expenses.find(x=>x.id===id); if(!existing){ closeSheet(); return; }
    expense={...existing,...rec};
  } else {
    expense={id:uid(),tripId:activeTripId,createdAt:Date.now(),...rec};
  }
  try{
    await Store.saveExpense(expense);
    if(id) expenses=expenses.map(existing=>existing.id===id?expense:existing);
    else expenses.push(expense);
    closeSheet();
    toast(id?'Expense updated':'Expense added');
    render();
  } catch(err){
    handleErr(err);
  }
}
async function deleteExp(id){
  const expense=expenses.find(item=>item.id===id);
  if(!expense) return;
  if(!confirm('Delete this expense? This cannot be undone.')) return;
  try{
    await Store.deleteExpense(id,expense.ownerUid||currentUser.uid);
    expenses=expenses.filter(item=>item.id!==id);
    closeSheet();
    toast('Expense deleted');
    render();
  } catch(err){
    handleErr(err);
  }
}

/* --- Budget sheet --- */
function openBudgetSheet(){
  const t=getTrip(activeTripId); if(!t) return;
  openSheet(`<h2>Trip budget</h2>
    <div class="field"><label>Total budget (${sym(t.id)})</label>
      <input id="f_budget2" type="number" inputmode="decimal" min="0" max="1000000000000" step="any" placeholder="0" value="${t.budget||''}"></div>
    <p class="small muted" style="margin-bottom:16px">Set to 0 or leave empty to remove the budget.</p>
    <button class="btn" onclick="saveBudget()">Save budget</button>`);
  setTimeout(()=>{ const f=document.getElementById('f_budget2'); if(f) f.focus(); },260);
}
async function saveBudget(){
  const t=getTrip(activeTripId); if(!t) return;
  const value=document.getElementById('f_budget2').value;
  const budget=value===''?0:Number(value);
  if(!Number.isFinite(budget)||budget<0||budget>1000000000000){ toast('Enter a budget between 0 and 1,000,000,000,000'); return; }
  const updated={...t,budget};
  try{
    await Store.saveTrip(updated);
    trips=trips.map(existing=>existing.id===t.id&&existing.ownerUid===t.ownerUid?updated:existing);
    closeSheet(); toast('Budget saved'); render();
  } catch(err){
    handleErr(err);
  }
}

/* --- Delete trip --- */
function confirmDeleteTrip(id){
  const t=getTrip(id); if(!t) return;
  openSheet(`<h2>Delete trip?</h2>
    <p class="small muted" style="margin-bottom:18px">“${esc(t.name)}” and all its expenses will be permanently removed. This can't be undone.</p>
    <button class="btn danger" onclick="deleteTrip('${id}')">Delete trip</button>
    <button class="btn ghost" style="margin-top:10px" onclick="closeSheet()">Cancel</button>`);
}
async function deleteTrip(id){
  const trip=getTrip(id);
  if(!trip) return;
  try{
    await Store.deleteTripCascade(id,trip.ownerUid,trip.inviteId);
  } catch(err){
    handleErr(err);
    return;
  }
  trips=trips.filter(item=>item.id!==id||item.ownerUid!==trip.ownerUid);
  expenses=expenses.filter(item=>item.tripId!==id||item.ownerUid!==trip.ownerUid);
  if(activeTripId===id){ activeTripId = trips.length? trips[0].id:null;
    Store.saveSettings({activeTripId}).catch(()=>{}); }
  closeSheet(); toast('Trip deleted'); setTab('trips');
}
/* ============ Settings, theme, categories, PWA ============ */
function applyTheme(){
  document.body.classList.toggle('dark', settings.theme==='dark');
  const tb=document.getElementById('themeBtn');
  if(tb) tb.innerHTML = settings.theme==='dark'?'<i class="fa-solid fa-sun"></i>':'<i class="fa-solid fa-moon"></i>';
  const mc=document.querySelector('meta[name="theme-color"]');
  if(mc) mc.setAttribute('content', settings.theme==='dark'?'#0b0e1a':'#5b93f7');
}
function toggleTheme(){
  settings.theme = settings.theme==='dark'?'light':'dark';
  applyTheme();
  Store.saveSettings({theme:settings.theme}).catch(()=>{});
  if(overlay.classList.contains('open')) openSettings();
}
let deferredPrompt=null;
window.addEventListener('beforeinstallprompt', e=>{ e.preventDefault(); deferredPrompt=e; });
function installBtnHtml(){
  return deferredPrompt ? `<div class="field"><label>App</label>
    <button class="btn ghost" onclick="installApp()">${icon('fa-solid fa-download')} Install to home screen</button></div>` : '';
}
function installApp(){ if(!deferredPrompt) return; deferredPrompt.prompt();
  deferredPrompt.userChoice.finally(()=>{ deferredPrompt=null; closeSheet(); }); }

async function toggleDiscoverable(){
  const next=!discoverable;
  try{
    await Store.setDiscoverable(next,currentUser?.displayName,currentUser?.photoURL);
    discoverable=next;
    openSettings();
    toast(next?'Your profile is searchable':'Your profile was removed from search');
  } catch(err){
    console.error('Profile discovery update error:',err);
    toast(err.message||'Could not update profile search settings');
  }
}

function openSettings(){
  const u=currentUser||{};
  const catList = customCats.length? customCats.map(c=>`<div class="row between" style="margin-bottom:8px">
      <span><i class="${c.ic}" style="color:${c.c};width:20px"></i> ${esc(c.name)}</span>
      <span><button class="link" onclick="openCatSheet('${c.id}')">Edit</button>
        <button class="link" style="color:var(--red);margin-left:12px" onclick="deleteCat('${c.id}')">Delete</button></span></div>`).join('')
    : `<div class="small muted">No custom categories yet.</div>`;
  openSheet(`<h2>Settings</h2>
    <div class="acct">
      <img src="${u.photoURL||initialAvatar(u.displayName||u.email)}" alt="">
      <div style="flex:1;min-width:0"><div class="nm">${esc(u.displayName||'Signed in')}</div>
        <div class="em">${esc(u.email||'')}</div></div>
      <button class="btn ghost sm" onclick="doSignOut()">${icon('fa-solid fa-right-from-bracket')} Sign out</button>
    </div>
    <div class="field"><label>Appearance</label>
      <button class="btn ghost" onclick="toggleTheme()">${settings.theme==='dark'?icon('fa-solid fa-sun')+' Switch to light':icon('fa-solid fa-moon')+' Switch to dark'}</button></div>
    <div class="field"><label>Collaboration search</label>
      <button class="btn ghost" onclick="toggleDiscoverable()">${discoverable?icon('fa-solid fa-eye-slash')+' Remove my name from search':icon('fa-solid fa-magnifying-glass')+' Make my name searchable'}</button>
      <div class="small muted" style="margin-top:8px">Only your Google display name is searchable. Your email and trip data stay private.</div></div>
    ${installBtnHtml()}
    <div class="field"><label>Currency</label><div class="pill">${esc(currencyLabel())}</div></div>
    <div class="field"><label>Custom categories</label>${catList}
      <button class="btn ghost sm" style="margin-top:10px" onclick="openCatSheet()">${icon('fa-solid fa-plus')} Add category</button></div>
    <button class="btn" onclick="closeSheet()">Done</button>`);
}
/* --- Custom category sheet --- */
let draftCatIcon, draftCatColor;
function catPickers(){
  const ib=document.getElementById('f_caticons'), cb=document.getElementById('f_catcolors');
  if(ib) ib.innerHTML=CAT_ICONS.map(ic=>`<div class="chip ${ic===draftCatIcon?'sel':''}" onclick="draftCatIcon='${ic}';catPickers()"><i class="${ic}"></i></div>`).join('');
  if(cb) cb.innerHTML=CAT_COLORS.map(c=>`<div onclick="draftCatColor='${c}';catPickers()" style="width:32px;height:32px;border-radius:50%;cursor:pointer;background:${c};border:3px solid ${c===draftCatColor?'var(--text)':'transparent'}"></div>`).join('');
}
function openCatSheet(id){
  const c=id?customCats.find(x=>x.id===id):null;
  draftCatIcon=c?c.ic:CAT_ICONS[0]; draftCatColor=c?c.c:CAT_COLORS[0];
  openSheet(`<h2>${c?'Edit category':'New category'}</h2>
    <div class="field"><label>Name</label>
      <input id="f_catname" placeholder="e.g. Souvenirs" value="${c?esc(c.name):''}" maxlength="24"></div>
    <div class="field"><label>Icon</label><div class="chips" id="f_caticons"></div></div>
    <div class="field"><label>Colour</label><div class="row" style="flex-wrap:wrap;gap:10px" id="f_catcolors"></div></div>
    <button class="btn" onclick="saveCat('${id||''}')">${c?'Save':'Add category'}</button>
    <button class="btn ghost" style="margin-top:10px" onclick="openSettings()">Back</button>`);
  catPickers();
  setTimeout(()=>{ const f=document.getElementById('f_catname'); if(f) f.focus(); },260);
}
function saveCat(id){
  const name=document.getElementById('f_catname').value.trim();
  if(!name){ toast('Enter a name'); return; }
  if(!id && customCats.length>=10){ toast('You can add up to 10 custom categories'); return; }
  if(id){ const c=customCats.find(x=>x.id===id); if(c) Object.assign(c,{name,ic:draftCatIcon,c:draftCatColor}); }
  else customCats.push({id:'c_'+uid(),name,ic:draftCatIcon,c:draftCatColor,custom:true});
  Store.saveCats(customCats).catch(handleErr);
  toast('Category saved'); openSettings();
}
function deleteCat(id){
  customCats=customCats.filter(c=>c.id!==id);
  Store.saveCats(customCats).catch(handleErr);
  toast('Category removed'); openSettings();
}

/* ============ wiring & init ============ */
document.getElementById('googleBtn').onclick=signIn;
document.getElementById('backBtn').onclick=()=>setTab('trips');
document.getElementById('themeBtn').onclick=toggleTheme;
document.getElementById('avatarBtn').onclick=openSettings;
document.querySelectorAll('.nav button[data-tab]').forEach(b=>
  b.onclick=()=>{
    if(b.dataset.tab!=='trips' && !activeTripId){ toast('Open a trip first'); setTab('trips'); return; }
    setTab(b.dataset.tab);
  });
document.getElementById('addBtn').onclick=()=>{
  if(currentTab==='trips' || !activeTripId) openTripSheet();
  else openExpSheet();
};
applyTheme();
if('serviceWorker' in navigator){
  window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
}
