const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const fmt = (n, compact=false) => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:compact?0:2,notation:compact&&Math.abs(n)>9999?"compact":"standard"}).format(n);
const iso = d => d.toISOString().slice(0,10);
const state = {accounts:[],transactions:[],categories:[],categoryGroups:[],views:[],activeView:null,settings:null,summary:null,netWorth:{history:[],accounts:[],latest:0,change:0,snapshot_dates:0},sankeySelection:null,cashFlowMonthSelection:null,filters:{from:"",to:"",accounts:new Set(),categories:new Set(),search:""},range:"quarter",section:"overview"};
const colors=["#e97567","#6d5dfc","#e6a04b","#28a792","#9f938c","#60a5c5","#d577aa"];
const sectionPaths={overview:"/overview",cashflow:"/cash-flow",networth:"/net-worth",transactions:"/transactions",accounts:"/accounts",insights:"/insights",settings:"/settings"};
const pathSections=Object.fromEntries(Object.entries(sectionPaths).map(([section,path])=>[path,section]));
let sankeyHoverIndex={byGroup:new Map(),byCategory:new Map(),groupControls:new Map()},sankeyHovered=[],sankeyHoverKey="";
let netWorthChartState=null;
let cashFlowBarChartState=null;
const monitoredPlaidItems=new Set();
let plaidSyncPollTimer=null,announcePlaidSync=false,plaidSyncError=null;

async function request(path, options) {
  const res=await fetch(path,{headers:{"content-type":"application/json"},...options});
  const data=await res.json();
  if(!res.ok) throw new Error(data.error||"Something went wrong");
  return data;
}

function setRange(range) {
  const now=new Date(), start=new Date(now);
  if(range==="month") start.setDate(1);
  if(range==="quarter") start.setMonth(now.getMonth()-2,1);
  if(range==="year") start.setMonth(0,1);
  state.filters.from=range==="all"?"":iso(start);
  state.filters.to=range==="all"?"":iso(now);
  state.range=range;
  $$("#datePresets button").forEach(b=>b.classList.toggle("active",b.dataset.range===range));
  $("#fromDate").value=state.filters.from; $("#toDate").value=state.filters.to;
  updateDateLabel();
}

function updateDateLabel(){
  if(!state.filters.from && !state.filters.to) return $("#dateLabel").textContent="All time";
  const pretty=v=>new Date(`${v}T12:00:00`).toLocaleDateString("en-US",{month:"short",day:"numeric",year:new Date(v).getFullYear()!==new Date().getFullYear()?"numeric":undefined});
  $("#dateLabel").textContent=state.filters.from&&state.filters.to?`${pretty(state.filters.from)} – ${pretty(state.filters.to)}`:state.filters.from?`Since ${pretty(state.filters.from)}`:`Through ${pretty(state.filters.to)}`;
}

function queryString() {
  const p=new URLSearchParams();
  if(state.filters.from)p.set("from",state.filters.from);
  if(state.filters.to)p.set("to",state.filters.to);
  if(state.filters.accounts.size)p.set("accounts",[...state.filters.accounts].join(","));
  if(state.filters.categories.size)p.set("categories",[...state.filters.categories].join(","));
  if(state.filters.search)p.set("search",state.filters.search);
  return p;
}

async function load(initial=false) {
  const [data,netWorth]=await Promise.all([
    initial?request(`/api/bootstrap?${queryString()}`):request(`/api/transactions?${queryString()}`),
    request(`/api/net-worth?${queryString()}`)
  ]);
  if(initial){state.accounts=data.accounts;state.categories=data.categories;state.categoryGroups=data.category_groups||[];state.views=data.views||[];buildFilterOptions();renderAccounts();renderSavedViews();}
  state.transactions=data.transactions;state.summary=data.summary;state.netWorth=netWorth;
  render();
}

function currentReportConfiguration(){
  return {version:1,filters:{
    range:state.range,
    from:state.filters.from,
    to:state.filters.to,
    accounts:[...state.filters.accounts].map(Number),
    categories:[...state.filters.categories],
    search:state.filters.search
  }};
}

function applyReportConfiguration(configuration,{rebuild=true}={}){
  const filters=configuration?.filters||{};
  if(["month","quarter","year","all"].includes(filters.range)) setRange(filters.range);
  else{
    state.range="custom";
    state.filters.from=filters.from||"";state.filters.to=filters.to||"";
    $$("#datePresets button").forEach(button=>button.classList.remove("active"));
    $("#fromDate").value=state.filters.from;$("#toDate").value=state.filters.to;
    updateDateLabel();
  }
  state.filters.accounts=new Set((filters.accounts||[]).map(String));
  state.filters.categories=new Set(filters.categories||[]);
  state.filters.search=String(filters.search||"");
  $("#searchInput").value=state.filters.search;
  if(rebuild)buildFilterOptions();
}

function applyDefaultReportConfiguration(){
  applyReportConfiguration({version:1,filters:{
    range:"quarter",
    accounts:[],
    categories:[],
    search:""
  }});
}

function renderSavedViews(){
  const container=$("#savedViewsNav");
  if(!state.views.length){container.innerHTML=`<p class="saved-views-empty">Save a cash-flow report to open it here.</p>`;return}
  container.innerHTML=state.views.map(view=>`<div class="saved-view-item ${state.activeView?.id===view.id?"active":""}"><button class="saved-view-link" data-open-view="${view.id}" title="${escapeHtml(view.name)}">${escapeHtml(view.name)}</button><button class="saved-view-delete" data-delete-view="${view.id}" title="Delete ${escapeHtml(view.name)}">×</button></div>`).join("");
}

function renderReportContext(){
  $("#reportContextLabel").textContent=state.activeView?"SAVED REPORT VIEW":"LIVE REPORT";
  $("#reportContextName").textContent=state.activeView?.name||"Cash flow";
  $("#reportContextDescription").textContent=state.activeView?"Settings are stored; values are recalculated from current data.":"Calculated from current data using the active report settings.";
  renderSavedViews();
}

