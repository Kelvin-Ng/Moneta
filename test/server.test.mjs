import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port=4199;
const plaidPort=4200;
const temp=mkdtempSync(join(tmpdir(),"moneta-test-"));
let server, plaidServer;
let plaidSyncDelay=0;
let plaidTransactionStatuses=[];
test.before(async()=>{
  plaidServer=createServer(async(req,res)=>{
    let raw="";for await(const chunk of req)raw+=chunk;
    const payload=raw?JSON.parse(raw):{};
    if(req.url==="/transactions/sync"&&plaidSyncDelay)await new Promise(resolve=>setTimeout(resolve,plaidSyncDelay));
    if(req.url.startsWith("/v8/finance/chart/")){
      const today=new Date(),yesterday=new Date(today);yesterday.setUTCDate(today.getUTCDate()-1);
      res.writeHead(200,{"content-type":"application/json"});
      return res.end(JSON.stringify({chart:{result:[{
        timestamp:[Math.floor(yesterday.getTime()/1000),Math.floor(today.getTime()/1000)],
        indicators:{quote:[{close:[200,250]}]},meta:{exchangeTimezoneName:"America/New_York"}
      }],error:null}}));
    }
    const today=new Date(),yesterday=new Date(today);yesterday.setUTCDate(today.getUTCDate()-1);
    const investmentSecurity={security_id:"security-test",ticker_symbol:"TEST",name:"Test Equity",type:"equity",subtype:"common stock",is_cash_equivalent:false,close_price:250,close_price_as_of:today.toISOString().slice(0,10),iso_currency_code:"USD"};
    const replies={
      "/link/token/create":{link_token:"link-sandbox-test",expiration:"2030-01-01T00:00:00Z"},
      "/item/public_token/exchange":payload.public_token==="public-investment-test"
        ? {access_token:"access-investment-test",item_id:"item-investment-test"}
        : {access_token:"access-sandbox-test",item_id:"item-test"},
      "/accounts/get":{accounts:payload.access_token==="access-investment-test"?[
        {account_id:"investment-test",name:"Fidelity Brokerage",official_name:"Brokerage",type:"investment",subtype:"brokerage",balances:{current:25000,available:null}}
      ]:[
        {account_id:"checking-test",name:"Plaid Checking",official_name:"Test Checking",type:"depository",subtype:"checking",balances:{current:1250,available:1200}},
        {account_id:"credit-test",name:"Plaid Credit Card",official_name:"Test Visa",type:"credit",subtype:"credit card",balances:{current:325,available:4675}}
      ]},
      "/investments/holdings/get":payload.access_token==="access-investment-test"?{
        holdings:[{account_id:"investment-test",security_id:"security-test",quantity:100,institution_price:250,institution_price_as_of:today.toISOString().slice(0,10),institution_value:25000,cost_basis:18000}],
        securities:[investmentSecurity]
      }:{holdings:[],securities:[]},
      "/investments/transactions/get":payload.access_token==="access-investment-test"?{
        investment_transactions:[{investment_transaction_id:"investment-tx-test",account_id:"investment-test",security_id:"security-test",date:yesterday.toISOString().slice(0,10),name:"Buy Test Equity",quantity:4,amount:1000,price:250,fees:0,type:"buy",subtype:"buy",iso_currency_code:"USD"}],
        securities:[investmentSecurity],total_investment_transactions:1
      }:{investment_transactions:[],securities:[],total_investment_transactions:0},
      "/transactions/sync":payload.cursor
        ? {added:[],modified:[],removed:[],next_cursor:"cursor-1",has_more:false}
        : {added:[
          {transaction_id:"tx-out",account_id:"checking-test",date:"2026-07-07",name:"Corner Market",merchant_name:"Corner Market",amount:42.5,pending:false,personal_finance_category:{primary:"FOOD_AND_DRINK",detailed:"FOOD_AND_DRINK_GROCERIES"}},
          {transaction_id:"tx-in",account_id:"checking-test",date:"2026-07-06",name:"Payroll",merchant_name:"Acme Payroll",amount:-2000,pending:false,personal_finance_category:{primary:"INCOME",detailed:"INCOME_WAGES"}}
        ],modified:[],removed:[],next_cursor:"cursor-1",has_more:false}
    };
    const reply=replies[req.url];
    if(reply&&req.url==="/transactions/sync"&&plaidTransactionStatuses.length)
      reply.transactions_update_status=plaidTransactionStatuses.shift();
    res.writeHead(reply?200:404,{"content-type":"application/json"});
    res.end(JSON.stringify(reply||{error_message:"Not found"}));
  });
  await new Promise(resolve=>plaidServer.listen(plaidPort,"127.0.0.1",resolve));
  server=spawn(process.execPath,["server.mjs"],{env:{
    ...process.env,PORT:String(port),FINANCE_DB_PATH:join(temp,"test.db"),
    PLAID_CLIENT_ID:"test-client",PLAID_SECRET:"test-secret",
    PLAID_BASE_URL:`http://127.0.0.1:${plaidPort}`,
    PLAID_SYNC_RETRY_MS:"10",
    MARKET_DATA_BASE_URL:`http://127.0.0.1:${plaidPort}/v8/finance/chart`
  },stdio:["ignore","ignore","inherit"]});
  for(let i=0;i<30;i++){try{await fetch(`http://localhost:${port}/api/bootstrap`);return}catch{await new Promise(r=>setTimeout(r,50))}}
  throw new Error("Server did not start");
});
test.after(async()=>{
  server?.kill();
  await new Promise(resolve=>plaidServer?.close(resolve));
  rmSync(temp,{recursive:true,force:true});
});

