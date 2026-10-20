import test from "node:test";
import assert from "node:assert/strict";
import { bankCashFlowReport, normalizeCashFlowConfiguration } from "../lib/bank-cash-flow.mjs";

const accounts=[{id:1,name:"Checking",institution:"Test Bank"},{id:2,name:"Savings",institution:"Test Bank"}];
const row=(id,account_id,amount,category="Transfer",date="2026-09-10",extra={})=>({id,account_id,amount,category,date,merchant:`Entry ${id}`,pending:0,transfer_pair_id:null,...extra});

test("bank cash flow counts posted bank movements, not card purchases or retirement contributions",()=>{
  const rows=[
    row(1,1,5000,"Paychecks"),row(2,1,-1000,"Credit Card Payment"),
    row(3,3,-1000,"Groceries","2026-08-01"), // Credit card, outside endpoint boundary.
    row(4,1,50,"Groceries"),row(5,1,-2000,"Rent"),
    row(6,1,-500),row(7,4,500), // Investment funding crosses the boundary.
    row(8,4,1000,"Transfer","2026-09-10",{investment_subtype:"contribution"}),
    row(9,1,-300,"Transfer","2026-09-10",{transfer_pair_id:10}),
    row(10,2,300,"Transfer","2026-09-11",{transfer_pair_id:9}),
    row(11,1,-999,"Rent","2026-09-10",{pending:1}),row(12,1,0)
  ];
  const snapshot=structuredClone(rows),report=bankCashFlowReport(rows,accounts);
  assert.deepEqual(report.summary.totals,{income:5050,expense:3500,net:1550});
  assert.deepEqual(report.summary.months,[{month:"2026-09",income:5050,expense:3500}]);
  assert.deepEqual(report.transactions.map(row=>row.id),[1,2,4,5,6]);
  assert.deepEqual(report.internal_transfers.map(row=>row.id),[9,10]);
  assert.equal(report.pending_count,1);
  assert.equal(report.unmatched_transfer_count,1);
  assert.equal(report.transactions.find(row=>row.id===2).category,"Credit Card Payment");
  assert.equal(report.transactions.find(row=>row.id===2).endpoint_name,"Checking");
  assert.deepEqual(rows,snapshot);
});

test("internal-transfer context survives month, category, and search filters; endpoint selection changes the boundary",()=>{
  const rows=[
    row(1,1,-300,"Transfer","2026-09-30",{transfer_pair_id:2,merchant:"Move to savings"}),
    row(2,2,300,"Transfer","2026-10-01",{transfer_pair_id:1,merchant:"Savings deposit"}),
    row(3,1,-100,"Credit Card Payment","2026-09-20")
  ];
  const filters={from:"2026-09-01",to:"2026-09-30",categories:["Transfer"],search:"Move to savings"};
  const consolidated=bankCashFlowReport(rows,accounts,filters);
  assert.deepEqual(consolidated.summary.totals,{income:0,expense:0,net:0});
  assert.deepEqual(consolidated.internal_transfers.map(row=>row.id),[1]);
  const checking=bankCashFlowReport(rows,[accounts[0]],filters);
  assert.deepEqual(checking.summary.totals,{income:0,expense:300,net:-300});
  assert.equal(checking.internal_transfers.length,0);
  assert.equal(checking.transactions.length,1);
});

test("stale or ambiguous links never silently hide bank cash movements",()=>{
  const cases=[
    [row(1,1,-100,"Transfer","2026-09-10",{transfer_pair_id:2}),row(2,2,100)],
    [row(1,1,-100,"Transfer","2026-09-10",{transfer_pair_id:2}),row(2,2,-100,"Transfer","2026-09-10",{transfer_pair_id:1})],
    [row(1,1,-100,"Transfer","2026-09-10",{transfer_pair_id:2}),row(2,2,99,"Transfer","2026-09-10",{transfer_pair_id:1})],
    [row(1,1,-100,"Transfer","2026-09-10",{transfer_pair_id:2}),row(2,2,100,"Transfer","2026-09-20",{transfer_pair_id:1})],
    [row(1,1,-100,"Credit Card Payment","2026-09-10",{transfer_pair_id:2}),row(2,2,100,"Credit Card Payment","2026-09-10",{transfer_pair_id:1})],
    [row(1,1,-100,"Transfer","2026-09-10",{transfer_pair_id:2}),row(2,1,100,"Transfer","2026-09-10",{transfer_pair_id:1})],
    [row(1,1,-100,"Transfer","2026-09-10",{transfer_pair_id:2}),row(2,2,100,"Transfer","2026-09-10",{transfer_pair_id:1,pending:1})]
  ];
  for(const rows of cases){
    const report=bankCashFlowReport(rows,accounts);
    assert.equal(report.internal_transfers.length,0);
    assert.ok(report.transactions.some(row=>row.id===1));
  }
});

test("duplicate endpoint names are disambiguated and empty selections have no cash flow",()=>{
  const duplicateAccounts=accounts.map(account=>({...account,name:"Checking"}));
  const rows=[row(1,1,-100,"Credit Card Payment"),row(2,2,-200,"Credit Card Payment")];
  const report=bankCashFlowReport(rows,duplicateAccounts);
  assert.notEqual(report.transactions[0].endpoint_name,report.transactions[1].endpoint_name);
  assert.deepEqual(bankCashFlowReport(rows,[]).transactions,[]);
  assert.deepEqual(normalizeCashFlowConfiguration(null),{mode:"transactions",endpoint_account_ids:[]});
  assert.deepEqual(normalizeCashFlowConfiguration({mode:"bank-endpoints",endpoint_account_ids:[1,1,"2",-1]}),{mode:"bank-endpoints",endpoint_account_ids:[1,2]});
});