function reportSettingsSummary(){
  const filter=currentReportConfiguration().filters;
  const range=filter.range==="custom"?$("#dateLabel").textContent:{month:"This month",quarter:"Rolling 3 months",year:"This year",all:"All time"}[filter.range]||$("#dateLabel").textContent;
  const accountNames=filter.accounts.map(id=>state.accounts.find(account=>account.id===id)).filter(Boolean).map(account=>account.name);
  const rows=[
    ["Date range",range],
    ["Accounts",accountNames.length?accountNames.join(", "):"All accounts"],
    ["Categories",filter.categories.length?`${filter.categories.length} selected`:"All categories"],
    ["Search",filter.search||"Any description"]
  ];
  $("#reportSettingsSummary").innerHTML=rows.map(([label,value])=>`<div class="report-setting-row"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
}

function parseRoute(){
  const match=location.pathname.match(/^\/views\/(\d+)\/?$/);
  if(match)return {viewId:Number(match[1])};
  return {section:pathSections[location.pathname]||(location.pathname==="/"?"overview":null)};
}

function detachSavedView(){
  if(!state.activeView)return;
  state.activeView=null;renderReportContext();
  if(state.section==="cashflow")history.pushState({},"",sectionPaths.cashflow);
}

async function openSavedView(view,{push=true}={}){
  applyReportConfiguration(view.configuration);
  state.activeView=view;
  await load();
  switchSection("cashflow",{push:false,preserveView:true});
  if(push)history.pushState({},"",`/views/${view.id}`);
}

async function navigateSection(section,options={}){
  if(state.activeView&&!options.preserveView){
    state.activeView=null;
    applyDefaultReportConfiguration();
    await load();
  }
  if(section==="settings")await loadSettings();
  switchSection(section,options);
}

async function deleteSavedView(view){
  if(!confirm(`Delete the saved view “${view.name}”?`))return;
  await request(`/api/views/${view.id}`,{method:"DELETE"});
  state.views=state.views.filter(item=>item.id!==view.id);
  if(state.activeView?.id===view.id)await navigateSection("cashflow");
  else renderSavedViews();
  toast("Report view deleted");
}

async function navigateFromLocation(){
  const route=parseRoute();
  if(route.viewId){
    let view=state.views.find(item=>item.id===route.viewId);
    try{view||=await request(`/api/views/${route.viewId}`)}catch(error){toast(error.message);history.replaceState({},"",sectionPaths.cashflow);return navigateSection("cashflow",{push:false})}
    return openSavedView(view,{push:false});
  }
  if(route.section)return navigateSection(route.section,{push:false});
  history.replaceState({},"",sectionPaths.overview);return navigateSection("overview",{push:false});
}

function render(){
  const {totals}=state.summary;
  $("#netValue").textContent=fmt(totals.net);
  $("#incomeValue").textContent=fmt(totals.income);
  $("#expenseValue").textContent=fmt(totals.expense);
  $("#transferValue").textContent=fmt(totals.transfer);
  $("#donutTotal").textContent=fmt(totals.expense,true);
  renderChart();renderCategories();renderTransactions();renderInsights();renderCashFlow();renderNetWorth();updateFilterCount();
}

function renderChart(){
  const svg=$("#flowChart"), data=state.summary.months;
  const W=700,H=220,pad={l:42,r:10,t:12,b:30};
  if(!data.length){svg.innerHTML=`<text x="50%" y="50%" text-anchor="middle" class="axis-label">No data in this range</text>`;return}
  const min=Math.min(0,...data.flatMap(d=>[d.income,d.expense])),max=Math.max(1,...data.flatMap(d=>[d.income,d.expense]));
  const x=i=>pad.l+(data.length===1?(W-pad.l-pad.r)/2:i*(W-pad.l-pad.r)/(data.length-1));
  const y=v=>pad.t+(H-pad.t-pad.b)*(max-v)/(max-min),zeroY=y(0);
  const line=key=>data.map((d,i)=>`${i?"L":"M"} ${x(i)} ${y(d[key])}`).join(" ");
  let html="";
  for(let i=0;i<4;i++){const val=min+(max-min)*(3-i)/3, yy=y(val);html+=`<line x1="${pad.l}" y1="${yy}" x2="${W-pad.r}" y2="${yy}" class="grid-line"/><text x="0" y="${yy+3}" class="axis-label">${fmt(val,true)}</text>`}
  data.forEach((d,i)=>html+=`<text x="${x(i)}" y="${H-5}" text-anchor="middle" class="axis-label">${new Date(`${d.month}-02`).toLocaleDateString("en-US",{month:"short"})}</text>`);
  html+=`<defs><linearGradient id="incomeFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#28a792"/><stop offset="1" stop-color="#28a792" stop-opacity="0"/></linearGradient></defs>`;
  html+=`<path d="${line("income")} L ${x(data.length-1)} ${zeroY} L ${x(0)} ${zeroY} Z" fill="url(#incomeFill)" class="chart-area"/>`;
  html+=`<path d="${line("income")}" stroke="#28a792" class="chart-line"/><path d="${line("expense")}" stroke="#e97567" class="chart-line"/>`;
  data.forEach((d,i)=>html+=`<circle cx="${x(i)}" cy="${y(d.income)}" r="3" fill="#fff" stroke="#28a792" stroke-width="2"/><circle cx="${x(i)}" cy="${y(d.expense)}" r="3" fill="#fff" stroke="#e97567" stroke-width="2"/>`);
  svg.setAttribute("viewBox",`0 0 ${W} ${H}`);svg.innerHTML=html;
}

function renderCategories(){
  const cats=state.summary.categories.slice(0,5),pieCategories=cats.filter(category=>category.value>0),total=pieCategories.reduce((sum,category)=>sum+category.value,0)||1;
  let acc=0,stops=[];
  pieCategories.forEach((c,i)=>{const from=acc,to=acc+c.value/total*100;stops.push(`${colors[i]} ${from}% ${to}%`);acc=to});
  if(acc<100)stops.push(`#e9e6df ${acc}% 100%`);
  $("#donut").style.background=`conic-gradient(${stops.join(",")})`;
  $("#categoryList").innerHTML=cats.map((c,i)=>`<div class="category-row"><i style="background:${colors[i]}"></i><span>${escapeHtml(c.name)}</span><strong>${fmt(c.value,true)}</strong></div>`).join("")||`<small class="muted">No expenses to show</small>`;
}

function renderTransactions(){
  $("#resultCount").textContent=`${state.transactions.length} transaction${state.transactions.length===1?"":"s"} · transfers excluded from spending`;
  const rows=state.section==="transactions"?state.transactions:state.transactions.slice(0,7);
  $("#transactionRows").innerHTML=rows.map(tx=>{
    const initial=tx.merchant.replace(/[^a-z0-9 ]/gi,"").split(" ").map(x=>x[0]).join("").slice(0,2).toUpperCase();
    const amount=Number(tx.amount)||0,formatted=amount>0?`+${fmt(amount)}`:fmt(amount);
    return `<tr><td><input type="checkbox" aria-label="Select ${escapeHtml(tx.merchant)}"></td><td>${new Date(`${tx.date}T12:00:00`).toLocaleDateString("en-US",{month:"short",day:"numeric"})}</td><td><div class="merchant"><span class="merchant-icon">${initial}</span><div><strong>${escapeHtml(tx.merchant)}</strong><small>${tx.pending?"Pending":"Posted"}</small></div></div></td><td><div class="category-hierarchy"><small>${escapeHtml(tx.category_group||groupForCategory(tx.category))}</small><span class="category-chip">${escapeHtml(tx.category)}</span></div></td><td>${escapeHtml(tx.account_name)}</td><td class="right amount ${amount>0?"positive":""}">${formatted}</td><td><button class="row-menu" data-delete="${tx.id}" title="Delete">×</button></td></tr>`
  }).join("");
  $("#emptyState").classList.toggle("show",!rows.length);
  $(".table-scroll").style.display=rows.length?"block":"none";
}

function renderAccounts(){
  $("#accountsGrid").innerHTML=state.accounts.map(a=>{
    const syncing=a.plaid_status==="syncing";
    const syncLabel=syncing?`<span class="sync-status" role="status"><i></i> Syncing…</span>`:`<button class="sync-button ${a.plaid_status==="sync_error"?"sync-error":""}" data-sync="${a.plaid_item_id}">${a.plaid_status==="sync_error"?"⚠ Retry sync":"↻ Sync from bank"}</button>`;
    return `<article class="account-card ${syncing?"account-syncing":""}"><div class="account-logo" style="background:${a.color}">${a.institution.slice(0,2).toUpperCase()}</div><div><strong>${escapeHtml(a.institution)}</strong><small>${escapeHtml(a.name)} · ${a.type}</small></div><div class="account-balance">${fmt(a.balance)}<div class="account-actions">${a.plaid_item_id?syncLabel:`<span class="sync">● Local account</span>`}<button class="remove-account-button" data-remove-account="${a.id}" data-account-name="${escapeHtml(`${a.institution} · ${a.name}`)}" ${syncing?"disabled":""}>Remove</button></div></div></article>`;
  }).join("");
  const anySyncing=state.accounts.some(account=>account.plaid_status==="syncing");
  $("#syncAllBtn").disabled=anySyncing;
  $("#syncAllBtn").textContent=anySyncing?"Syncing…":"↻ Sync all";
  const options=state.accounts.map(a=>`<option value="${a.id}">${escapeHtml(a.institution)} · ${escapeHtml(a.name)}</option>`).join("");
  $("#accountSelect").innerHTML=options;$("#importAccount").innerHTML=options;
}

async function loadSettings(){
  state.settings=await request("/api/settings");
  renderSettings();
}

function renderSettings(){
  if(!state.settings)return;
  const {plaid,database}=state.settings;
  $("#plaidEnvironment").value=plaid.environment;
  $("#plaidClientId").value=plaid.client_id;
  $("#plaidSecret").value="";
  $("#plaidRedirectUri").value=plaid.redirect_uri;
  $("#plaidSecretHint").textContent=plaid.secret_configured?"A secret is saved. Leave this blank to keep it.":"No secret saved.";
  $("#clearPlaidSecretRow").hidden=!plaid.secret_configured;
  $("#clearPlaidSecret").checked=false;
  const status=$("#plaidSettingsStatus");
  status.textContent=plaid.configured?`Configured · ${plaid.environment}`:"Not configured";
  status.classList.toggle("configured",plaid.configured);
  $("#plaidRedirectHint").textContent=plaid.redirect.message||"Usually left blank for local Sandbox use.";
  $("#plaidRedirectHint").classList.toggle("settings-error",!plaid.redirect.valid);
  $("#settingsAccountCount").textContent=database.accounts;
  $("#settingsTransactionCount").textContent=database.transactions;
}

function renderInsights(){
  const categories=state.summary.categories,max=Math.max(1,...categories.map(category=>Math.abs(category.value))),total=Math.abs(state.summary.totals.expense)||1;
  $("#insightsGrid").innerHTML=categories.map((c,i)=>`<article class="insight-card"><small>${escapeHtml(c.group||groupForCategory(c.name))} › ${escapeHtml(c.name)}</small><div><strong>${fmt(c.value)}</strong></div><div class="bar"><i style="width:${Math.abs(c.value)/max*100}%;background:${c.value<0?"#28a792":colors[i%colors.length]}"></i></div><small>${(c.value/total*100).toFixed(1)}% of net expenses${c.value<0?" · net credit":""}</small></article>`).join("")||`<article class="insight-card"><strong>No expense data</strong><small>Adjust your filters to see insights.</small></article>`;
}

function renderNetWorth(){
  const data=state.netWorth||{history:[],accounts:[],latest:0,change:0};
  const startValue=data.history[0]?.value||0,percent=startValue?data.change/Math.abs(startValue)*100:0;
  $("#netWorthLatest").textContent=fmt(data.latest||0);
  $("#netWorthChange").textContent=`${data.change>=0?"+":""}${fmt(data.change||0)}`;
  $("#netWorthChange").classList.toggle("negative",data.change<0);
  $("#netWorthChangePercent").textContent=`${data.change>=0?"↑":"↓"} ${Math.abs(percent).toFixed(1)}% over the selected range`;
  $("#netWorthAccountCount").textContent=data.accounts.length;
  $("#netWorthRangeLabel").textContent=data.history.length?`${data.history.length} daily closing balances · ${data.snapshot_dates||0} synced snapshot date${data.snapshot_dates===1?"":"s"}`:"No balance history in this range";
  const reconstructionWarnings=data.reconstruction?.warnings||[];
  $("#netWorthNote").textContent=reconstructionWarnings.length
    ? `Some securities used fallback pricing: ${reconstructionWarnings.join(" · ")}`
    : "Investment history is reconstructed from positions, transactions, and daily security closing prices, then cached locally. Synced balances are used as reconciliation checkpoints.";

  const allSelected=!state.filters.accounts.size;
  $("#netWorthAccountFilters").innerHTML=`<button class="account-filter-chip ${allSelected?"active":""}" data-net-worth-all>All accounts</button>`+state.accounts.map(account=>`<button class="account-filter-chip ${allSelected||state.filters.accounts.has(String(account.id))?"active":""}" data-net-worth-account="${account.id}"><i style="background:${account.color}"></i>${escapeHtml(account.name)}</button>`).join("");
  $("#netWorthAccountList").innerHTML=data.accounts.map(account=>`<div class="net-worth-account-row"><i style="background:${account.color}"></i><div><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.institution)} · ${escapeHtml(account.type)}</small></div><b class="${account.balance<0?"negative":""}">${fmt(account.balance)}</b></div>`).join("")||`<p class="net-worth-empty">Select at least one account to calculate net worth.</p>`;

  const svg=$("#netWorthChart"),history=data.history;
  if(!history.length){netWorthChartState=null;$("#netWorthTooltip").hidden=true;svg.setAttribute("viewBox","0 0 1000 360");svg.innerHTML=`<text x="500" y="180" text-anchor="middle" class="axis-label">No net worth data in this range</text>`;return}
  const W=1000,H=360,pad={l:82,r:24,t:28,b:48};
  let min=Math.min(...history.map(point=>point.value)),max=Math.max(...history.map(point=>point.value));
  const spread=Math.max(1,max-min),margin=spread*.12;min-=margin;max+=margin;
  const x=index=>pad.l+(history.length===1?(W-pad.l-pad.r)/2:index*(W-pad.l-pad.r)/(history.length-1));
  const y=value=>pad.t+(H-pad.t-pad.b)*(1-(value-min)/(max-min));
  const line=history.map((point,index)=>`${index?"L":"M"} ${x(index).toFixed(2)} ${y(point.value).toFixed(2)}`).join(" ");
  let html=`<defs><linearGradient id="netWorthFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6d5dfc" stop-opacity=".24"/><stop offset="1" stop-color="#6d5dfc" stop-opacity="0"/></linearGradient></defs>`;
  for(let index=0;index<5;index++){
    const value=max-(max-min)*index/4,yy=y(value);
    html+=`<line x1="${pad.l}" y1="${yy}" x2="${W-pad.r}" y2="${yy}" class="grid-line"/><text x="${pad.l-12}" y="${yy+4}" text-anchor="end" class="axis-label">${fmt(value,true)}</text>`;
  }
  html+=`<path d="${line} L ${x(history.length-1)} ${H-pad.b} L ${x(0)} ${H-pad.b} Z" fill="url(#netWorthFill)"/><path d="${line}" class="net-worth-line"/>`;
  const labelIndexes=[0,Math.round((history.length-1)*.25),Math.round((history.length-1)*.5),Math.round((history.length-1)*.75),history.length-1];
  [...new Set(labelIndexes)].forEach(index=>{const point=history[index],label=new Date(`${point.date}T12:00:00`).toLocaleDateString("en-US",{month:"short",day:"numeric",year:history.length>365?"numeric":undefined});html+=`<text x="${x(index)}" y="${H-17}" text-anchor="middle" class="axis-label">${label}</text>`});
  const dotStep=Math.max(1,Math.ceil(history.length/45));
  history.forEach((point,index)=>{if(index%dotStep&&index!==history.length-1)return;const label=new Date(`${point.date}T12:00:00`).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});html+=`<circle cx="${x(index)}" cy="${y(point.value)}" r="3.5" class="net-worth-point"><title>${label}: ${fmt(point.value)}</title></circle>`});
  html+=`<rect x="${pad.l}" y="${pad.t}" width="${W-pad.l-pad.r}" height="${H-pad.t-pad.b}" fill="transparent" class="net-worth-hover-target"/><g class="net-worth-hover" id="netWorthHover" opacity="0"><line class="net-worth-hover-guide" x1="0" y1="${pad.t}" x2="0" y2="${H-pad.b}"/><circle class="net-worth-hover-point" cx="0" cy="0" r="5"/></g>`;
  svg.setAttribute("viewBox",`0 0 ${W} ${H}`);svg.innerHTML=html;
  netWorthChartState={history,W,H,pad,x,y,startValue};
}