test("a fresh database is empty until demo data is explicitly generated",async()=>{
  const empty=await (await fetch(`http://localhost:${port}/api/bootstrap`)).json();
  assert.equal(empty.accounts.length,0);
  assert.equal(empty.transactions.length,0);

  const settings=await (await fetch(`http://localhost:${port}/api/settings`)).json();
  assert.equal(settings.plaid.client_id,"test-client");
  assert.equal(settings.plaid.secret_configured,true);
  const saved=await fetch(`http://localhost:${port}/api/settings/plaid`,{
    method:"PUT",headers:{"content-type":"application/json"},
    body:JSON.stringify({client_id:"saved-client",secret:"saved-secret",environment:"sandbox",redirect_uri:"http://localhost:4199/"})
  });
  assert.equal(saved.status,200);
  assert.equal((await saved.json()).plaid.client_id,"saved-client");

  const generated=await fetch(`http://localhost:${port}/api/settings/demo-data`,{method:"POST"});
  assert.equal(generated.status,201);
  assert.deepEqual(Object.fromEntries(Object.entries(await generated.json()).filter(([key])=>["accounts_added","transactions_added"].includes(key))),{accounts_added:4,transactions_added:25});
  const repeated=await (await fetch(`http://localhost:${port}/api/settings/demo-data`,{method:"POST"})).json();
  assert.equal(repeated.accounts_added,0);
  assert.equal(repeated.transactions_added,0);

  const res=await fetch(`http://localhost:${port}/api/bootstrap?kinds=income,expense,investment`);
  assert.equal(res.status,200);
  const data=await res.json();
  assert.ok(data.accounts.length>=4);
  assert.ok(data.transactions.length>10);
  assert.ok(data.summary.totals.income>0);
  assert.ok(data.summary.totals.expense>0);
  assert.equal(data.transactions.some(t=>t.kind==="transfer"),false);
  assert.ok(data.category_groups.find(group=>group.name==="Income").categories.includes("Dividends & Capital Gains"));
  assert.ok(data.category_groups.find(group=>group.name==="Food & Dining").categories.includes("Groceries"));
  assert.equal(data.transactions.find(transaction=>transaction.category==="Groceries")?.category_group,"Food & Dining");
  assert.equal(data.summary.categories.find(category=>category.name==="Groceries")?.group,"Food & Dining");
});

test("transfer matching endpoint is safe to run repeatedly",async()=>{
  const one=await fetch(`http://localhost:${port}/api/detect-transfers`,{method:"POST"});
  const two=await fetch(`http://localhost:${port}/api/detect-transfers`,{method:"POST"});
  assert.equal(one.status,200);assert.equal(two.status,200);
  assert.equal((await two.json()).matched,0);
});

test("static app is served",async()=>{
  const res=await fetch(`http://localhost:${port}/`);
  assert.equal(res.status,200);
  const html=await res.text();
  assert.match(html,/Personal finance, made clear/);
  assert.match(html,/Cash flow/);
  assert.match(html,/cashflowSankey/);
  assert.match(html,/sankeyDetailsRows/);
  assert.match(html,/categorySelect/);
  assert.match(html,/plaidSettingsForm/);
  assert.match(html,/generateDemoBtn/);
});

test("client routes support direct visits and refreshes",async()=>{
  for(const path of ["/overview","/cash-flow","/net-worth","/transactions","/accounts","/insights","/settings","/views/123"]){
    const res=await fetch(`http://localhost:${port}${path}`);
    assert.equal(res.status,200,path);
    assert.match(await res.text(),/Personal finance, made clear/,path);
  }
});

