import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

// Run the real client functions with a small DOM adapter, without fetching any
// financial data or starting the application initialization/network lifecycle.
function client({fetch:fetchOverride}={}) {
  const elements=new Map(),routes=[];
  const bounds=()=>({left:0,top:0,width:1000,height:340});
  const element=selector=>{
    if(!elements.has(selector)){
      const classes=new Set(),attributes=new Map();
      elements.set(selector,{
        innerHTML:"",textContent:"",value:"",hidden:false,style:{},dataset:{},offsetWidth:210,
        classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),
          contains:name=>classes.has(name),toggle(name,enabled){
            const add=enabled??!classes.has(name);if(add)classes.add(name);else classes.delete(name);return add;
          }},
        setAttribute:(name,value)=>attributes.set(name,value),getAttribute:name=>attributes.get(name),
        querySelectorAll:()=>[],getBoundingClientRect:bounds,parentElement:{getBoundingClientRect:bounds},
        scrollIntoView(){},addEventListener(){},click(){return this.onclick?.({target:this,currentTarget:this});}
      });
    }
    return elements.get(selector);
  };
  const context=createContext({
    document:{querySelector:element,querySelectorAll:()=>[]},
    window:{addEventListener(){},scrollTo(){}},location:{pathname:"/cash-flow",search:""},
    history:{pushState:(_state,_title,path)=>routes.push(path)},
    requestAnimationFrame:callback=>callback(),setTimeout,clearTimeout,URLSearchParams,
    fetch:fetchOverride||(()=>{throw new Error("Month selection must not fetch or change the underlying report data")})
  });
  const source=readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
  const initialization=source.lastIndexOf("initialize().catch(");
  assert.ok(initialization>0);
  runInContext(source.slice(0,initialization)+`
    globalThis.app={state,bind,renderCashFlow,selectCashFlowMonth,selectSankeyNode,
      cashFlowTransactions,cashFlowData,showCashFlowBarTooltip,setRange,
      currentReportConfiguration,applyReportConfiguration,applyDefaultReportConfiguration,renderPaycheckReporting,reportSettingsSummary,queryString,
      bankEndpointMode,indexSankeyControls,setSankeyHover,load,
      barData:()=>cashFlowBarChartState?.data};
  `,context);
  const app=context.app;
  app.state.section="cashflow";
  const row=(date,merchant,amount,category,category_group)=>({date,merchant,amount,category,category_group,account_name:"Test account"});
  app.state.transactions=[
    row("2025-09-01","Older September salary",900,"Paychecks","Income"),
    row("2025-09-02","Older September groceries",-300,"Groceries","Food & Dining"),
    row("2026-08-01","August salary",1000,"Paychecks","Income"),
    row("2026-08-02","August groceries",-100,"Groceries","Food & Dining"),
    row("2026-09-01","September salary",2000,"Paychecks","Income"),
    row("2026-09-02","September groceries",-120,"Groceries","Food & Dining"),
    row("2026-09-03","September grocery refund",20,"Groceries","Food & Dining"),
    row("2026-09-04","September rent",-400,"Rent","Housing"),
    row("2026-09-05","September transfer",-9999,"Transfer","Transfers"),
    row("2026-10-01","October salary",3000,"Paychecks","Income"),
    row("2026-10-02","October groceries",-600,"Groceries","Food & Dining")
  ];
  app.state.summary={totals:{income:6900,expense:1500,net:5400,transfer:-9999},months:[
    {month:"2025-09",income:900,expense:300},{month:"2026-08",income:1000,expense:100},
    {month:"2026-09",income:2000,expense:500},{month:"2026-10",income:3000,expense:600}
  ]};
  app.state.filters.from="2025-01-01";app.state.filters.to="2026-10-31";app.state.range="custom";
  app.bind();app.renderCashFlow();
  const clickMonth=month=>element("#cashflowBarChart").onclick({target:{closest:()=>({dataset:{cashflowMonth:month}})}});
  return {app,element,routes,clickMonth};
}