function hideNetWorthHover(){
  $("#netWorthHover")?.setAttribute("opacity","0");
  $("#netWorthTooltip").hidden=true;
}

function updateNetWorthHover(event){
  const chart=netWorthChartState,svg=$("#netWorthChart"),hover=$("#netWorthHover"),tooltip=$("#netWorthTooltip");
  if(!chart||!hover)return;
  const bounds=svg.getBoundingClientRect(),plotWidth=chart.W-chart.pad.l-chart.pad.r;
  const svgX=(event.clientX-bounds.left)*chart.W/bounds.width;
  const svgY=(event.clientY-bounds.top)*chart.H/bounds.height;
  if(svgX<chart.pad.l||svgX>chart.W-chart.pad.r||svgY<chart.pad.t||svgY>chart.H-chart.pad.b)return hideNetWorthHover();
  const fraction=Math.max(0,Math.min(1,(svgX-chart.pad.l)/plotWidth));
  const index=chart.history.length===1?0:Math.round(fraction*(chart.history.length-1));
  const point=chart.history[index],pointX=chart.x(index),pointY=chart.y(point.value);
  const guide=hover.querySelector("line"),focus=hover.querySelector("circle");
  guide.setAttribute("x1",pointX);guide.setAttribute("x2",pointX);
  focus.setAttribute("cx",pointX);focus.setAttribute("cy",pointY);hover.setAttribute("opacity","1");
  const change=chart.startValue?(point.value-chart.startValue)/Math.abs(chart.startValue)*100:null;
  const date=new Date(`${point.date}T12:00:00`).toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric",year:"numeric"});
  const changeText=change===null?"Change unavailable":`${change>=0?"+":""}${change.toFixed(2)}% from ${new Date(`${chart.history[0].date}T12:00:00`).toLocaleDateString("en-US",{month:"short",day:"numeric"})}`;
  tooltip.innerHTML=`<span>${date}</span><strong>${fmt(point.value)}</strong><small class="${change===null?"":change>=0?"positive":"negative"}">${changeText}</small>`;
  tooltip.hidden=false;
  const wrapper=tooltip.parentElement,wrapperBounds=wrapper.getBoundingClientRect();
  const screenX=bounds.left+pointX/chart.W*bounds.width,screenY=bounds.top+pointY/chart.H*bounds.height;
  let left=screenX-wrapperBounds.left+wrapper.scrollLeft+12;
  if(left+tooltip.offsetWidth>wrapper.scrollLeft+wrapper.clientWidth-6)left=screenX-wrapperBounds.left+wrapper.scrollLeft-tooltip.offsetWidth-12;
  const top=Math.max(4,screenY-wrapperBounds.top-tooltip.offsetHeight/2);
  tooltip.style.left=`${left}px`;tooltip.style.top=`${top}px`;
}

function groupForCategory(category){return state.categoryGroups.find(group=>group.categories.includes(category))?.name||"Other"}
function transactionClass(transaction){const group=transaction.category_group||groupForCategory(transaction.category);return group==="Income"?"income":group==="Transfers"?"transfer":"expense"}

function cashFlowData(){
  const income=new Map(),expenses=new Map();
  for(const tx of state.transactions){
    const amount=Number(tx.amount)||0,group=tx.category_group||groupForCategory(tx.category),classification=transactionClass(tx);
    if(classification==="income"){const key=`${group}\u0000${tx.category}`;income.set(key,(income.get(key)||0)+amount)}
    if(classification==="expense"){const key=`${group}\u0000${tx.category}`;expenses.set(key,(expenses.get(key)||0)-amount)}
  }
  const sorted=map=>[...map].map(([key,value])=>{const [group,name]=key.split("\u0000");return {name,group,value}}).filter(item=>item.value>0).sort((a,b)=>b.value-a.value);
  return {income:sorted(income),expenses:sorted(expenses)};
}

function renderCashFlow(){
  const {income,expense,net}=state.summary.totals;
  $("#cashflowIncome").textContent=fmt(income);
  $("#cashflowExpense").textContent=fmt(expense);
  $("#cashflowNet").textContent=fmt(net);
  $("#cashflowNet").classList.toggle("negative",net<0);
  $("#cashflowNetLabel").textContent=net<0?"Expenses exceeded income":"Income minus expenses";
  const rate=income?net/income*100:0;
  $("#cashflowRate").textContent=`${rate.toFixed(1)}%`;
  $("#cashflowRate").classList.toggle("negative",rate<0);
  const availableMonths=new Set(state.summary.months.filter(month=>month.income||month.expense).map(month=>month.month));
  if(state.cashFlowMonthSelection&&!availableMonths.has(state.cashFlowMonthSelection))state.cashFlowMonthSelection=null;
  renderCashFlowBars();renderCashFlowMonthDetails();renderSankey();renderSankeyDetails();
}