test("daily net worth history can be filtered to an account",async()=>{
  const unfiltered=await fetch(`http://localhost:${port}/api/net-worth`);
  assert.equal(unfiltered.status,200);
  assert.ok((await unfiltered.json()).accounts.length>0);
  const accountRes=await fetch(`http://localhost:${port}/api/accounts`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({institution:"History Test",name:"Only Account",type:"cash",balance:100})
  });
  const accountId=(await accountRes.json()).id;
  const today=new Date(),yesterday=new Date(today);yesterday.setUTCDate(today.getUTCDate()-1);
  const date=value=>value.toISOString().slice(0,10);
  const tx=await fetch(`http://localhost:${port}/api/transactions`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({account_id:accountId,date:date(today),merchant:"Daily expense",amount:10,kind:"expense",category:"Miscellaneous"})
  });
  assert.equal(tx.status,201);
  const res=await fetch(`http://localhost:${port}/api/net-worth?from=${date(yesterday)}&to=${date(today)}&accounts=${accountId}`);
  assert.equal(res.status,200);
  const history=await res.json();
  assert.equal(history.accounts.length,1);
  assert.equal(history.latest,100);
  assert.equal(history.history.length,2);
  assert.equal(history.history[0].value,110);
  assert.equal(history.history[1].value,100);
  assert.equal(history.change,-10);
  await fetch(`http://localhost:${port}/api/accounts/${accountId}`,{method:"DELETE"});
});

test("report views persist configuration without calculated values",async()=>{
  const configuration={version:1,filters:{range:"custom",from:"2026-06-01",to:"2026-06-30",kinds:["income","expense"],accounts:[1],categories:["Groceries"],search:"market"}};
  const create=await fetch(`http://localhost:${port}/api/views`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({name:"June essentials",configuration})
  });
  assert.equal(create.status,201);
  const view=await create.json();
  assert.equal(view.name,"June essentials");
  assert.deepEqual(view.configuration,configuration);
  assert.equal("summary" in view,false);

  const fetched=await fetch(`http://localhost:${port}/api/views/${view.id}`);
  assert.equal(fetched.status,200);
  assert.deepEqual((await fetched.json()).configuration,configuration);
  const bootstrap=await (await fetch(`http://localhost:${port}/api/bootstrap`)).json();
  assert.ok(bootstrap.views.some(item=>item.id===view.id));

  const removed=await fetch(`http://localhost:${port}/api/views/${view.id}`,{method:"DELETE"});
  assert.equal(removed.status,200);
  assert.equal((await fetch(`http://localhost:${port}/api/views/${view.id}`)).status,404);
});

test("accounts can be removed along with their local transactions",async()=>{
  const accountRes=await fetch(`http://localhost:${port}/api/accounts`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({institution:"Test Cash",name:"Pocket",type:"cash",balance:100})
  });
  assert.equal(accountRes.status,201);
  const accountId=(await accountRes.json()).id;
  const txRes=await fetch(`http://localhost:${port}/api/transactions`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({account_id:accountId,date:"2026-07-08",merchant:"Test Expense",amount:12,kind:"expense",category:"Miscellaneous"})
  });
  assert.equal(txRes.status,201);
  const txId=(await txRes.json()).id;

  const removed=await fetch(`http://localhost:${port}/api/accounts/${accountId}`,{method:"DELETE"});
  assert.equal(removed.status,200);
  assert.equal((await removed.json()).transactions_deleted,1);
  const data=await (await fetch(`http://localhost:${port}/api/bootstrap?kinds=income,expense,investment,transfer`)).json();
  assert.equal(data.accounts.some(account=>account.id===accountId),false);
  assert.equal(data.transactions.some(tx=>tx.id===txId),false);
});

test("investment-only Plaid items sync successfully without a Transactions cursor",async()=>{
  const exchange=await fetch(`http://localhost:${port}/api/plaid/exchange`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({public_token:"public-investment-test",institution:{institution_id:"ins_fidelity",name:"Fidelity"}})
  });
  assert.equal(exchange.status,201);
  const result=await exchange.json();
  assert.equal(result.accounts,1);
  assert.equal(result.sync.investments,1);

  const status=await (await fetch(`http://localhost:${port}/api/plaid/status`)).json();
  const item=status.items.find(row=>row.id===result.item_id);
  assert.equal(item.status,"connected");
  assert.equal(item.error_code,null);
  const bootstrap=await (await fetch(`http://localhost:${port}/api/bootstrap`)).json();
  assert.ok(bootstrap.accounts.some(account=>account.external_account_id==="investment-test"));
  const today=new Date(),yesterday=new Date(today);yesterday.setUTCDate(today.getUTCDate()-1);
  const history=await (await fetch(`http://localhost:${port}/api/net-worth?from=${yesterday.toISOString().slice(0,10)}&to=${today.toISOString().slice(0,10)}&accounts=${bootstrap.accounts.find(account=>account.external_account_id==="investment-test").id}`)).json();
  assert.equal(history.history[0].value,20000);
  assert.equal(history.history.at(-1).value,25000);
  assert.equal(history.reconstruction.accounts[0].extended,true);
  const cached=await (await fetch(`http://localhost:${port}/api/net-worth?from=${yesterday.toISOString().slice(0,10)}&to=${today.toISOString().slice(0,10)}&accounts=${bootstrap.accounts.find(account=>account.external_account_id==="investment-test").id}`)).json();
  assert.equal(cached.history[0].value,20000);
  assert.equal(cached.reconstruction.accounts[0].extended,false);
});