test("clicking a month filters cash-flow totals, Sankey, and details while retaining all bars",()=>{
  const {app,element,clickMonth}=client();
  const originalTransactions=app.state.transactions,originalSummary=app.state.summary;
  clickMonth("2026-09");
  assert.equal(element("#cashflowIncome").textContent,"$2,000.00");
  assert.equal(element("#cashflowExpense").textContent,"$500.00");
  assert.equal(element("#cashflowNet").textContent,"$1,500.00");
  assert.equal(element("#cashflowRate").textContent,"75.0%");
  assert.match(element("#cashflowIncomeLabel").textContent,/September 2026/);
  assert.match(element("#reportContextDescription").textContent,/bar chart keeps the full date range/);
  assert.deepEqual(Array.from(app.barData(),month=>month.month),["2025-09","2026-08","2026-09","2026-10"]);
  assert.match(element("#cashflowBarChart").innerHTML,/data-cashflow-month="2026-09"[^>]*aria-pressed="true"/);
  assert.equal(app.cashFlowTransactions().length,5);
  const flow=app.cashFlowData();
  assert.equal(flow.income[0].value,2000);
  assert.equal(flow.expenses.find(item=>item.name==="Groceries").value,100);
  assert.equal(flow.expenses.find(item=>item.name==="Rent").value,400);
  assert.match(element("#cashflowSankey").innerHTML,/Available cash · \$2,000.00/);
  assert.match(element("#cashflowMonthDetailsRows").innerHTML,/September salary/);
  assert.doesNotMatch(element("#cashflowMonthDetailsRows").innerHTML,/Older September|August|October|September transfer/);

  app.selectSankeyNode({dataset:{sankeyScope:"category",sankeyName:"Groceries",sankeyGroup:"Food & Dining",sankeySide:"expense"}});
  assert.match(element("#sankeyDetailsSummary").textContent,/2 transactions · \$100.00/);
  assert.match(element("#sankeyDetailsRows").innerHTML,/September grocery refund/);
  assert.doesNotMatch(element("#sankeyDetailsRows").innerHTML,/Older September|August|October/);
  app.showCashFlowBarTooltip(3);
  assert.match(element("#cashflowBarTooltip").innerHTML,/October 2026/);
  assert.match(element("#cashflowBarTooltip").innerHTML,/\$3,000.00/);
  assert.equal(app.state.transactions,originalTransactions);
  assert.equal(app.state.summary,originalSummary);
  assert.equal(app.state.filters.from,"2025-01-01");
  assert.equal(app.state.filters.to,"2026-10-31");
});

test("full-paycheck charts and drill-down use report rows without changing the transaction ledger",()=>{
  const {app,element,clickMonth}=client();
  const original=app.state.transactions;
  app.state.paycheckMode="full-paycheck";
  app.state.reporting={contribution_account_ids:[1],contribution_amount:500};
  app.state.reportTransactions=[...original,{
    id:99,date:"2026-09-05",merchant:"Payroll retirement contribution",amount:500,
    account_name:"Parent retirement plan",category:"Paychecks",category_group:"Income",
    original_category:"Transfer",report_adjustment:"payroll_contribution"
  }];
  app.state.summary=JSON.parse(JSON.stringify(app.state.summary));
  app.state.summary.totals.income+=500;
  app.state.summary.months.find(row=>row.month==="2026-09").income+=500;
  app.renderPaycheckReporting();app.renderCashFlow();clickMonth("2026-09");
  assert.equal(element("#cashflowIncome").textContent,"$2,500.00");
  assert.equal(element("#cashflowNet").textContent,"$2,000.00");
  assert.equal(element("#cashflowRate").textContent,"80.0%");
  assert.match(element("#cashflowSankey").innerHTML,/Available cash · \$2,500.00/);
  assert.match(element("#cashflowMonthDetailsRows").innerHTML,/Payroll retirement contribution/);
  app.selectSankeyNode({dataset:{sankeyScope:"category",sankeyName:"Paychecks",sankeyGroup:"Income",sankeySide:"income"}});
  assert.match(element("#sankeyDetailsSummary").textContent,/2 transactions · \$2,500.00/);
  assert.match(element("#sankeyDetailsRows").innerHTML,/Payroll retirement contribution/);
  assert.equal(app.state.transactions,original);
  assert.equal(app.queryString().get("paycheck_mode"),"full-paycheck");
  assert.equal(element("#paycheckMode").value,"full-paycheck");
  assert.equal(element("#paycheckReportingNote").hidden,false);
  assert.match(element("#paycheckReportingNote").innerHTML,/\$500.00/);
});