function sankeyControl(scope,item,side,markup,className){
  const group=scope==="group"?item.name:item.group;
  if(item.synthetic){
    if(item.name!=="Net savings")return markup;
    return `<g class="${className} sankey-hover-only" data-sankey-scope="${scope}" data-sankey-name="${escapeHtml(item.name)}" data-sankey-group="${escapeHtml(group)}" data-sankey-side="${side}" data-sankey-clickable="false" aria-label="${escapeHtml(item.name)}">${markup}<title>${escapeHtml(item.name)}</title></g>`;
  }
  const selection=state.sankeySelection;
  const selected=selection?.scope===scope&&selection?.name===item.name&&selection?.side===side;
  const selectionRelated=selection?.side===side&&(selection.scope==="group"
    ? group===selection.group
    : (scope==="category"&&item.name===selection.name)||(scope==="group"&&item.name===selection.group));
  return `<g class="${className}${selected?" selected":""}${selectionRelated?" selection-related":""}" data-sankey-scope="${scope}" data-sankey-name="${escapeHtml(item.name)}" data-sankey-group="${escapeHtml(group)}" data-sankey-side="${side}" role="button" tabindex="0" aria-label="Show transactions for ${escapeHtml(item.name)}">${markup}<title>Show transactions for ${escapeHtml(item.name)}</title></g>`;
}
function sankeyNode(scope,item,side,markup){return sankeyControl(scope,item,side,markup,"sankey-node")}

function indexSankeyControls(svg){
  sankeyHovered.forEach(element=>element.classList.remove("related"));
  sankeyHovered=[];sankeyHoverKey="";
  const byGroup=new Map(),byCategory=new Map(),groupControls=new Map();
  const add=(map,key,element)=>{if(!map.has(key))map.set(key,[]);map.get(key).push(element)};
  svg.querySelectorAll("[data-sankey-scope]").forEach(element=>{
    const {sankeyScope:scope,sankeyName:name,sankeyGroup:group,sankeySide:side}=element.dataset;
    add(byGroup,`${side}\u0000${group}`,element);
    if(scope==="category")add(byCategory,`${side}\u0000${name}`,element);
    else add(groupControls,`${side}\u0000${name}`,element);
  });
  sankeyHoverIndex={byGroup,byCategory,groupControls};
}

function setSankeyHover(control,active){
  const scope=active&&control?control.dataset.sankeyScope:"";
  const name=active&&control?control.dataset.sankeyName:"";
  const group=active&&control?control.dataset.sankeyGroup:"";
  const side=active&&control?control.dataset.sankeySide:"";
  const nextKey=active?`${side}\u0000${scope}\u0000${name}`:"";
  if(nextKey===sankeyHoverKey)return;
  sankeyHovered.forEach(element=>element.classList.remove("related"));
  sankeyHoverKey=nextKey;
  if(!active){sankeyHovered=[];return}
  sankeyHovered=scope==="group"
    ? (sankeyHoverIndex.byGroup.get(`${side}\u0000${group}`)||[])
    : [...(sankeyHoverIndex.byCategory.get(`${side}\u0000${name}`)||[]),...(sankeyHoverIndex.groupControls.get(`${side}\u0000${group}`)||[])];
  sankeyHovered.forEach(element=>element.classList.add("related"));
}

function selectSankeyNode(element){
  const next={scope:element.dataset.sankeyScope,name:element.dataset.sankeyName,group:element.dataset.sankeyGroup,side:element.dataset.sankeySide};
  if(state.sankeySelection?.scope===next.scope&&state.sankeySelection?.name===next.name&&state.sankeySelection?.side===next.side)return clearSankeySelection();
  state.sankeySelection=next;
  renderSankey();renderSankeyDetails();
  requestAnimationFrame(()=>$("#sankeyDetails").scrollIntoView({behavior:"smooth",block:"start"}));
}

function clearSankeySelection(){
  if(!state.sankeySelection)return;
  state.sankeySelection=null;renderSankey();renderSankeyDetails();
}

function renderSankeyDetails(){
  const details=$("#sankeyDetails"),selection=state.sankeySelection;
  if(!selection){details.hidden=true;return}
  const rows=state.transactions.filter(transaction=>{
    if(transactionClass(transaction)!==selection.side)return false;
    return selection.scope==="category"
      ? transaction.category===selection.name
      : (transaction.category_group||groupForCategory(transaction.category))===selection.name;
  });
  const total=rows.reduce((sum,transaction)=>sum+(selection.side==="income"?Number(transaction.amount)||0:-(Number(transaction.amount)||0)),0);
  details.hidden=false;
  $("#sankeyDetailsType").textContent=`SELECTED ${selection.scope.toUpperCase()}`;
  $("#sankeyDetailsTitle").textContent=selection.name;
  $("#sankeyDetailsSummary").textContent=`${rows.length} transaction${rows.length===1?"":"s"} · ${fmt(total)} · active filters applied`;
  $("#sankeyDetailsTable").hidden=!rows.length;
  $("#sankeyDetailsEmpty").hidden=Boolean(rows.length);
  $("#sankeyDetailsRows").innerHTML=rows.map(transaction=>{
    const amount=Number(transaction.amount)||0,formatted=amount>0?`+${fmt(amount)}`:fmt(amount);
    return `<tr><td>${new Date(`${transaction.date}T12:00:00`).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}</td><td><strong>${escapeHtml(transaction.merchant)}</strong>${transaction.note?`<small>${escapeHtml(transaction.note)}</small>`:""}</td><td>${escapeHtml(transaction.category_group||groupForCategory(transaction.category))}</td><td><span class="category-chip">${escapeHtml(transaction.category)}</span></td><td>${escapeHtml(transaction.account_name)}</td><td class="right amount ${amount>0?"positive":""}">${formatted}</td></tr>`;
  }).join("");
}

function cashFlowMonthLabel(month,short=false,includeYear=false){
  return new Date(`${month}-02T12:00:00`).toLocaleDateString("en-US",short?{month:"short",year:includeYear?"2-digit":undefined}:{month:"long",year:"numeric"});
}

function renderCashFlowMonthDetails(){
  const details=$("#cashflowMonthDetails"),month=state.cashFlowMonthSelection;
  if(!month){details.hidden=true;return}
  const rows=state.transactions.filter(transaction=>transactionClass(transaction)!=="transfer"&&transaction.date.slice(0,7)===month);
  const income=rows.filter(transaction=>transactionClass(transaction)==="income").reduce((sum,transaction)=>sum+(Number(transaction.amount)||0),0);
  const expense=rows.filter(transaction=>transactionClass(transaction)==="expense").reduce((sum,transaction)=>sum-(Number(transaction.amount)||0),0);
  const net=income-expense,rate=income?net/income*100:null;
  details.hidden=false;
  $("#cashflowMonthDetailsTitle").textContent=cashFlowMonthLabel(month);
  $("#cashflowMonthDetailsSummary").textContent=`${rows.length} transaction${rows.length===1?"":"s"} · Income ${fmt(income)} · Expenses ${fmt(expense)} · Net income ${fmt(net)} · Saving rate ${rate===null?"—":`${rate.toFixed(1)}%`}`;
  $("#cashflowMonthDetailsTable").hidden=!rows.length;
  $("#cashflowMonthDetailsEmpty").hidden=Boolean(rows.length);
  $("#cashflowMonthDetailsRows").innerHTML=rows.map(transaction=>{
    const amount=Number(transaction.amount)||0,formatted=amount>0?`+${fmt(amount)}`:fmt(amount);
    return `<tr><td>${new Date(`${transaction.date}T12:00:00`).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}</td><td><strong>${escapeHtml(transaction.merchant)}</strong>${transaction.note?`<small>${escapeHtml(transaction.note)}</small>`:""}</td><td>${escapeHtml(transaction.category_group||groupForCategory(transaction.category))}</td><td><span class="category-chip">${escapeHtml(transaction.category)}</span></td><td>${escapeHtml(transaction.account_name)}</td><td class="right amount ${amount>0?"positive":""}">${formatted}</td></tr>`;
  }).join("");
}

function selectCashFlowMonth(month){
  state.cashFlowMonthSelection=state.cashFlowMonthSelection===month?null:month;
  renderCashFlowBars();renderCashFlowMonthDetails();
  if(state.cashFlowMonthSelection)requestAnimationFrame(()=>$("#cashflowMonthDetails").scrollIntoView({behavior:"smooth",block:"start"}));
}

function hideCashFlowBarTooltip(){
  $("#cashflowBarTooltip").hidden=true;
  $$("#cashflowBarChart .cashflow-month-group.hovered").forEach(group=>group.classList.remove("hovered"));
}