test("Plaid Link token, exchange, account persistence, and transaction sync work",async()=>{
  const tokenRes=await fetch(`http://localhost:${port}/api/plaid/link-token`,{method:"POST"});
  assert.equal(tokenRes.status,200);
  assert.equal((await tokenRes.json()).link_token,"link-sandbox-test");

  plaidSyncDelay=120;
  plaidTransactionStatuses=["NOT_READY","HISTORICAL_UPDATE_COMPLETE"];
  const exchange=await fetch(`http://localhost:${port}/api/plaid/exchange`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({public_token:"public-sandbox-test",institution:{institution_id:"ins_test",name:"Plaid Test Bank"},background:true})
  });
  assert.equal(exchange.status,202);
  const result=await exchange.json();
  assert.equal(result.accounts,2);
  assert.equal(result.sync.pending,true);

  const inProgress=await (await fetch(`http://localhost:${port}/api/bootstrap?from=2026-07-01&to=2026-07-31&kinds=income,expense`)).json();
  assert.equal(inProgress.accounts.find(account=>account.external_account_id==="checking-test").plaid_status,"syncing");
  let data;
  for(let attempt=0;attempt<20;attempt++){
    await new Promise(resolve=>setTimeout(resolve,25));
    data=await (await fetch(`http://localhost:${port}/api/bootstrap?from=2026-07-01&to=2026-07-31&kinds=income,expense`)).json();
    if(data.accounts.find(account=>account.external_account_id==="checking-test")?.plaid_status==="connected")break;
  }
  plaidSyncDelay=0;
  const checking=data.accounts.find(account=>account.external_account_id==="checking-test");
  const credit=data.accounts.find(account=>account.external_account_id==="credit-test");
  assert.equal(checking.balance,1250);
  assert.equal(credit.balance,-325);
  assert.equal(data.transactions.find(tx=>tx.external_id==="plaid:tx-out").amount,-42.5);
  assert.equal(data.transactions.find(tx=>tx.external_id==="plaid:tx-in").amount,2000);

  plaidSyncDelay=120;
  const sync=await fetch(`http://localhost:${port}/api/plaid/sync`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({item_id:result.item_id,background:true})
  });
  assert.equal(sync.status,202);
  assert.equal((await sync.json()).results[0].pending,true);
  const refreshing=await (await fetch(`http://localhost:${port}/api/bootstrap`)).json();
  assert.equal(refreshing.accounts.find(account=>account.external_account_id==="checking-test").plaid_status,"syncing");
  for(let attempt=0;attempt<20;attempt++){
    await new Promise(resolve=>setTimeout(resolve,25));
    const status=await (await fetch(`http://localhost:${port}/api/plaid/status`)).json();
    if(status.items.find(item=>item.id===result.item_id)?.status==="connected")break;
  }
  plaidSyncDelay=0;

  const deleteChecking=await fetch(`http://localhost:${port}/api/accounts/${checking.id}`,{method:"DELETE"});
  assert.equal(deleteChecking.status,200);
  assert.equal((await deleteChecking.json()).transactions_deleted,2);

  const syncAfterDelete=await fetch(`http://localhost:${port}/api/plaid/sync`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({item_id:result.item_id})
  });
  assert.equal(syncAfterDelete.status,200);
  const afterDelete=await (await fetch(`http://localhost:${port}/api/bootstrap?from=2026-07-01&to=2026-07-31&kinds=income,expense`)).json();
  assert.equal(afterDelete.accounts.some(account=>account.external_account_id==="checking-test"),false);
  assert.equal(afterDelete.accounts.some(account=>account.external_account_id==="credit-test"),true);
  assert.equal(afterDelete.transactions.some(tx=>tx.external_id==="plaid:tx-out"),false);
  assert.equal(afterDelete.transactions.some(tx=>tx.external_id==="plaid:tx-in"),false);
});