test("saved views remember paycheck mode, while leaving a view restores the persisted default",()=>{
  const {app,element}=client();
  app.state.paycheckMode="full-paycheck";
  const configuration=app.currentReportConfiguration();
  assert.equal(configuration.paycheck_mode,"full-paycheck");
  app.state.paycheckMode="take-home";
  app.applyReportConfiguration(configuration,{rebuild:false});
  assert.equal(app.state.paycheckMode,"full-paycheck");
  app.reportSettingsSummary();
  assert.match(element("#reportSettingsSummary").innerHTML,/Full paycheck/);
  app.state.defaultPaycheckMode="take-home";app.applyDefaultReportConfiguration();
  assert.equal(app.state.paycheckMode,"take-home");
  app.state.defaultPaycheckMode="full-paycheck";app.applyDefaultReportConfiguration();
  assert.equal(app.state.paycheckMode,"full-paycheck");
  app.applyReportConfiguration({filters:{range:"all"}},{rebuild:false});
  assert.equal(app.state.paycheckMode,"take-home");
  app.renderPaycheckReporting();assert.equal(element("#paycheckReportingNote").hidden,true);
  app.state.paycheckMode="full-paycheck";app.state.reporting={contribution_account_ids:[]};
  app.renderPaycheckReporting();assert.match(element("#paycheckReportingNote").innerHTML,/Configure payroll plans in Settings/);
});