function showCashFlowBarTooltip(index){
  const chart=cashFlowBarChartState,svg=$("#cashflowBarChart"),tooltip=$("#cashflowBarTooltip");
  if(!chart||!chart.data[index])return hideCashFlowBarTooltip();
  const value=chart.data[index],net=value.income-value.expense,rate=value.income?net/value.income*100:null;
  $$("#cashflowBarChart .cashflow-month-group").forEach((group,groupIndex)=>group.classList.toggle("hovered",groupIndex===index));
  tooltip.innerHTML=`<span>${cashFlowMonthLabel(value.month)}</span><div><small>Income</small><strong class="positive">${fmt(value.income)}</strong></div><div><small>Expenses</small><strong class="negative">${fmt(value.expense)}</strong></div><div><small>Net income</small><strong class="${net>=0?"positive":"negative"}">${fmt(net)}</strong></div><div><small>Saving rate</small><strong class="${rate!==null&&rate<0?"negative":""}">${rate===null?"—":`${rate.toFixed(1)}%`}</strong></div>`;
  tooltip.hidden=false;
  const bounds=svg.getBoundingClientRect(),wrapperBounds=tooltip.parentElement.getBoundingClientRect();
  const pointX=chart.pad.l+chart.groupW*(index+.5),screenX=bounds.left+pointX/chart.W*bounds.width;
  let left=screenX-wrapperBounds.left+12;
  if(left+tooltip.offsetWidth>wrapperBounds.width-5)left=screenX-wrapperBounds.left-tooltip.offsetWidth-12;
  tooltip.style.left=`${Math.max(5,left)}px`;tooltip.style.top=`${Math.max(5,bounds.top-wrapperBounds.top+chart.pad.t)}px`;
}

function updateCashFlowBarHover(event){
  const chart=cashFlowBarChartState,svg=$("#cashflowBarChart");
  if(!chart)return;
  const bounds=svg.getBoundingClientRect(),svgX=(event.clientX-bounds.left)*chart.W/bounds.width,svgY=(event.clientY-bounds.top)*chart.H/bounds.height;
  if(svgX<chart.pad.l||svgX>chart.W-chart.pad.r||svgY<chart.pad.t||svgY>chart.H-chart.pad.b)return hideCashFlowBarTooltip();
  showCashFlowBarTooltip(Math.max(0,Math.min(chart.data.length-1,Math.floor((svgX-chart.pad.l)/chart.groupW))));
}

function renderCashFlowBars(){
  const svg=$("#cashflowBarChart"),data=state.summary.months.filter(month=>month.income||month.expense);
  hideCashFlowBarTooltip();
  if(!data.length){cashFlowBarChartState=null;hideCashFlowBarTooltip();svg.setAttribute("viewBox","0 0 900 320");svg.style.minWidth="900px";svg.innerHTML=`<text x="450" y="155" text-anchor="middle" class="axis-label">No income or expenses in this range</text>`;return}
  const W=Math.max(900,data.length*88),H=340,pad={l:68,r:26,t:26,b:52};
  const netValues=data.map(month=>month.income-month.expense),domainMin=Math.min(0,...data.flatMap(month=>[month.income,month.expense]),...netValues),domainMax=Math.max(1,...data.flatMap(month=>[month.income,month.expense]),...netValues);
  const plotW=W-pad.l-pad.r,plotH=H-pad.t-pad.b,groupW=plotW/data.length,barW=Math.min(26,groupW*.28);
  const y=value=>pad.t+plotH*(domainMax-value)/(domainMax-domainMin),zeroY=y(0);
  let html="";
  for(let i=0;i<5;i++){
    const value=domainMin+(domainMax-domainMin)*(4-i)/4,yy=y(value);
    html+=`<line x1="${pad.l}" y1="${yy}" x2="${W-pad.r}" y2="${yy}" class="grid-line${Math.abs(value)<.0001?" cashflow-zero-line":""}"/><text x="${pad.l-10}" y="${yy+4}" text-anchor="end" class="axis-label">${fmt(value,true)}</text>`;
  }
  data.forEach((month,index)=>{
    const center=pad.l+groupW*(index+.5),incomeY=y(month.income),expenseY=y(month.expense),label=cashFlowMonthLabel(month.month,true,data.length>12),selected=state.cashFlowMonthSelection===month.month;
    html+=`<g class="cashflow-month-group${selected?" selected":""}" data-cashflow-month="${month.month}" data-cashflow-index="${index}" role="button" tabindex="0" aria-label="Show transactions for ${cashFlowMonthLabel(month.month)}">${selected?`<rect class="cashflow-month-selection" x="${pad.l+groupW*index+3}" y="${pad.t}" width="${Math.max(1,groupW-6)}" height="${plotH}" rx="8"/>`:""}<rect class="cashflow-income-bar" x="${center-barW-2}" y="${Math.min(incomeY,zeroY)}" width="${barW}" height="${Math.abs(zeroY-incomeY)}" rx="4"/><rect class="cashflow-expense-bar" x="${center+2}" y="${Math.min(expenseY,zeroY)}" width="${barW}" height="${Math.abs(zeroY-expenseY)}" rx="4"/><text x="${center}" y="${H-17}" text-anchor="middle" class="axis-label">${label}</text><rect class="cashflow-month-hit" x="${pad.l+groupW*index}" y="${pad.t}" width="${groupW}" height="${H-pad.t-pad.b+30}" fill="transparent"/></g>`;
  });
  const line=netValues.map((value,index)=>`${index?"L":"M"} ${pad.l+groupW*(index+.5)} ${y(value)}`).join(" ");
  html+=`<path d="${line}" class="cashflow-net-line"/>`;
  netValues.forEach((value,index)=>{const center=pad.l+groupW*(index+.5),selected=state.cashFlowMonthSelection===data[index].month;html+=`<circle cx="${center}" cy="${y(value)}" r="${selected?5:4}" class="cashflow-net-point${selected?" selected":""}"/>`});
  svg.setAttribute("viewBox",`0 0 ${W} ${H}`);svg.style.minWidth=`${W}px`;svg.innerHTML=html;
  cashFlowBarChartState={data,W,H,pad,groupW,y};
}

