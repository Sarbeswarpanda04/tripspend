/* ============================================================
   TripSpend — app logic (classic script; shares globals with
   firebase-config.js + store.js). Data is stored in Firestore
   per signed-in Google account; no localStorage is used.
   ============================================================ */

/* ---- static data ---- */
const CATS = [
  {id:'food',      name:'Food & Drink',  ic:'fa-solid fa-utensils',         c:'#f59e0b'},
  {id:'transport', name:'Transport',     ic:'fa-solid fa-taxi',             c:'#3b82f6'},
  {id:'stay',      name:'Accommodation', ic:'fa-solid fa-bed',              c:'#8b5cf6'},
  {id:'activity',  name:'Activities',    ic:'fa-solid fa-umbrella-beach',   c:'#ec4899'},
  {id:'shopping',  name:'Shopping',      ic:'fa-solid fa-bag-shopping',     c:'#14b8a6'},
  {id:'grocery',   name:'Groceries',     ic:'fa-solid fa-cart-shopping',    c:'#84cc16'},
  {id:'health',    name:'Health',        ic:'fa-solid fa-briefcase-medical',c:'#ef4444'},
  {id:'fees',      name:'Fees & Tips',   ic:'fa-solid fa-receipt',          c:'#06b6d4'},
  {id:'misc',      name:'Miscellaneous', ic:'fa-solid fa-box',              c:'#94a3b8'},
];
const CUR = {INR:'₹'};
const DEF_RATES = {USD:1,EUR:1.08,GBP:1.27,INR:0.012,JPY:0.0067,AUD:0.66,CAD:0.73,AED:0.27,SGD:0.74};
const METHODS = {card:{name:'Card',ic:'fa-solid fa-credit-card'},
                 cash:{name:'Cash',ic:'fa-solid fa-money-bill-wave'},
                 other:{name:'Other',ic:'fa-solid fa-ellipsis'}};

