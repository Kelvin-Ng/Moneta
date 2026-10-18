import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

// Run the real client functions with a small DOM adapter, without fetching any
// financial data or starting the application initialization/network lifecycle.
function client() {
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
    fetch(){throw new Error("Month selection must not fetch or change the underlying report data");}
  });
  const source=readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
  const initialization=source.lastIndexOf("initialize().catch(");
  assert.ok(initialization>0);
  runInContext(source.slice(0,initialization)+`
    globalThis.app={state,bind,renderCashFlow,selectCashFlowMonth,selectSankeyNode,
      cashFlowTransactions,cashFlowData,showCashFlowBarTooltip,setRange,
      currentReportConfiguration,applyReportConfiguration,reportSettingsSummary,queryString,
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