function renderSankey(){
  const svg=$("#cashflowSankey"),flow=cashFlowData();
  const incomeTotal=flow.income.reduce((sum,item)=>sum+item.value,0);
  const expenseTotal=flow.expenses.reduce((sum,item)=>sum+item.value,0);
  if(!incomeTotal&&!expenseTotal){svg.classList.remove("sankey-selected");svg.setAttribute("viewBox","0 0 1000 420");svg.style.width="850px";svg.style.minWidth="850px";svg.innerHTML=`<text x="500" y="210" text-anchor="middle" class="axis-label">No income or expenses in this range</text>`;indexSankeyControls(svg);return}

  const groupItems=items=>{
    const grouped=new Map();
    for(const item of items){
      if(!grouped.has(item.group))grouped.set(item.group,[]);
      grouped.get(item.group).push(item);
    }
    return [...grouped].map(([name,categories])=>({name,categories:categories.sort((a,b)=>b.value-a.value),value:categories.reduce((sum,item)=>sum+item.value,0)})).sort((a,b)=>b.value-a.value);
  };
  const sourceGroups=groupItems(flow.income),targetGroups=groupItems(flow.expenses);
  if(expenseTotal>incomeTotal)sourceGroups.push({name:"Funding",value:expenseTotal-incomeTotal,synthetic:true,categories:[{name:"Cash reserves",group:"Funding",value:expenseTotal-incomeTotal,synthetic:true}]});
  if(incomeTotal>expenseTotal)targetGroups.push({name:"Net savings",value:incomeTotal-expenseTotal,synthetic:true,categories:[]});
  const sourceLeaves=sourceGroups.flatMap(group=>group.categories.map(category=>({...category,group:group.name})));
  const targetLeaves=targetGroups.flatMap(group=>group.categories.map(category=>({...category,group:group.name})));
  const total=Math.max(incomeTotal,expenseTotal),gap=25,pad=42;
  const maxNodes=Math.max(sourceLeaves.length,sourceGroups.length,targetGroups.length,targetLeaves.length,1);
  const H=Math.max(480,maxNodes*50+pad*2),scale=Math.max(.0001,(H-pad*2-gap*(maxNodes-1))/total);
  const widths={leaf:14,group:20,center:22};
  const labelSpan=(items,nameSize,valueSize)=>{
    const longest=Math.max(0,...items.flatMap(item=>[String(item.name).length*nameSize*.56,fmt(item.value).length*valueSize*.56]));
    return Math.max(110,longest*1.35);
  };
  const xs={sourceLeaf:8};
  xs.sourceGroup=xs.sourceLeaf+widths.leaf+labelSpan(sourceLeaves,11,9);
  xs.center=xs.sourceGroup+widths.group+labelSpan(sourceGroups,12,10);
  xs.targetGroup=xs.center+widths.center+labelSpan(targetGroups,12,10);
  xs.targetLeaf=xs.targetGroup+widths.group+labelSpan(targetLeaves,11,9);
  const W=xs.targetLeaf+widths.leaf+8,renderedWidth=Math.max(850,Math.ceil(W));
  const layout=items=>{
    const used=items.reduce((sum,item)=>sum+item.value*scale,0)+gap*Math.max(0,items.length-1);
    let y=(H-used)/2;
    return items.map(item=>{const node={...item,y,h:item.value*scale};y+=node.h+gap;return node});
  };
  const leftLeaves=layout(sourceLeaves),leftGroups=layout(sourceGroups),rightGroups=layout(targetGroups),rightLeaves=layout(targetLeaves);
  const centerH=total*scale,centerY=(H-centerH)/2;
  const sourceGroupNodes=new Map(leftGroups.map(node=>[node.name,node]));
  const targetGroupNodes=new Map(rightGroups.map(node=>[node.name,node]));
  const sourceGroupOffsets=new Map(),targetGroupOffsets=new Map();
  const palette=new Map();
  sourceGroups.forEach((group,i)=>palette.set(`source:${group.name}`,group.synthetic?"#9f938c":i?colors[(i+3)%colors.length]:"#28a792"));
  targetGroups.forEach((group,i)=>palette.set(`target:${group.name}`,group.synthetic?"#6d5dfc":colors[i%colors.length]));
  const path=(x1,y1,x2,y2,width,color,title,scope,item,side)=>{
    const d=`M ${x1} ${y1} C ${x1+(x2-x1)*.46} ${y1},${x1+(x2-x1)*.54} ${y2},${x2} ${y2}`;
    const markup=`<path class="sankey-link" d="${d}" fill="none" stroke="${color}" stroke-opacity=".32" stroke-width="${Math.max(.75,width)}"/><path class="sankey-link-hit" d="${d}" fill="none" stroke="transparent" stroke-width="${Math.max(16,width)}"/>`;
    return sankeyControl(scope,item,side,markup,"sankey-link-control")+`<title>${escapeHtml(title)}</title>`;
  };
  let html=`<defs><filter id="sankeyShadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity=".12"/></filter></defs>`;

  leftLeaves.forEach(leaf=>{
    const group=sourceGroupNodes.get(leaf.group),offset=sourceGroupOffsets.get(leaf.group)||0,color=palette.get(`source:${leaf.group}`),width=leaf.value*scale;
    html+=path(xs.sourceLeaf+widths.leaf,leaf.y+leaf.h/2,xs.sourceGroup,group.y+offset+leaf.h/2,width,color,`${leaf.name} → ${leaf.group}: ${fmt(leaf.value)}`,"category",leaf,"income");
    sourceGroupOffsets.set(leaf.group,offset+leaf.h);
  });
  let centerInOffset=0;
  leftGroups.forEach(group=>{
    const color=palette.get(`source:${group.name}`),width=group.value*scale;
    html+=path(xs.sourceGroup+widths.group,group.y+group.h/2,xs.center,centerY+centerInOffset+group.h/2,width,color,`${group.name}: ${fmt(group.value)}`,"group",group,"income");
    centerInOffset+=group.h;
  });
  let centerOutOffset=0;
  rightGroups.forEach(group=>{
    const color=palette.get(`target:${group.name}`),width=group.value*scale;
    html+=path(xs.center+widths.center,centerY+centerOutOffset+group.h/2,xs.targetGroup,group.y+group.h/2,width,color,`${group.name}: ${fmt(group.value)}`,"group",group,"expense");
    centerOutOffset+=group.h;
  });
  rightLeaves.forEach(leaf=>{
    const group=targetGroupNodes.get(leaf.group),offset=targetGroupOffsets.get(leaf.group)||0,color=palette.get(`target:${leaf.group}`),width=leaf.value*scale;
    html+=path(xs.targetGroup+widths.group,group.y+offset+leaf.h/2,xs.targetLeaf,leaf.y+leaf.h/2,width,color,`${leaf.group} → ${leaf.name}: ${fmt(leaf.value)}`,"category",leaf,"expense");
    targetGroupOffsets.set(leaf.group,offset+leaf.h);
  });

  leftLeaves.forEach(leaf=>{
    const color=palette.get(`source:${leaf.group}`),markup=`<rect x="${xs.sourceLeaf}" y="${leaf.y}" width="${widths.leaf}" height="${Math.max(1,leaf.h)}" rx="2" fill="${color}"/><text x="${xs.sourceLeaf+widths.leaf+10}" y="${leaf.y+leaf.h/2-2}" class="sankey-label">${escapeHtml(leaf.name)}</text><text x="${xs.sourceLeaf+widths.leaf+10}" y="${leaf.y+leaf.h/2+12}" class="sankey-value">${fmt(leaf.value)}</text>`;
    html+=sankeyNode("category",leaf,"income",markup);
  });
  leftGroups.forEach(group=>{
    const color=palette.get(`source:${group.name}`),markup=`<rect x="${xs.sourceGroup}" y="${group.y}" width="${widths.group}" height="${Math.max(1,group.h)}" rx="3" fill="${color}"/><text x="${xs.sourceGroup+widths.group+10}" y="${group.y+group.h/2-2}" class="sankey-group-label">${escapeHtml(group.name)}</text><text x="${xs.sourceGroup+widths.group+10}" y="${group.y+group.h/2+13}" class="sankey-group-value">${fmt(group.value)}</text>`;
    html+=sankeyNode("group",group,"income",markup);
  });
  rightGroups.forEach(group=>{
    const color=palette.get(`target:${group.name}`),markup=`<rect x="${xs.targetGroup}" y="${group.y}" width="${widths.group}" height="${Math.max(1,group.h)}" rx="3" fill="${color}"/><text x="${xs.targetGroup-10}" y="${group.y+group.h/2-2}" text-anchor="end" class="sankey-group-label">${escapeHtml(group.name)}</text><text x="${xs.targetGroup-10}" y="${group.y+group.h/2+13}" text-anchor="end" class="sankey-group-value">${fmt(group.value)}</text>`;
    html+=sankeyNode("group",group,"expense",markup);
  });
  rightLeaves.forEach(leaf=>{
    const color=palette.get(`target:${leaf.group}`),markup=`<rect x="${xs.targetLeaf}" y="${leaf.y}" width="${widths.leaf}" height="${Math.max(1,leaf.h)}" rx="2" fill="${color}"/><text x="${xs.targetLeaf-10}" y="${leaf.y+leaf.h/2-2}" text-anchor="end" class="sankey-label">${escapeHtml(leaf.name)}</text><text x="${xs.targetLeaf-10}" y="${leaf.y+leaf.h/2+12}" text-anchor="end" class="sankey-value">${fmt(leaf.value)}</text>`;
    html+=sankeyNode("category",leaf,"expense",markup);
  });
  html+=`<rect x="${xs.center}" y="${centerY}" width="${widths.center}" height="${centerH}" rx="5" fill="#2fa66f" filter="url(#sankeyShadow)"/><text x="${xs.center+widths.center/2}" y="${Math.max(20,centerY-14)}" text-anchor="middle" class="sankey-center-label">Available cash · ${fmt(total)}</text>`;
  svg.classList.toggle("sankey-selected",Boolean(state.sankeySelection));svg.setAttribute("viewBox",`0 0 ${W} ${H}`);svg.style.width=`${renderedWidth}px`;svg.style.minWidth=`${renderedWidth}px`;svg.innerHTML=html;indexSankeyControls(svg);
}