/* ---- in-memory state (populated by Firestore listeners) ---- */
let trips = [], expenses = [], customCats = [];
let activeTripId = null;
let settings = {theme:'light', homeCurrency:'INR', rates:Object.assign({}, DEF_RATES)};
let currentTab = 'trips';
let currentUser = null;
let currencyMigrationStarted = false;
let storeReady = false;
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
  if(kind==='error'){ handleErr(data); return; }
  if(kind==='trips'){
    trips = data;
  } else if(kind==='expenses'){
    expenses = data;
  } else if(kind==='settings'){
    if(data){
      if(data.theme) settings.theme = data.theme;
      settings.homeCurrency = 'INR';
      settings.rates = Object.assign({}, DEF_RATES, data.rates||{});
      if('activeTripId' in data) activeTripId = data.activeTripId;
      applyTheme();
      if(data.homeCurrency !== 'INR') Store.saveSettings({homeCurrency:'INR'}).catch(handleErr);
    } else if(currentUser){
      Store.saveSettings({theme:settings.theme, homeCurrency:'INR',
        rates:settings.rates, activeTripId:activeTripId}).catch(()=>{});
    }
  } else if(kind==='cats'){
    customCats = data;
  } else if(kind==='discoverable'){
    discoverable = data;
  } else if(kind==='collaborationInvites'){
    collaborationInvites = data;
  } else if(kind==='ready'){
    storeReady=true;
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

function normalizeCurrencyData(){
  if(currencyMigrationStarted || !storeReady) return;
  currencyMigrationStarted = true;

  trips.forEach(trip=>{
    const from = trip.currency || 'INR';
    if(from === 'INR'){
      if(trip.currency !== 'INR'){
        trip.currency = 'INR';
        Store.saveTrip(trip).catch(handleErr);
      }
      return;
    }
    if(trip.budget) trip.budget = convert(trip.budget, from, 'INR');
    trip.currency = 'INR';
    Store.saveTrip(trip).catch(handleErr);
    expenses.filter(expense=>expense.tripId===trip.id).forEach(expense=>{
      expense.amount = convert(expense.amount, from, 'INR');
      delete expense.oc;
      delete expense.oa;
      Store.saveExpense(expense).catch(handleErr);
    });
  });

  expenses.filter(expense=>expense.oc || expense.oa != null).forEach(expense=>{
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
  auth.signInWithPopup(googleProvider).catch(showSignInErr);
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
    currencyMigrationStarted=false;
    storeReady=false;
    pendingJoinedTripId=null;
    setAvatar(user);
    showApp();
    Store.setUser(user.uid);
    Store.subscribe(onStoreData);
    joinPendingInvite(user);
  } else {
    currentUser=null;
    storeReady=false;
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
const catOf = id => allCats().find(c=>c.id===id) || CATS.find(c=>c.id==='misc');
function convert(amt, from, to){
  if(from===to) return amt;
  const rf=settings.rates[from]||DEF_RATES[from]||1;
  const rt=settings.rates[to]||DEF_RATES[to]||1;
  return amt * rf / rt;
}
const getTrip = id => trips.find(t=>t.id===id);
const tripExpenses = id => expenses.filter(e=>e.tripId===id)
  .sort((a,b)=> b.date.localeCompare(a.date) || (b.createdAt||0)-(a.createdAt||0));
const spent = id => tripExpenses(id).reduce((s,e)=>s+e.amount,0);
const sym = () => CUR.INR;
function fmtNum(v){
  v = Math.round((v+Number.EPSILON)*100)/100;
  return v.toLocaleString(undefined,{minimumFractionDigits:(v%1?2:0),maximumFractionDigits:2});
}
function money(n, tripId){ return sym(tripId)+fmtNum(n); }
const todayISO = ()=> new Date().toISOString().slice(0,10);
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
  const t = getTrip(activeTripId);
  const header = document.getElementById('header');
  const needsTrip = ['expenses','analysis','budget'].includes(currentTab);
  header.classList.toggle('has-back', currentTab!=='trips' && !!t);
  if(currentTab==='trips'){
    document.getElementById('hTitle').textContent = greeting();
    document.getElementById('hSub').textContent = trips.length
      ? trips.length+' trip'+(trips.length>1?'s':'')+' · ₹'+fmtNum(grandTotal())+' INR'
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
        <div class="val">₹${fmtNum(grand)}</div></div>
      <div style="text-align:right"><div class="lbl">in INR</div>
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
        ${t.ownerUid!==currentUser?.uid?'<span class="pill">Shared</span>':''}<span class="pill">₹ INR</span></div></div>
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
      const m = METHODS[e.method]||METHODS.card;
      const lead = e.photo
        ? `<img class="thumb" src="${e.photo}" alt="">`
        : `<div class="cat-ic" style="background:${c.c}22;color:${c.c}">${icon(c.ic)}</div>`;
      h += `<div class="exp" onclick="openExpSheet('${e.id}')">
        ${lead}
        <div class="info"><div class="t">${esc(e.note)||c.name}</div>
          <div class="d">${c.name} <span class="tag">${icon(m.ic)} ${m.name}</span></div></div>
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
    h += `<div class="abar"><div class="top"><span>${icon(c.ic)} ${c.name}</span>
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

  const mTot={}; list.forEach(e=>{ const k=e.method||'card'; mTot[k]=(mTot[k]||0)+e.amount; });
  h += `<div class="section-title">By payment method</div><div class="card">`;
  Object.entries(mTot).sort((a,b)=>b[1]-a[1]).forEach(([k,amt])=>{ const m=METHODS[k]||METHODS.other; const p=amt/sp*100;
    h += `<div class="abar"><div class="top"><span>${icon(m.ic)} ${m.name}</span>
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
    net[e.paidBy]+=e.amount;
    const share=e.amount/e.participants.length;
    e.participants.forEach(p=>{ if(net[p]!=null) net[p]-=share; });
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
    <div class="field"><label>Find a user</label>
      <input id="collaboratorSearch" type="search" placeholder="Type at least 2 characters" oninput="searchCollaborators('${id}',this.value)">
      <div id="collaboratorResults" class="small muted" style="margin-top:10px">Only users who opted into discovery appear here.</div></div>
    ${link?`<div class="field"><label>Invite link</label><input id="inviteUrl" readonly value="${esc(link)}"></div>
      <button class="btn" onclick="shareInviteLink('${id}')">${icon('fa-solid fa-link')} Share invite link</button>
      <button class="btn danger" style="margin-top:10px" onclick="revokeTripInvite('${id}')">Revoke invite link</button>`
      :`<button class="btn" onclick="createTripInvite('${id}')">${icon('fa-solid fa-link')} Create invite link</button>`}
    <button class="btn ghost" style="margin-top:10px" onclick="closeSheet()">Done</button>`);
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
        <span style="font-weight:650">${esc(user.displayName)}</span>
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
      <div class="field"><label>Currency</label><div class="pill">₹ INR</div></div>
      <div class="field"><label>Total budget (optional)</label>
        <input id="f_budget" type="number" inputmode="decimal" min="0" step="any" placeholder="0" value="${t&&t.budget?t.budget:''}"></div>
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
function saveTrip(id){
  const name=document.getElementById('f_name').value.trim();
  const budget=parseFloat(document.getElementById('f_budget').value)||0;
  const startDate=document.getElementById('f_start').value||'';
  const endDate=document.getElementById('f_end').value||'';
  if(!name){ toast('Enter a trip name'); return; }
  if(startDate && endDate && endDate<startDate){ toast('End date is before start'); return; }
  const travelers=draftTravelers.filter(tv=>tv.name.trim()).map(tv=>({id:tv.id,name:tv.name.trim()}));
  let t;
  if(id){
    t=getTrip(id); if(!t){ closeSheet(); return; }
    Object.assign(t,{name,currency:'INR',budget,startDate,endDate,travelers});
    toast('Trip updated');
  } else {
    t={id:uid(),ownerUid:currentUser.uid,name,currency:'INR',budget,startDate,endDate,travelers,createdAt:Date.now()};
    trips.push(t); activeTripId=t.id;
    Store.saveSettings({activeTripId:t.id}).catch(()=>{});
    toast('Trip created');
  }
  Store.saveTrip(t).catch(handleErr);
  closeSheet(); render();
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
  draftPart = e&&e.participants? e.participants.slice() : trav.map(v=>v.id);
  const curCat = e?e.category:'food';
  const chips = allCats().map(c=>`<div class="chip ${c.id===curCat?'sel':''}" data-cat="${c.id}"
      onclick="pickCat(this)">${icon(c.ic)} ${c.name}</div>`).join('');
  const curMethod = e?e.method||'card':'card';
  const mchips = Object.entries(METHODS).map(([k,m])=>`<div class="chip ${k===curMethod?'sel':''}" data-m="${k}"
      onclick="pickMethod(this)">${icon(m.ic)} ${m.name}</div>`).join('');
  const curAmt = e? e.amount : '';
  let splitHtml='';
  if(trav.length){
    const paid = e&&e.paidBy? e.paidBy : trav[0].id;
    const pchips = trav.map(v=>`<div class="chip ${v.id===paid?'sel':''}" data-p="${v.id}" onclick="pickPaidBy(this)">${esc(v.name)}</div>`).join('');
    const partChips = trav.map(v=>`<div class="chip ${draftPart.includes(v.id)?'sel':''}" data-pt="${v.id}" onclick="togglePart(this)">${esc(v.name)}</div>`).join('');
    splitHtml = `<div class="field"><label>Paid by</label><div class="chips" id="f_paid">${pchips}</div>
        <input type="hidden" id="f_paidv" value="${paid}"></div>
      <div class="field"><label>Split between</label><div class="chips" id="f_part">${partChips}</div></div>`;
  }
  openSheet(`<h2>${e?'Edit expense':'Add expense'}</h2>
    <div class="grid2">
      <div class="field"><label>Amount</label>
        <input id="f_amt" type="number" inputmode="decimal" min="0" step="any" placeholder="0.00" value="${curAmt}"></div>
      <div class="field"><label>Currency</label><div class="pill">₹ INR</div></div>
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
function saveExp(id){
  const t=getTrip(activeTripId); if(!t) return;
  const raw=parseFloat(document.getElementById('f_amt').value);
  const cat=document.getElementById('f_cat').value;
  const method=document.getElementById('f_method').value;
  const note=document.getElementById('f_note').value.trim();
  const date=document.getElementById('f_date').value||todayISO();
  if(!raw||raw<=0){ toast('Enter a valid amount'); return; }
  const rec={ownerUid:t.ownerUid,amount:raw, category:cat, method, note, date, photo:draftPhoto||null};
  if((t.travelers||[]).length){
    rec.paidBy=document.getElementById('f_paidv').value;
    rec.participants=draftPart.length?draftPart.slice():(t.travelers.map(v=>v.id));
  } else { rec.paidBy=null; rec.participants=null; }
  let e;
  if(id){
    e=expenses.find(x=>x.id===id); if(!e){ closeSheet(); return; }
    Object.assign(e,rec); toast('Expense updated');
  } else {
    e=Object.assign({id:uid(),tripId:activeTripId,createdAt:Date.now()},rec);
    expenses.push(e); toast('Expense added');
  }
  Store.saveExpense(e).catch(handleErr);
  closeSheet(); render();
}
function deleteExp(id){
  const expense=expenses.find(item=>item.id===id);
  expenses=expenses.filter(x=>x.id!==id);
  Store.deleteExpense(id,expense?.ownerUid||currentUser.uid).catch(handleErr);
  closeSheet(); toast('Expense deleted'); render();
}

/* --- Budget sheet --- */
function openBudgetSheet(){
  const t=getTrip(activeTripId); if(!t) return;
  openSheet(`<h2>Trip budget</h2>
    <div class="field"><label>Total budget (${sym(t.id)})</label>
      <input id="f_budget2" type="number" inputmode="decimal" min="0" step="any" placeholder="0" value="${t.budget||''}"></div>
    <p class="small muted" style="margin-bottom:16px">Set to 0 or leave empty to remove the budget.</p>
    <button class="btn" onclick="saveBudget()">Save budget</button>`);
  setTimeout(()=>{ const f=document.getElementById('f_budget2'); if(f) f.focus(); },260);
}
function saveBudget(){
  const t=getTrip(activeTripId); if(!t) return;
  t.budget=parseFloat(document.getElementById('f_budget2').value)||0;
  Store.saveTrip(t).catch(handleErr);
  closeSheet(); toast('Budget saved'); render();
}

/* --- Delete trip --- */
function confirmDeleteTrip(id){
  const t=getTrip(id); if(!t) return;
  openSheet(`<h2>Delete trip?</h2>
    <p class="small muted" style="margin-bottom:18px">“${esc(t.name)}” and all its expenses will be permanently removed. This can't be undone.</p>
    <button class="btn danger" onclick="deleteTrip('${id}')">Delete trip</button>
    <button class="btn ghost" style="margin-top:10px" onclick="closeSheet()">Cancel</button>`);
}
function deleteTrip(id){
  const trip=getTrip(id);
  if(!trip) return;
  const expIds=expenses.filter(e=>e.tripId===id).map(e=>e.id);
  trips=trips.filter(t=>t.id!==id);
  expenses=expenses.filter(e=>e.tripId!==id);
  Store.deleteTripCascade(id,expIds,trip.ownerUid,trip.inviteId).catch(handleErr);
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
    await Store.setDiscoverable(next,currentUser?.displayName);
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
    <div class="field"><label>Currency</label><div class="pill">₹ INR</div></div>
    <div class="field"><label>Custom categories</label>${catList}
      <button class="btn ghost sm" style="margin-top:10px" onclick="openCatSheet()">${icon('fa-solid fa-plus')} Add category</button></div>
    <button class="btn" onclick="closeSheet()">Done</button>`);
}
/* --- Custom category sheet --- */
const CAT_ICONS=['fa-solid fa-plane','fa-solid fa-gift','fa-solid fa-mug-hot','fa-solid fa-gas-pump',
  'fa-solid fa-ticket','fa-solid fa-camera','fa-solid fa-wine-glass','fa-solid fa-gamepad',
  'fa-solid fa-book','fa-solid fa-heart','fa-solid fa-star','fa-solid fa-dumbbell',
  'fa-solid fa-spa','fa-solid fa-train','fa-solid fa-ship','fa-solid fa-paw'];
const CAT_COLORS=['#ef4444','#f97316','#f59e0b','#84cc16','#10b981','#14b8a6','#06b6d4','#3b82f6','#8b5cf6','#ec4899'];
let draftCatIcon, draftCatColor;
function catPickers(){
  const ib=document.getElementById('f_caticons'), cb=document.getElementById('f_catcolors');
  if(ib) ib.innerHTML=CAT_ICONS.map(ic=>`<div class="chip ${ic===draftCatIcon?'sel':''}" onclick="draftCatIcon='${ic}';catPickers()"><i class="${ic}"></i></div>`).join('');
  if(cb) cb.innerHTML=CAT_COLORS.map(c=>`<div onclick="draftCatColor='${c}';catPickers()" style="width:32px;height:32px;border-radius:50%;cursor:pointer;background:${c};border:3px solid ${c===draftCatColor?'var(--text)':'transparent'}"></div>`).join('');
}
function openCatSheet(id){
  const c=id?customCats.find(x=>x.id===id):null;
  draftCatIcon=c?c.ic:CAT_ICONS[0]; draftCatColor=c?c.c:CAT_COLORS[7];
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