test("bank cash flow drives account-based Sankey, monthly bars, drill-downs, and cash labels without changing the normal report",()=>{
  const {app,element,clickMonth}=client(),normalSummary=app.state.summary,normalTransactions=app.state.transactions;
  app.state.cashFlowConfiguration={mode:"bank-endpoints",endpoint_account_ids:[1,2]};
  app.state.cashFlowAccounts=[{id:1,name:"Main bank",institution:"Test Bank"},{id:2,name:"Savings bank",institution:"Test Bank"}];
  app.state.effectiveEndpoints=[1,2];
  const bank=(id,account_id,date,amount,category)=>({id,account_id,date,amount,merchant:`Bank movement ${id}`,account_name:account_id===1?"Main bank":"Savings bank",endpoint_name:account_id===1?"Main bank":"Savings bank",category,category_group:category==="Paychecks"?"Income":"Transfers",report_adjustment:"bank_cash_movement"});
  app.state.cashFlowReport={transactions:[
    bank(1,1,"2026-08-10",1000,"Paychecks"),bank(2,1,"2026-08-11",-100,"Credit Card Payment"),
    bank(3,1,"2026-09-10",2000,"Paychecks"),bank(4,1,"2026-09-11",-600,"Credit Card Payment"),
    bank(5,2,"2026-09-12",-200,"Credit Card Payment"),bank(6,1,"2026-09-13",50,"Groceries")
  ],internal_transfers:[{...bank(7,1,"2026-09-14",-300,"Transfer"),counterpart_account_name:"Savings bank"}],
    summary:{totals:{income:3050,expense:900,net:2150},months:[{month:"2026-08",income:1000,expense:100},{month:"2026-09",income:2050,expense:800}]},pending_count:1,unmatched_transfer_count:1};
  app.state.paycheckMode="full-paycheck";app.renderPaycheckReporting();app.renderCashFlow();clickMonth("2026-09");
  assert.equal(element("#paycheckModeControl").hidden,true);
  assert.equal(element("#cashflowIncomeTitle").textContent,"Cash inflow");
  assert.equal(element("#cashflowExpenseTitle").textContent,"Cash outflow");
  assert.equal(element("#cashflowIncome").textContent,"$2,050.00");
  assert.equal(element("#cashflowExpense").textContent,"$800.00");
  assert.equal(element("#cashflowNet").textContent,"$1,250.00");
  assert.equal(element("#cashflowSankeyTitle").textContent,"Account endpoint flow");
  assert.match(element("#cashflowSankey").innerHTML,/Main bank|Savings bank/);
  assert.match(element("#cashflowSankey").innerHTML,/Cash retained/);
  assert.match(element("#bankEndpointSummary").innerHTML,/\$2,050.00/);
  assert.match(element("#bankEndpointSummary").innerHTML,/-\$300.00/);
  assert.match(element("#bankEndpointSummary").innerHTML,/\$1,150.00/);
  assert.match(element("#bankInternalTransferRows").innerHTML,/Bank movement 7/);
  assert.match(element("#bankEndpointNote").textContent,/pending entries excluded/);
  assert.match(element("#cashflowMonthDetailsSummary").textContent,/Cash inflow/);
  assert.doesNotMatch(element("#cashflowMonthDetailsRows").innerHTML,/September groceries|Bank movement 7/);
  assert.equal(app.barData().length,2);
  assert.equal(app.cashFlowData().expenses.length,2); // Same category, distinct bank endpoints.
  app.selectSankeyNode({dataset:{sankeyScope:"group",sankeyName:"Main bank",sankeyGroup:"Main bank",sankeySide:"expense"}});
  assert.match(element("#sankeyDetailsSummary").textContent,/1 transaction · \$600.00/);
  assert.equal(element("#sankeyDetailsType").textContent,"SELECTED ENDPOINT");
  app.selectSankeyNode({dataset:{sankeyScope:"category",sankeyName:"Credit Card Payment",sankeyGroup:"Main bank",sankeySide:"expense"}});
  app.selectSankeyNode({dataset:{sankeyScope:"category",sankeyName:"Credit Card Payment",sankeyGroup:"Savings bank",sankeySide:"expense"}});
  assert.equal(app.state.sankeySelection.group,"Savings bank");
  assert.match(element("#sankeyDetailsSummary").textContent,/1 transaction · \$200.00/);
  app.showCashFlowBarTooltip(1);assert.match(element("#cashflowBarTooltip").innerHTML,/Cash inflow/);
  assert.equal(app.state.summary,normalSummary);assert.equal(app.state.transactions,normalTransactions);
  const config=JSON.parse(JSON.stringify(app.currentReportConfiguration()));
  assert.deepEqual(config.cash_flow,{mode:"bank-endpoints",endpoint_account_ids:[1,2]});
  app.applyReportConfiguration(config,{rebuild:false});
  assert.equal(app.bankEndpointMode(),true);assert.equal(app.queryString().get("endpoints"),"1,2");
  assert.equal(app.queryString().get("cash_flow_mode"),"bank-endpoints");
  app.applyDefaultReportConfiguration();assert.equal(app.bankEndpointMode(),false);
});

test("investment endpoints show excluded trades separately and only report their fees as outflow",()=>{
  const {app,element,clickMonth}=client();
  app.state.cashFlowConfiguration={mode:"bank-endpoints",endpoint_account_ids:[11]};
  app.state.cashFlowAccounts=[{id:11,name:"Robinhood",institution:"Broker",type:"investment"}];
  app.state.effectiveEndpoints=[11];
  const trade={id:1,account_id:11,date:"2026-09-10",merchant:"Stock purchase",account_name:"Robinhood",endpoint_name:"Robinhood",amount:-1002,investment_action:"buy",category:"Buy",category_group:"Transfers",report_adjustment:"bank_cash_movement"};
  app.state.cashFlowReport={transactions:[{...trade,amount:-2,category:"Financial Fees",category_group:"Financial",report_component:"trade_fee"}],
    investment_activity:[trade],internal_transfers:[],summary:{totals:{income:0,expense:2,net:-2},months:[{month:"2026-09",income:0,expense:2}]}};
  app.renderCashFlow();clickMonth("2026-09");
  assert.equal(element("#cashflowExpense").textContent,"$2.00");
  assert.equal(element("#endpointInvestmentActivity").hidden,false);
  assert.match(element("#endpointInvestmentActivityRows").innerHTML,/\$1,002.00/);
  assert.match(element("#endpointInvestmentActivityLabel").textContent,/1 entries/);
  assert.match(element("#cashflowMonthDetailsRows").innerHTML,/Reported trading fee/);
  assert.doesNotMatch(element("#cashflowMonthDetailsRows").innerHTML,/\$1,002.00/);
  assert.match(element("#cashflowSankey").innerHTML,/Robinhood/);
  assert.match(element("#bankEndpointNote").textContent,/Investment trades are internal/);
});