function buildFilterOptions(){
  $("#accountChecks").innerHTML=state.accounts.map(a=>`<label><input type="checkbox" value="${a.id}" ${state.filters.accounts.has(String(a.id))?"checked":""}>${escapeHtml(a.institution)} · ${escapeHtml(a.name)}</label>`).join("");
  $("#categoryChecks").innerHTML=state.categoryGroups.map((group,index)=>`<section class="category-filter-group"><label class="category-group-option"><input type="checkbox" data-category-group="${index}"><strong>${escapeHtml(group.name)}</strong></label><div>${group.categories.map(category=>`<label><input type="checkbox" data-category value="${escapeHtml(category)}" ${state.filters.categories.has(category)?"checked":""}>${escapeHtml(category)}</label>`).join("")}</div></section>`).join("");
  renderCategorySelect();
  syncCategoryGroupChecks();
}
function renderCategorySelect(){
  $("#categorySelect").innerHTML=`<option value="" selected disabled>Choose a category</option>`+state.categoryGroups.map(group=>`<optgroup label="${escapeHtml(group.name)}">${group.categories.map(category=>`<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("")}</optgroup>`).join("");
}
function syncCategoryGroupChecks(){
  $$("#categoryChecks [data-category-group]").forEach(groupInput=>{
    const children=$$("#categoryChecks .category-filter-group")[Number(groupInput.dataset.categoryGroup)]?.querySelectorAll("[data-category]")||[];
    const checked=[...children].filter(input=>input.checked).length;
    groupInput.checked=Boolean(children.length)&&checked===children.length;
    groupInput.indeterminate=checked>0&&checked<children.length;
  });
}
function updateFilterCount(){const n=state.filters.accounts.size+state.filters.categories.size+(state.filters.search?1:0);$("#filterCount").textContent=n}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function toast(msg){const el=$("#toast");el.textContent=msg;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),2600)}

function monitorPlaidSync(itemIds,{announce=true}={}){
  itemIds.map(Number).filter(Number.isInteger).forEach(id=>monitoredPlaidItems.add(id));
  announcePlaidSync||=announce;
  if(!plaidSyncPollTimer)plaidSyncPollTimer=setTimeout(pollPlaidSync,700);
}

async function pollPlaidSync(){
  plaidSyncPollTimer=null;
  try{
    const data=await request("/api/plaid/status"),items=new Map(data.items.map(item=>[item.id,item]));
    state.accounts=state.accounts.map(account=>{
      const item=items.get(account.plaid_item_id);
      return item?{...account,plaid_status:item.status,plaid_last_sync:item.last_sync}:account;
    });
    renderAccounts();
    let error=null;
    for(const id of [...monitoredPlaidItems]){
      const item=items.get(id);
      if(item?.status==="syncing")continue;
      monitoredPlaidItems.delete(id);
      if(item?.status==="sync_error")error=plaidSyncError=item.error_code||"SYNC_ERROR";
    }
    if(monitoredPlaidItems.size)return void(plaidSyncPollTimer=setTimeout(pollPlaidSync,1000));
    await load(true);
    if(announcePlaidSync)toast((error||plaidSyncError)?`Sync needs attention · ${error||plaidSyncError}`:"Sync complete");
    announcePlaidSync=false;plaidSyncError=null;
  }catch(error){
    if(monitoredPlaidItems.size)plaidSyncPollTimer=setTimeout(pollPlaidSync,2000);
  }
}

async function resumePlaidSyncs(){
  const itemIds=[...new Set(state.accounts.filter(account=>account.plaid_item_id&&account.plaid_status==="syncing").map(account=>account.plaid_item_id))];
  if(!itemIds.length)return;
  await Promise.all(itemIds.map(item_id=>request("/api/plaid/sync",{method:"POST",body:JSON.stringify({item_id,background:true})})));
  monitorPlaidSync(itemIds,{announce:false});
}

async function openConnectDialog() {
  try {
    const status=await request("/api/plaid/status");
    $("#connectionChoices").hidden=!status.configured;
    $("#plaidSetup").hidden=status.configured;
    $("#connectTitle").textContent=status.configured?"Connect an account":"Plaid setup required";
    $("#connectSubtitle").textContent=status.configured?"Choose the kind of account to link securely":"Your credentials stay in a local environment file";
    $("#connectDialog").showModal();
  } catch(error) { toast(error.message); }
}

async function startPlaidLink(linkToken, connectionType="bank") {
  try {
    if(!window.Plaid) throw new Error("Plaid Link could not load. Check your internet connection or content blocker.");
    const tokenData=linkToken?{link_token:linkToken}:await request("/api/plaid/link-token",{method:"POST",body:JSON.stringify({connection_type:connectionType})});
    localStorage.setItem("moneta_plaid_link_token",tokenData.link_token);
    const handler=window.Plaid.create({
      token:tokenData.link_token,
      ...(location.search.includes("oauth_state_id")?{receivedRedirectUri:location.href}:{}),
      onSuccess:async(publicToken,metadata)=>{
        toast(`Connecting ${metadata.institution?.name||"institution"}…`);
        try{
          const result=await request("/api/plaid/exchange",{method:"POST",body:JSON.stringify({public_token:publicToken,institution:metadata.institution,background:true})});
          localStorage.removeItem("moneta_plaid_link_token");
          history.replaceState({},document.title,location.pathname);
          toast(`Connected ${result.accounts} account${result.accounts===1?"":"s"} · syncing…`);
          await load(true);await navigateSection("accounts");
          monitorPlaidSync([result.item_id]);
        }catch(error){toast(error.message)}
      },
      onExit:error=>{if(error)toast(error.display_message||error.error_message||"Connection was not completed")}
    });
    handler.open();
  }catch(error){toast(error.message)}
}

async function syncPlaid(itemId) {
  const label=itemId?"account":"connected accounts";
  toast(`Syncing ${label}…`);
  const itemIds=itemId?[Number(itemId)]:[...new Set(state.accounts.filter(account=>account.plaid_item_id).map(account=>account.plaid_item_id))];
  state.accounts=state.accounts.map(account=>itemIds.includes(account.plaid_item_id)?{...account,plaid_status:"syncing"}:account);
  renderAccounts();
  try{
    const result=await request("/api/plaid/sync",{method:"POST",body:JSON.stringify(itemId?{item_id:Number(itemId),background:true}:{background:true})});
    monitorPlaidSync(result.results.map(row=>row.item_id));
  }catch(error){toast(error.message);await load(true)}
}

async function removeAccount(accountId, accountName) {
  const message = `Remove ${accountName}?\n\nThis will delete this account and its transactions from the local database.`;
  if(!confirm(message)) return;
  try {
    const result = await request(`/api/accounts/${accountId}`,{method:"DELETE"});
    toast(`Account removed · ${result.transactions_deleted} transaction${result.transactions_deleted===1?"":"s"} deleted`);
    state.filters.accounts.delete(String(accountId));
    await load(true);
  } catch(error) { toast(error.message); }
}

function switchSection(section,{push=true,preserveView=false}={}){
  if(!preserveView)state.activeView=null;
  state.section=section;
  $$(".nav-item[data-section]").forEach(x=>x.classList.toggle("active",x.dataset.section===section));
  $$(".view").forEach(x=>x.classList.remove("active"));
  if(section==="overview")$("#overviewView").classList.add("active");
  if(section==="cashflow")$("#cashflowView").classList.add("active");
  if(section==="networth")$("#networthView").classList.add("active");
  if(section==="accounts")$("#accountsView").classList.add("active");
  if(section==="insights")$("#insightsView").classList.add("active");
  if(section==="settings")$("#settingsView").classList.add("active");
  $("#pageTitle").textContent=state.activeView?.name||{overview:"Good morning.",cashflow:"Cash flow report",networth:"Net worth history",transactions:"All transactions",accounts:"Your accounts",insights:"Financial insights",settings:"Settings"}[section];
  $(".toolbar").style.display=section==="settings"?"none":"flex";
  $("#transactionsSection").style.display=["overview","transactions"].includes(section)?"block":"none";
  $("#seeAllBtn").style.display=section==="transactions"?"none":"block";
  renderReportContext();renderTransactions();
  document.title=`${state.activeView?.name||$("#pageTitle").textContent} — Moneta`;
  if(push&&location.pathname!==sectionPaths[section])history.pushState({},"",sectionPaths[section]);
  window.scrollTo({top:0,behavior:"smooth"});
}

function bind(){
  $$("#datePresets button").forEach(b=>b.onclick=async()=>{detachSavedView();setRange(b.dataset.range);await load()});
  $$(".nav-item[data-section]").forEach(b=>b.onclick=()=>navigateSection(b.dataset.section).catch(error=>toast(error.message)));
  $("#brandLink").onclick=event=>{event.preventDefault();navigateSection("overview").catch(error=>toast(error.message))};
  $("#savedViewsNav").onclick=event=>{
    const openId=Number(event.target.dataset.openView),deleteId=Number(event.target.dataset.deleteView);
    const view=state.views.find(item=>item.id===(openId||deleteId));
    if(!view)return;
    if(openId)openSavedView(view).catch(error=>toast(error.message));
    else deleteSavedView(view).catch(error=>toast(error.message));
  };
  $("#netWorthAccountFilters").onclick=async event=>{
    const allButton=event.target.closest?.("[data-net-worth-all]"),accountButton=event.target.closest?.("[data-net-worth-account]");
    if(!allButton&&!accountButton)return;
    if(allButton)state.filters.accounts.clear();
    else{
      const id=accountButton.dataset.netWorthAccount;
      if(!state.filters.accounts.size)state.filters.accounts=new Set(state.accounts.map(account=>String(account.id)));
      state.filters.accounts.has(id)?state.filters.accounts.delete(id):state.filters.accounts.add(id);
      if(!state.filters.accounts.size){state.filters.accounts.add(id);return toast("At least one account must remain selected")}
      if(state.filters.accounts.size===state.accounts.length)state.filters.accounts.clear();
    }
    buildFilterOptions();await load();
  };
  $("#netWorthChart").onpointermove=updateNetWorthHover;
  $("#netWorthChart").onpointerleave=hideNetWorthHover;
  $("#cashflowBarChart").onpointermove=updateCashFlowBarHover;
  $("#cashflowBarChart").onpointerleave=hideCashFlowBarTooltip;
  $("#cashflowBarChart").onclick=event=>{const group=event.target.closest?.("[data-cashflow-month]");if(group)selectCashFlowMonth(group.dataset.cashflowMonth)};
  $("#cashflowBarChart").onkeydown=event=>{if(!["Enter"," "].includes(event.key))return;const group=event.target.closest?.("[data-cashflow-month]");if(group){event.preventDefault();selectCashFlowMonth(group.dataset.cashflowMonth)}};
  $("#cashflowBarChart").onfocusin=event=>{const group=event.target.closest?.("[data-cashflow-index]");if(group)showCashFlowBarTooltip(Number(group.dataset.cashflowIndex))};
  $("#cashflowBarChart").onfocusout=event=>{if(!event.relatedTarget?.closest?.("#cashflowBarChart [data-cashflow-month]"))hideCashFlowBarTooltip()};
  $(".sankey-scroll").onclick=event=>{const node=event.target.closest?.("[data-sankey-scope]");if(node&&node.dataset.sankeyClickable!=="false")return selectSankeyNode(node);if(event.target===event.currentTarget||event.target===$("#cashflowSankey"))clearSankeySelection()};
  $("#cashflowSankey").onkeydown=event=>{if(!["Enter"," "].includes(event.key))return;const node=event.target.closest?.("[data-sankey-scope]");if(node&&node.dataset.sankeyClickable!=="false"){event.preventDefault();selectSankeyNode(node)}};
  $("#cashflowSankey").onpointerover=event=>{const control=event.target.closest?.("[data-sankey-scope]");if(control&&control!==event.relatedTarget?.closest?.("[data-sankey-scope]"))setSankeyHover(control,true)};
  $("#cashflowSankey").onpointerout=event=>{const control=event.target.closest?.("[data-sankey-scope]"),next=event.relatedTarget?.closest?.("[data-sankey-scope]");if(control&&control!==next)setSankeyHover(next,Boolean(next))};
  $("#cashflowSankey").onfocusin=event=>{const control=event.target.closest?.("[data-sankey-scope]");if(control)setSankeyHover(control,true)};
  $("#cashflowSankey").onfocusout=event=>{const next=event.relatedTarget?.closest?.("#cashflowSankey [data-sankey-scope]");setSankeyHover(next,Boolean(next))};
  $("#seeAllBtn").onclick=()=>navigateSection("transactions").catch(error=>toast(error.message));$("#insightsBtn").onclick=()=>navigateSection("insights").catch(error=>toast(error.message));$("#cashFlowBtn").onclick=()=>navigateSection("cashflow").catch(error=>toast(error.message));
  $("#mobileMenu")?.addEventListener("click",()=>$(".sidebar").classList.toggle("show"));
  $(".mobile-menu").onclick=()=>$(".sidebar").classList.toggle("show");
  $("#addBtn").onclick=()=>{document.querySelector("[name=date]").value=iso(new Date());$("#transactionDialog").showModal()};
  $("#connectBtn").onclick=()=>openConnectDialog();
  $$("#connectionChoices button").forEach(button=>button.onclick=e=>{
    e.preventDefault();$("#connectDialog").close();startPlaidLink(null,button.dataset.connectType);
  });
  $("#syncAllBtn").onclick=()=>syncPlaid();
  $("#accountsGrid").onclick=e=>{
    const syncId=e.target.dataset.sync;if(syncId)return syncPlaid(syncId);
    const removeId=e.target.dataset.removeAccount;if(removeId)return removeAccount(removeId,e.target.dataset.accountName||"this account");
  };
  $("#importBtn").onclick=()=>$("#importDialog").showModal();
  $("#filterBtn").onclick=$("#dateBtn").onclick=()=>{$("#filterPanel").classList.add("show");$("#scrim").classList.add("show")};
  const closePanel=()=>{$("#filterPanel").classList.remove("show");$("#scrim").classList.remove("show")};
  $("#scrim").onclick=closePanel;$("[data-close]").onclick=closePanel;
  $("#categoryChecks").onchange=e=>{
    if(e.target.matches("[data-category-group]"))e.target.closest(".category-filter-group").querySelectorAll("[data-category]").forEach(input=>input.checked=e.target.checked);
    syncCategoryGroupChecks();
  };
  $("#applyFilters").onclick=async()=>{
    detachSavedView();
    state.filters.from=$("#fromDate").value;state.filters.to=$("#toDate").value;
    state.range="custom";$$("#datePresets button").forEach(button=>button.classList.remove("active"));
    state.filters.accounts=new Set($$("#accountChecks input:checked").map(x=>x.value));
    state.filters.categories=new Set($$("#categoryChecks [data-category]:checked").map(x=>x.value));
    updateDateLabel();closePanel();await load();
  };
  $("#resetFilters").onclick=async()=>{detachSavedView();applyDefaultReportConfiguration();closePanel();await load()};
  $("#clearFiltersBtn").onclick=()=>$("#resetFilters").click();
  let searchTimer;$("#searchInput").oninput=e=>{clearTimeout(searchTimer);searchTimer=setTimeout(async()=>{detachSavedView();state.filters.search=e.target.value.trim();await load()},250)};
  $("#saveViewBtn").onclick=()=>{reportSettingsSummary();$("#viewName").value="";$("#saveViewDialog").showModal();$("#viewName").focus()};
  $("#saveViewForm").onsubmit=async event=>{
    if(event.submitter?.value==="cancel")return;
    event.preventDefault();
    try{
      const view=await request("/api/views",{method:"POST",body:JSON.stringify({name:$("#viewName").value,configuration:currentReportConfiguration()})});
      state.views.push(view);state.views.sort((a,b)=>a.name.localeCompare(b.name));
      $("#saveViewDialog").close();toast("Report view saved");await openSavedView(view);
    }catch(error){toast(error.message)}
  };
  $("#transactionForm").onsubmit=async e=>{
    const trigger=e.submitter;if(trigger?.value==="cancel")return;
    e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget));
    try{await request("/api/transactions",{method:"POST",body:JSON.stringify(data)});$("#transactionDialog").close();e.currentTarget.reset();toast("Transaction added");await load(true)}catch(err){toast(err.message)}
  };
  $("#transactionRows").onclick=async e=>{
    const id=e.target.dataset.delete;if(!id)return;
    if(confirm("Delete this transaction?")){await request(`/api/transactions/${id}`,{method:"DELETE"});toast("Transaction deleted");await load(true)}
  };
  $("#importForm").onsubmit=async e=>{
    if(e.submitter?.value==="cancel")return;e.preventDefault();
    const file=$("#csvFile").files[0];if(!file)return toast("Choose a CSV file first");
    try{
      const rows=parseCSV(await file.text());
      const result=await request("/api/import",{method:"POST",body:JSON.stringify({account_id:Number($("#importAccount").value),rows})});
      $("#importDialog").close();toast(`Imported ${result.added}; skipped ${result.skipped}`);await load(true);
    }catch(err){toast(err.message)}
  };
  $("#plaidSecret").oninput=()=>{if($("#plaidSecret").value)$("#clearPlaidSecret").checked=false};
  $("#plaidSettingsForm").onsubmit=async event=>{
    event.preventDefault();
    const submit=event.submitter||$("#plaidSettingsForm button[type=submit]");submit.disabled=true;
    try{
      state.settings=await request("/api/settings/plaid",{method:"PUT",body:JSON.stringify({
        environment:$("#plaidEnvironment").value,
        client_id:$("#plaidClientId").value,
        secret:$("#plaidSecret").value,
        redirect_uri:$("#plaidRedirectUri").value,
        clear_secret:$("#clearPlaidSecret").checked
      })});
      renderSettings();toast("Plaid settings saved");
    }catch(error){toast(error.message)}finally{submit.disabled=false}
  };
  $("#generateDemoBtn").onclick=async event=>{
    if(!confirm("Generate four demo accounts and 25 sample transactions?\n\nYour existing data will not be changed."))return;
    const button=event.currentTarget;button.disabled=true;button.textContent="Generating…";
    try{
      const result=await request("/api/settings/demo-data",{method:"POST"});
      await load(true);await loadSettings();
      toast(result.accounts_added||result.transactions_added?`Added ${result.accounts_added} accounts and ${result.transactions_added} transactions`:"Demo data already exists");
    }catch(error){toast(error.message)}finally{button.disabled=false;button.textContent="＋ Generate demo data"}
  };
  window.addEventListener("popstate",()=>navigateFromLocation().catch(error=>toast(error.message)));
}

function parseCSV(text){
  const lines=text.trim().split(/\r?\n/).filter(Boolean), headers=splitCSV(lines.shift()).map(x=>x.trim().toLowerCase());
  for(const required of ["date","merchant","amount","category"])if(!headers.includes(required))throw new Error(`CSV needs a “${required}” column`);
  return lines.map(line=>{const vals=splitCSV(line),row={};headers.forEach((h,i)=>row[h]=vals[i]?.trim()||"");row.amount=Number(row.amount.replace(/[$,]/g,""));if(!row.date||!row.merchant||!row.category||Number.isNaN(row.amount))throw new Error("One or more CSV rows is invalid");return row});
}
function splitCSV(line){const out=[];let value="",quoted=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'&&line[i+1]==='"'){value+='"';i++}else if(c==='"')quoted=!quoted;else if(c===","&&!quoted){out.push(value);value=""}else value+=c}out.push(value);return out}

async function initialize(){
  const hasOauthState=location.search.includes("oauth_state_id");
  setRange("quarter");bind();
  const route=parseRoute();
  let initialView=null;
  if(route.viewId){
    try{initialView=await request(`/api/views/${route.viewId}`);applyReportConfiguration(initialView.configuration,{rebuild:false})}
    catch(error){toast(error.message);history.replaceState({},"",sectionPaths.cashflow)}
  }
  await load(true);
  if(initialView){state.activeView=state.views.find(view=>view.id===initialView.id)||initialView;switchSection("cashflow",{push:false,preserveView:true})}
  else{
    const section=parseRoute().section||"cashflow";
    switchSection(section,{push:false});
    if(section==="settings")await loadSettings();
    if(location.pathname==="/"&&!hasOauthState)history.replaceState({},"",sectionPaths.overview);
  }
  await resumePlaidSyncs();
  if(hasOauthState){
    const token=localStorage.getItem("moneta_plaid_link_token");
    if(token)startPlaidLink(token);
  }
}
initialize().catch(error=>toast(error.message));