test("bank plus Robinhood treats funding as internal and does not count investment trades as cash flow",()=>{
  const endpoints=[{...accounts[0],type:"checking"},{id:3,name:"Robinhood",institution:"Broker",type:"investment"}];
  const rows=[
    row(1,1,5000,"Paychecks"),
    row(2,1,-4000,"Transfer","2026-09-10",{transfer_pair_id:3}),
    row(3,3,4000,"Transfer","2026-09-11",{transfer_pair_id:2,investment_action:"transfer"}),
    row(4,3,-3500,"Buy","2026-09-12",{investment_action:"buy"}),
    row(5,3,300,"Sell","2026-09-15",{investment_action:"sell"}),
    row(6,3,20,"Dividends & Capital Gains","2026-09-20",{investment_action:"cash",investment_subtype:"dividend"}),
    row(7,3,-5,"Financial Fees","2026-09-21",{investment_action:"fee"})
  ];
  const snapshot=structuredClone(rows),report=bankCashFlowReport(rows,endpoints);
  assert.deepEqual(report.summary.totals,{income:5020,expense:5,net:5015});
  assert.deepEqual(report.internal_transfers.map(row=>row.id),[2,3]);
  assert.deepEqual(report.investment_activity.map(row=>row.id),[4,5]);
  assert.deepEqual(report.transactions.map(row=>row.id),[1,6,7]);
  assert.equal(bankCashFlowReport(rows,[endpoints[0]]).summary.totals.expense,4000);
  assert.deepEqual(rows,snapshot);
});

test("investment source metadata, CSV category fallback, and embedded fees are handled without losing real expenses",()=>{
  const endpoints=[{id:3,name:"Robinhood",institution:"Broker",type:"investment"}];
  const rows=[
    row(1,3,-1001,"Personal","2026-09-10",{investment_action:"buy",investment_fees:1}),
    row(2,3,499,"Sell","2026-09-10",{investment_action:"sell",investment_fees:1}),
    row(3,3,-200,"Buy"), // Older imported trade without investment-action metadata.
    row(4,3,300,"Sell"),
    row(5,3,-10,"Financial Fees","2026-09-10",{investment_action:"fee"}),
    row(6,3,50,"Dividends & Capital Gains"),
    row(7,3,-999,"Buy","2026-09-10",{pending:1})
  ];
  const report=bankCashFlowReport(rows,endpoints);
  assert.deepEqual(report.summary.totals,{income:50,expense:12,net:38});
  assert.equal(report.investment_activity.length,4);
  assert.equal(report.pending_count,1);
  assert.deepEqual(report.transactions.filter(row=>row.report_component==="trade_fee").map(row=>row.amount),[-1,-1]);
  const fees=bankCashFlowReport(rows,endpoints,{categories:["Financial Fees"]});
  assert.equal(fees.summary.totals.expense,12);
  assert.equal(fees.transactions.length,3);
  assert.equal(fees.investment_activity.length,0);
});

test("including a credit card makes matched payments internal but keeps actual card purchases",()=>{
  const endpoints=[{...accounts[0],type:"checking"},{id:3,name:"Card",institution:"Issuer",type:"credit"}];
  const rows=[
    row(1,1,-100,"Credit Card Payment","2026-09-10",{transfer_pair_id:2}),
    row(2,3,100,"Credit Card Payment","2026-09-11",{transfer_pair_id:1}),
    row(3,3,-70,"Groceries"),row(4,3,-10,"Financial Fees")
  ];
  const report=bankCashFlowReport(rows,endpoints);
  assert.deepEqual(report.summary.totals,{income:0,expense:80,net:-80});
  assert.equal(report.internal_transfers.length,2);
  assert.deepEqual(report.transactions.map(row=>row.id),[3,4]);
  assert.equal(bankCashFlowReport(rows,[endpoints[0]]).summary.totals.expense,100);
});

test("report exclusions preserve internal-transfer peer context and remove projected trade fees",()=>{
  const endpoints=[{...accounts[0],type:"checking"},{id:3,name:"Broker",institution:"Broker",type:"investment"}];
  const rows=[
    row(1,1,-1000,"Transfer","2026-09-10",{merchant:"Exclude this leg",transfer_pair_id:2}),
    row(2,3,1000,"Transfer","2026-09-11",{transfer_pair_id:1}),
    row(3,3,-902,"Buy","2026-09-12",{merchant:"Excluded trade",investment_action:"buy",investment_fees:2}),
    row(4,1,-10,"Groceries","2026-09-12",{merchant:"Visible purchase"})
  ];
  const exclusions=[{name:"One transfer leg",conditions:[{field:"description",operator:"contains",value:"this leg"}]},
    {name:"Trade and fee",conditions:[{field:"description",operator:"eq",value:"Excluded trade"}]}];
  const snapshot=structuredClone(rows),report=bankCashFlowReport(rows,endpoints,{exclusions});
  assert.deepEqual(report.summary.totals,{income:0,expense:10,net:-10});
  assert.deepEqual(report.excluded_transactions.map(row=>row.id),[1,3]);
  assert.deepEqual(report.internal_transfers.map(row=>row.id),[2]);
  assert.equal(report.investment_activity.length,0);
  assert.deepEqual(report.transactions.map(row=>row.id),[4]);
  assert.deepEqual(report.excluded_transactions[0].excluded_by,["One transfer leg"]);
  assert.equal(bankCashFlowReport(rows,endpoints,{exclusions,categories:["Financial Fees"]}).excluded_transactions[0].id,3);
  assert.deepEqual(rows,snapshot);
});