test("bank endpoint mode has an explicit empty state and does not fall back to credit-card activity",()=>{
  const {app,element}=client();
  app.state.cashFlowConfiguration={mode:"bank-endpoints",endpoint_account_ids:[]};app.renderCashFlow();
  assert.equal(app.cashFlowTransactions().length,0);
  assert.equal(element("#cashflowIncome").textContent,"$0.00");
  assert.match(element("#bankEndpointNote").textContent,/Choose at least one endpoint/);
  assert.match(element("#cashflowSankey").innerHTML,/Choose endpoint accounts/);
  app.state.cashFlowConfiguration.endpoint_account_ids=[1];app.renderCashFlow();
  assert.match(element("#bankEndpointNote").textContent,/account filter excludes all/);
  app.state.cashFlowConfiguration.endpoint_account_ids=[1,11];app.state.effectiveEndpoints=[1];
  app.state.cashFlowAccounts=[{id:1,name:"Bank",institution:"Test",type:"checking"},{id:11,name:"Robinhood",institution:"Broker",type:"investment"}];
  app.renderCashFlow();assert.match(element("#bankEndpointNote").textContent,/account filter excludes Robinhood/);
});

test("Sankey hover distinguishes repeated categories belonging to different endpoint accounts",()=>{
  const {app,element}=client();
  const controls=[element("#bank-one-category"),element("#bank-two-category"),element("#bank-one-group"),element("#bank-two-group")];
  controls.forEach((control,index)=>{control.dataset={sankeyScope:index<2?"category":"group",sankeyName:index<2?"Credit Card Payment":index===2?"Bank one":"Bank two",sankeyGroup:index%2?"Bank two":"Bank one",sankeySide:"expense"}});
  app.indexSankeyControls({querySelectorAll:()=>controls});
  app.setSankeyHover(controls[0],true);
  assert.equal(controls[0].classList.contains("related"),true);assert.equal(controls[2].classList.contains("related"),true);
  assert.equal(controls[1].classList.contains("related"),false);
  app.setSankeyHover(controls[1],true);
  assert.equal(controls[0].classList.contains("related"),false);assert.equal(controls[2].classList.contains("related"),false);
  assert.equal(controls[1].classList.contains("related"),true);assert.equal(controls[3].classList.contains("related"),true);
});

test("month filters can switch, clear on a second click, and respond to keyboard activation",()=>{
  const {app,element,clickMonth}=client();
  clickMonth("2026-09");clickMonth("2026-08");
  assert.equal(app.state.cashFlowMonthSelection,"2026-08");
  assert.equal(element("#cashflowIncome").textContent,"$1,000.00");
  clickMonth("2026-08");
  assert.equal(app.state.cashFlowMonthSelection,null);
  assert.equal(element("#cashflowIncome").textContent,"$6,900.00");
  assert.equal(element("#cashflowExpense").textContent,"$1,500.00");
  assert.equal(element("#cashflowMonthDetails").hidden,true);
  assert.equal(app.barData().length,4);
  let prevented=false;
  element("#cashflowBarChart").onkeydown({key:"Enter",preventDefault(){prevented=true},
    target:{closest:()=>({dataset:{cashflowMonth:"2026-09"}})}});
  assert.equal(prevented,true);
  assert.equal(app.state.cashFlowMonthSelection,"2026-09");
  assert.equal(element("#cashflowNet").textContent,"$1,500.00");
  clickMonth("2026-13");
  assert.equal(app.state.cashFlowMonthSelection,"2026-09");
});

test("month selection narrows already-filtered data without broadening account or category filters",()=>{
  const {app,element,clickMonth}=client();
  app.state.filters.accounts.add("7");app.state.filters.categories.add("Groceries");
  app.state.transactions=app.state.transactions.filter(row=>row.category==="Groceries");
  app.state.summary={totals:{income:0,expense:1100,net:-1100},months:[
    {month:"2025-09",income:0,expense:300},{month:"2026-08",income:0,expense:100},
    {month:"2026-09",income:0,expense:100},{month:"2026-10",income:0,expense:600}
  ]};
  clickMonth("2026-09");
  assert.equal(element("#cashflowIncome").textContent,"$0.00");
  assert.equal(element("#cashflowExpense").textContent,"$100.00");
  assert.equal(element("#cashflowNet").textContent,"-$100.00");
  assert.equal(app.cashFlowTransactions().length,2);
  assert.equal(app.cashFlowData().expenses.length,1);
  assert.equal(app.barData().length,4);
  const query=app.queryString();
  assert.equal(query.get("accounts"),"7");
  assert.equal(query.get("categories"),"Groceries");
  assert.equal(query.get("from"),"2025-01-01");
  assert.equal(query.has("month"),false);
  assert.doesNotMatch(element("#cashflowMonthDetailsRows").innerHTML,/salary|rent|transfer/i);
});

test("month focus combines with active filters and is included in saved report configuration",()=>{
  const {app,element,routes,clickMonth}=client();
  app.state.filters.accounts.add("7");app.state.filters.categories.add("Groceries");app.state.filters.search="market";
  app.state.activeView={id:8,name:"Saved report"};
  clickMonth("2026-09");
  assert.equal(app.state.activeView,null);
  assert.equal(routes.at(-1),"/cash-flow");
  const configuration=JSON.parse(JSON.stringify(app.currentReportConfiguration()));
  assert.equal(configuration.filters.month,"2026-09");
  assert.deepEqual(configuration.filters.accounts,[7]);
  assert.deepEqual(configuration.filters.categories,["Groceries"]);
  assert.equal(configuration.filters.search,"market");
  app.reportSettingsSummary();
  assert.match(element("#reportSettingsSummary").innerHTML,/Month focus/);
  assert.match(element("#reportSettingsSummary").innerHTML,/September 2026/);
  app.applyReportConfiguration(configuration,{rebuild:false});app.renderCashFlow();
  assert.equal(app.state.cashFlowMonthSelection,"2026-09");
  assert.equal(element("#cashflowIncome").textContent,"$2,000.00");
  app.applyReportConfiguration({filters:{range:"custom",from:"2026-08-01",to:"2026-10-31"}},{rebuild:false});
  assert.equal(app.state.cashFlowMonthSelection,null);
  clickMonth("2026-09");app.setRange("all");
  assert.equal(app.state.cashFlowMonthSelection,null);
});

test("a selection outside refreshed report data clears before totals and Sankey are rendered",()=>{
  const {app,element,clickMonth}=client();
  clickMonth("2026-09");
  app.state.transactions=app.state.transactions.filter(row=>!row.date.startsWith("2026-09"));
  app.state.summary={totals:{income:4900,expense:1000,net:3900},
    months:app.state.summary.months.filter(month=>month.month!=="2026-09")};
  app.renderCashFlow();
  assert.equal(app.state.cashFlowMonthSelection,null);
  assert.equal(element("#cashflowIncome").textContent,"$4,900.00");
  assert.equal(element("#cashflowNet").textContent,"$3,900.00");
  assert.match(element("#cashflowSankey").innerHTML,/Available cash · \$4,900.00/);
  assert.equal(element("#cashflowMonthDetails").hidden,true);
  assert.equal(app.barData().length,3);
});
