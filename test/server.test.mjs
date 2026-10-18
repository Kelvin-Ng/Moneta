import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decode as decodeToon } from "@toon-format/toon";

const port=4199;
const plaidPort=4200;
const temp=mkdtempSync(join(tmpdir(),"moneta-test-"));
let server, plaidServer;
let plaidSyncDelay=0;
let plaidTransactionStatuses=[];
let plaidInvestmentRefreshes=0;
let plaidLinkTokenRequests=[];
let aiRequests=[];
let aiResponseMode="";
let aiResponseDelay=0;
test.before(async()=>{
  plaidServer=createServer(async(req,res)=>{
    let raw="";for await(const chunk of req)raw+=chunk;
    const payload=raw?JSON.parse(raw):{};
    if(req.url==="/link/token/create")plaidLinkTokenRequests.push(payload);
    if(req.url==="/transactions/sync"&&plaidSyncDelay)await new Promise(resolve=>setTimeout(resolve,plaidSyncDelay));
    if(req.url==="/v1/chat/completions"||req.url==="/v1/responses"||req.url==="/v1/messages"||req.url.startsWith("/v1beta/models/")){
      aiRequests.push({url:req.url,payload,headers:req.headers});
      if(req.url==="/v1/messages"&&payload.output_config?.format?.type!=="json_schema"){
        res.writeHead(400,{"content-type":"application/json"});
        return res.end(JSON.stringify({error:{message:"Anthropic structured output is required"}}));
      }
      if(req.url==="/v1/messages"&&payload.output_config.format.schema.properties.transactions?.minItems>1){
        res.writeHead(400,{"content-type":"application/json"});
        return res.end(JSON.stringify({error:{message:"Anthropic only supports minItems values of 0 or 1"}}));
      }
      const inputText=req.url==="/v1/responses"?payload.input
        :req.url.startsWith("/v1beta/models/")?payload.contents.at(-1).parts.at(-1).text
        :payload.messages.at(-1).content;
      const input=decodeToon(inputText);
      if(aiResponseDelay)await new Promise(resolve=>setTimeout(resolve,aiResponseDelay));
      if(aiResponseMode==="server-error"){
        res.writeHead(500,{"content-type":"application/json"});
        return res.end(JSON.stringify({error:{message:"Simulated provider outage"}}));
      }
      if(aiResponseMode==="schema-complex-over-two"&&req.url==="/v1/messages"&&input.transactions.length>2){
        res.writeHead(400,{"content-type":"application/json"});
        return res.end(JSON.stringify({error:{message:"Schema is too complex for compilation"}}));
      }
      if(aiResponseMode==="truncate-over-two"&&req.url==="/v1/messages"&&input.transactions.length>2){
        res.writeHead(200,{"content-type":"application/json"});
        return res.end(JSON.stringify({stop_reason:"max_tokens",content:[{type:"text",text:'{"transactions":[]}'}]}));
      }
      let transactions=input.transactions.map(transaction=>({
        id:transaction.id,
        category:/salary|paycheck/i.test(`${transaction.description} ${transaction.merchant||""}`)?"Paychecks":/dinner|lunch/i.test(`${transaction.description} ${transaction.memo||""}`)?"Restaurants & Bars":"Miscellaneous"
      }));
      if(aiResponseMode==="omit-over-two"&&transactions.length>2)transactions=transactions.slice(0,-1);
      res.writeHead(200,{"content-type":"application/json"});
      const text=req.url==="/v1/messages"
        ? JSON.stringify(Object.fromEntries(transactions.map(transaction=>[String(transaction.id),transaction.category])))
        : JSON.stringify({transactions});
      if(req.url==="/v1/responses")return res.end(JSON.stringify({output_text:text}));
      if(req.url==="/v1/messages")return res.end(JSON.stringify({stop_reason:"end_turn",content:[{type:"text",text}]}));
      if(req.url.startsWith("/v1beta/models/"))return res.end(JSON.stringify({candidates:[{content:{parts:[{text}]}}]}));
      return res.end(JSON.stringify({choices:[{message:{content:text}}]}));
    }
    if(req.url.startsWith("/v8/finance/chart/")){
      const today=new Date(),twoDaysAgo=new Date(today);twoDaysAgo.setUTCDate(today.getUTCDate()-2);
      res.writeHead(200,{"content-type":"application/json"});
      return res.end(JSON.stringify({chart:{result:[{
        timestamp:[Math.floor(twoDaysAgo.getTime()/1000),Math.floor(today.getTime()/1000)],
        indicators:{quote:[{close:[200,250]}]},meta:{exchangeTimezoneName:"America/New_York"}
      }],error:null}}));
    }
    if(req.url==="/investments/refresh"){
      plaidInvestmentRefreshes++;
      res.writeHead(200,{"content-type":"application/json"});
      return res.end(JSON.stringify({request_id:`investment-refresh-${plaidInvestmentRefreshes}`}));
    }
    const today=new Date(),yesterday=new Date(today);yesterday.setUTCDate(today.getUTCDate()-1);
    const refreshedInvestmentPrice=250+plaidInvestmentRefreshes*10;
    const investmentSecurity={security_id:"security-test",ticker_symbol:"TEST",name:"Test Equity",type:"equity",subtype:"common stock",is_cash_equivalent:false,close_price:refreshedInvestmentPrice,close_price_as_of:today.toISOString().slice(0,10),iso_currency_code:"USD"};
    const replies={
      "/link/token/create":{link_token:"link-sandbox-test",expiration:"2030-01-01T00:00:00Z"},
      "/item/public_token/exchange":payload.public_token==="public-investment-test"
        ? {access_token:"access-investment-test",item_id:"item-investment-test"}
        : {access_token:"access-sandbox-test",item_id:"item-test"},
      "/accounts/get":{accounts:payload.access_token==="access-investment-test"?[
        {account_id:"investment-test",name:"Fidelity Brokerage",official_name:"Brokerage",type:"investment",subtype:"brokerage",balances:{current:refreshedInvestmentPrice*100,available:null}}
      ]:[
        {account_id:"checking-test",name:"Plaid Checking",official_name:"Test Checking",type:"depository",subtype:"checking",balances:{current:1250,available:1200}},
        {account_id:"credit-test",name:"Plaid Credit Card",official_name:"Test Visa",type:"credit",subtype:"credit card",balances:{current:325,available:4675}}
      ]},
      "/investments/holdings/get":payload.access_token==="access-investment-test"?{
        holdings:[{account_id:"investment-test",security_id:"security-test",quantity:100,institution_price:refreshedInvestmentPrice,institution_price_as_of:today.toISOString().slice(0,10),institution_value:refreshedInvestmentPrice*100,cost_basis:18000}],
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

  const res=await fetch(`http://localhost:${port}/api/bootstrap`);
  assert.equal(res.status,200);
  const data=await res.json();
  assert.ok(data.accounts.length>=4);
  assert.ok(data.transactions.length>10);
  assert.ok(data.summary.totals.income>0);
  assert.ok(data.summary.totals.expense>0);
  assert.equal(data.transactions.some(transaction=>Object.hasOwn(transaction,"kind")),false);
  assert.ok(data.transactions.some(transaction=>transaction.category_group==="Transfers"));
  assert.ok(data.category_groups.find(group=>group.name==="Income").categories.includes("Dividends & Capital Gains"));
  assert.ok(data.category_groups.find(group=>group.name==="Food & Dining").categories.includes("Groceries"));
  assert.equal(data.transactions.find(transaction=>transaction.category==="Groceries")?.category_group,"Food & Dining");
  assert.equal(data.summary.categories.find(category=>category.name==="Groceries")?.group,"Food & Dining");
  const database=new DatabaseSync(join(temp,"test.db"));
  assert.equal(database.prepare("PRAGMA table_info(transactions)").all().some(column=>column.name==="kind"),false);
  assert.equal(database.prepare("PRAGMA table_info(transactions)").all().some(column=>column.name==="ai_categorization_disabled"),true);
  assert.equal(database.prepare("PRAGMA table_info(accounts)").all().some(column=>column.name==="nickname"),true);
  database.close();
});

test("transfer matching endpoint is safe to run repeatedly",async()=>{
  const one=await fetch(`http://localhost:${port}/api/detect-transfers`,{method:"POST"});
  const two=await fetch(`http://localhost:${port}/api/detect-transfers`,{method:"POST"});
  assert.equal(one.status,200);assert.equal(two.status,200);
  assert.equal((await two.json()).matched,0);
});

test("transfer matching only links transactions and preserves categories, metadata, and report classification",async()=>{
  const database=new DatabaseSync(join(temp,"test.db"));
  const accountIds=[];
  try {
    for(const type of ["checking","credit"]){
      accountIds.push(Number(database.prepare("INSERT INTO accounts(institution,name,type) VALUES(?,?,?)")
        .run("Pairing Test",`${type} account`,type).lastInsertRowid));
    }
    const fixtures=[
      {category:"Credit Card Payment",amount:-11001.23,source:"manual",disabled:1},
      {category:"Transfer",amount:11001.23,source:"fallback",status:"pending"},
      {category:"Buy",amount:-12002.35,source:"ai"},
      {category:"Sell",amount:12002.35,source:"manual",disabled:1},
      {category:"Groceries",amount:-33003.57,source:"manual",disabled:1},
      {category:"Paychecks",amount:33003.57,source:"ai",status:"error",error:"Keep this categorization error"}
    ];
    const ids=fixtures.map((fixture,index)=>Number(database.prepare(`INSERT INTO transactions(
      account_id,date,merchant,category,amount,category_source,categorization_status,
      categorization_error,categorized_at,ai_categorization_disabled,original_details_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(accountIds[index%2],"2026-08-01","Payment matching test",
      fixture.category,fixture.amount,fixture.source,fixture.status||"categorized",fixture.error||null,
      "2026-08-01 12:34:56",fixture.disabled||0,JSON.stringify({source:"test",description:fixture.category})).lastInsertRowid));
    const rows=()=>database.prepare("SELECT * FROM transactions WHERE account_id IN (?,?) ORDER BY id").all(...accountIds);
    const withoutPair=transactions=>transactions.map(({transfer_pair_id,...transaction})=>transaction);
    const original=withoutPair(rows());

    const first=await fetch(`http://localhost:${port}/api/detect-transfers`,{method:"POST"});
    assert.equal(first.status,200);
    assert.equal((await first.json()).matched,3);
    assert.deepEqual(withoutPair(rows()),original);
    assert.deepEqual(rows().map(row=>row.transfer_pair_id),[ids[1],ids[0],ids[3],ids[2],ids[5],ids[4]]);
    const report=await (await fetch(`http://localhost:${port}/api/transactions?accounts=${accountIds.join(",")}`)).json();
    assert.equal(report.summary.totals.income,33003.57);
    assert.equal(report.summary.totals.expense,33003.57);
    assert.equal(report.transactions.find(transaction=>transaction.id===ids[2]).category,"Buy");
    assert.equal(report.transactions.find(transaction=>transaction.id===ids[3]).category,"Sell");

    // A user can change an already-paired transaction without the next match
    // resetting its category or categorization metadata.
    const edited=await fetch(`http://localhost:${port}/api/transactions/${ids[2]}`,{
      method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({category:"Personal"})
    });
    assert.equal(edited.status,200);
    const afterEdit=rows();
    const second=await fetch(`http://localhost:${port}/api/detect-transfers`,{method:"POST"});
    assert.equal(second.status,200);
    assert.equal((await second.json()).matched,0);
    assert.deepEqual(rows(),afterEdit);
    assert.equal(rows().find(transaction=>transaction.id===ids[2]).category,"Personal");
  } finally {
    for(const id of accountIds)await fetch(`http://localhost:${port}/api/accounts/${id}`,{method:"DELETE"});
    database.close();
  }
});

test("category groups classify transactions and positive expenses reduce totals",async()=>{
  const accountResponse=await fetch(`http://localhost:${port}/api/accounts`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({institution:"Classification Test",name:"Signed Amounts",type:"cash",balance:0})
  });
  const accountId=(await accountResponse.json()).id;
  for(const transaction of [
    {merchant:"Groceries",amount:-100,category:"Groceries"},
    {merchant:"Grocery refund",amount:20,category:"Groceries"},
    {merchant:"Paycheck",amount:500,category:"Paychecks"},
    {merchant:"Move money",amount:-50,category:"Transfer"}
  ]){
    const response=await fetch(`http://localhost:${port}/api/transactions`,{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({account_id:accountId,date:"2026-08-01",...transaction})
    });
    assert.equal(response.status,201);
  }
  const data=await (await fetch(`http://localhost:${port}/api/transactions?accounts=${accountId}`)).json();
  assert.equal(data.summary.totals.income,500);
  assert.equal(data.summary.totals.expense,80);
  assert.equal(data.summary.totals.transfer,-50);
  assert.equal(data.summary.totals.net,420);
  assert.equal(data.summary.categories.find(category=>category.name==="Groceries").value,80);
  assert.deepEqual(new Set(data.transactions.map(transaction=>transaction.category_group)),new Set(["Income","Food & Dining","Transfers"]));
  assert.ok(data.transactions.every(transaction=>!Object.hasOwn(transaction,"kind")));
  const protectedResponse=await fetch(`http://localhost:${port}/api/transactions`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({account_id:accountId,date:"2026-08-02",merchant:"Chosen category",amount:-10,category:"Personal",disable_ai_categorization:true})
  });
  const protectedId=(await protectedResponse.json()).id;
  const protectedRun=await fetch(`http://localhost:${port}/api/categorization/run`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({transaction_ids:[protectedId]})
  });
  const protectedResult=await protectedRun.json();
  assert.equal(protectedResult.requested,0);
  const protectedTransaction=(await (await fetch(`http://localhost:${port}/api/transactions?accounts=${accountId}`)).json()).transactions.find(transaction=>transaction.id===protectedId);
  assert.equal(protectedTransaction.category,"Personal");
  assert.equal(protectedTransaction.ai_categorization_disabled,1);
  assert.equal((await (await fetch(`http://localhost:${port}/api/settings`)).json()).ai.protected_count,1);
  await fetch(`http://localhost:${port}/api/accounts/${accountId}`,{method:"DELETE"});
});

test("AI evidence carries confidence and distinguishes card repayments, app funding, and actual payments across providers",async()=>{
  const database=new DatabaseSync(join(temp,"test.db"));
  const accountId=Number(database.prepare("INSERT INTO accounts(institution,name,nickname,type) VALUES(?,?,?,?)")
    .run("Evidence Test","private-account-name","private-account-nickname","checking").lastInsertRowid);
  const originals=[
    {source:"plaid",investment:false,transaction:{name:"Example Card-Pmt Withdrawal DDA_TRANSACTION",
      amount:425.5,account_id:"private-account-id",transaction_id:"private-transaction-id",
      personal_finance_category:{primary:"RENT_AND_UTILITIES",detailed:"RENT_AND_UTILITIES_RENT",confidence_level:"LOW"}}},
    {source:"manual",submitted:{merchant:"Monthly rent via Example BillPay",amount:-2500,category:"Rent"}},
    {source:"plaid",investment:false,transaction:{name:"Venmo",original_description:"Venmo - Payment Withdrawal WITHDRAWAL",
      amount:42.5,personal_finance_category:{primary:"TRANSFER_OUT",detailed:"TRANSFER_OUT_TRANSFER_OUT_FROM_APPS",confidence_level:"HIGH"},
      payment_meta:{reason:null},counterparties:[{name:"Venmo"}]}},
    {source:"plaid",investment:false,transaction:{name:'Example Friend "Dinner"',amount:42.5,
      personal_finance_category:{primary:"TRANSFER_OUT",detailed:"TRANSFER_OUT_TRANSFER_OUT_FROM_APPS",confidence_level:"HIGH"},
      payment_meta:{reason:"Dinner"},counterparties:[{name:"Example Friend"}]}}
  ];
  try {
    const ids=originals.map(original=>Number(database.prepare(`INSERT INTO transactions(
      account_id,date,merchant,category,amount,original_details_json,category_source,categorization_status
    ) VALUES(?,?,?,?,?,?,'fallback','pending')`).run(accountId,"2026-08-15",
      original.transaction?.name||original.submitted.merchant,"Rent",original.transaction?-original.transaction.amount:original.submitted.amount,JSON.stringify(original)).lastInsertRowid));
    for(const adapter of [
      {protocol:"openai-compatible",endpoint:`http://127.0.0.1:${plaidPort}/v1/chat/completions`,model:"mock-chat"},
      {protocol:"openai-responses",endpoint:`http://127.0.0.1:${plaidPort}/v1/responses`,model:"mock-responses"},
      {protocol:"anthropic",endpoint:`http://127.0.0.1:${plaidPort}/v1/messages`,model:"mock-anthropic"},
      {protocol:"gemini",endpoint:`http://127.0.0.1:${plaidPort}/v1beta`,model:"mock-gemini"}
    ]){
      const settings=await fetch(`http://localhost:${port}/api/settings/ai`,{
        method:"PUT",headers:{"content-type":"application/json"},
        body:JSON.stringify({...adapter,api_key:"mock-key",rules:"Respect explicit transaction purposes."})
      });
      assert.equal(settings.status,200);
      aiRequests=[];
      const run=await fetch(`http://localhost:${port}/api/categorization/run`,{
        method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({transaction_ids:ids})
      });
      assert.equal(run.status,200);
      assert.equal((await run.json()).categorized,originals.length);
      assert.equal(aiRequests.length,1);
      const request=aiRequests[0].payload;
      const system=adapter.protocol==="anthropic"?request.system
        :adapter.protocol==="gemini"?request.systemInstruction.parts[0].text
        :adapter.protocol==="openai-responses"?request.instructions:request.messages[0].content;
      const user=adapter.protocol==="openai-responses"?request.input
        :adapter.protocol==="gemini"?request.contents.at(-1).parts.at(-1).text:request.messages.at(-1).content;
      assert.match(system,/LOW, UNKNOWN, or missing confidence/);
      assert.match(system,/Prioritize explicit card-payment wording/);
      assert.match(system,/Card-Pmt/);
      assert.match(system,/Repaying a credit-card balance is Credit Card Payment, not Rent/);
      assert.match(system,/an actual rent payment through a bill-pay service is still Rent/);
      assert.match(system,/Distinguish actual peer-to-peer payments recorded in a payment-app account from the source bank's funding or settlement entries/);
      assert.match(system,/For an actual payment recorded in a Venmo or PayPal account, infer its purpose/);
      assert.match(system,/bank entries that fund or settle activity in the user's payment-app account are Transfer/);
      assert.match(system,/counting both as expenses would double-count spending/);
      assert.match(system,/Venmo-Payment-\.\.\. Withdrawal DDA_TRANSACTION/);
      assert.match(system,/should remain Transfer/);
      assert.match(system,/Do not invent a spending purpose or choose Fun Money/);
      assert.match(system,/The institution field identifies where the transaction's account is held, not the merchant or recipient/);
      assert.match(system,/Relevant user rules override the general categorization guidance and source-category hints/);
      assert.doesNotMatch(system,/Peer-to-peer payments such as Venmo or PayPal are not automatically transfers/);
      const evidence=decodeToon(user).transactions;
      assert.equal(evidence[0].description,originals[0].transaction.name);
      assert.equal(evidence[0].source_category_detail,"RENT_AND_UTILITIES_RENT");
      assert.equal(evidence[0].source_category_confidence,"LOW");
      assert.equal(evidence[1].source_category_confidence,null);
      assert.equal(evidence[2].description,originals[2].transaction.original_description);
      assert.equal(evidence[2].counterparty,"Venmo");
      assert.equal(evidence[2].memo,null);
      assert.equal(evidence[3].memo,"Dinner");
      assert.equal(evidence[3].counterparty,"Example Friend");
      assert.ok(evidence.every(row=>row.institution==="Evidence Test"));
      assert.doesNotMatch(user,/private-account-id|private-transaction-id|private-account-name|private-account-nickname|confidence_level/);
      assert.ok(evidence.every(row=>["original_details","date","account_name","nickname","matching_transaction","related_transactions"].every(field=>!Object.hasOwn(row,field))));
    }

    // The same optional evidence can be mapped from arbitrary CSV headers.
    aiRequests=[];
    const imported=await fetch(`http://localhost:${port}/api/import`,{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
        account_id:accountId,csv:{headers:["When","Details","Value","Source Bucket","Certainty"],
          rows:[["2026-08-16","Synthetic purchase","-12.34","OTHER_OTHER","medium"]]},
        column_mapping:{date:0,description:1,amount:2,category:3,source_category_confidence:4}
      })
    });
    assert.equal(imported.status,200);
    assert.equal((await imported.json()).categorization.categorized,1);
    assert.equal(decodeToon(aiRequests[0].payload.contents.at(-1).parts.at(-1).text).transactions[0].source_category_confidence,"MEDIUM");
    assert.equal(decodeToon(aiRequests[0].payload.contents.at(-1).parts.at(-1).text).transactions[0].institution,"Evidence Test");
    const saved=database.prepare(`SELECT original_details_json FROM transactions WHERE id IN (${ids.map(()=>"?").join(",")}) ORDER BY id`).all(...ids);
    assert.deepEqual(saved.map(row=>JSON.parse(row.original_details_json)),originals);
  } finally {
    await fetch(`http://localhost:${port}/api/accounts/${accountId}`,{method:"DELETE"});
    await fetch(`http://localhost:${port}/api/settings/ai`,{
      method:"PUT",headers:{"content-type":"application/json"},
      body:JSON.stringify({protocol:"openai-compatible",endpoint:"",model:"",rules:"",clear_api_key:true})
    });
    database.close();
  }
});

test("AI account-scoped rules receive the owning institution for Plaid, CSV, and manual transactions",async()=>{
  const database=new DatabaseSync(join(temp,"test.db"));
  const fixtures=[
    {institution:"Bilt Rewards",type:"credit",original:{source:"plaid",transaction:{name:"Venmo",amount:2875,
      institution:"untrusted-source-institution",personal_finance_category:{primary:"TRANSFER_OUT",detailed:"TRANSFER_OUT_TRANSFER_OUT_FROM_APPS"}}}},
    {institution:"Wealthfront",type:"checking",original:{source:"csv",row:{description:"Bilt Card - HOUSING Withdrawal WITHDRAWAL",amount:-2875,
      institution:"untrusted-source-institution",account_type:"credit"}}},
    {institution:"Venmo - Personal",type:"checking",original:{source:"manual",submitted:{merchant:'Example Landlord "Rent"',amount:-2875,
      institution:"untrusted-source-institution",account_type:"credit"}}}
  ];
  const accountIds=[],transactionIds=[];
  const rules="Bilt housing flow: outgoing Venmo housing charges on Bilt Rewards credit accounts are Rent. Payment - Bilt Housing credits and source-bank Bilt Housing withdrawals are Credit Card Payment. Direct rent payments in Venmo accounts remain Rent.";
  try {
    for(const fixture of fixtures){
      const accountId=Number(database.prepare("INSERT INTO accounts(institution,name,nickname,type) VALUES(?,?,?,?)")
        .run(fixture.institution,"private-owned-account-name","private-owned-account-nickname",fixture.type).lastInsertRowid);
      accountIds.push(accountId);
      const transactionId=Number(database.prepare(`INSERT INTO transactions(
        account_id,date,merchant,category,amount,original_details_json,category_source,categorization_status
      ) VALUES(?,?,?,?,?,?,'fallback','pending')`).run(accountId,"2026-08-15","Venmo","Transfer",-2875,JSON.stringify(fixture.original)).lastInsertRowid);
      transactionIds.push(transactionId);
    }
    for(const adapter of [
      {protocol:"openai-compatible",endpoint:`http://127.0.0.1:${plaidPort}/v1/chat/completions`},
      {protocol:"openai-responses",endpoint:`http://127.0.0.1:${plaidPort}/v1/responses`},
      {protocol:"anthropic",endpoint:`http://127.0.0.1:${plaidPort}/v1/messages`},
      {protocol:"gemini",endpoint:`http://127.0.0.1:${plaidPort}/v1beta`}
    ]){
      const settings=await fetch(`http://localhost:${port}/api/settings/ai`,{
        method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({...adapter,model:"mock-institution-model",api_key:"mock-key",rules})
      });
      assert.equal(settings.status,200);
      assert.equal((await settings.json()).ai.rules,rules);
      aiRequests=[];
      const response=await fetch(`http://localhost:${port}/api/categorization/run`,{
        method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({transaction_ids:transactionIds})
      });
      assert.equal(response.status,200);
      assert.equal((await response.json()).categorized,fixtures.length);
      assert.equal(aiRequests.length,1);
      const request=aiRequests[0].payload;
      const system=adapter.protocol==="anthropic"?request.system
        :adapter.protocol==="gemini"?request.systemInstruction.parts[0].text
        :adapter.protocol==="openai-responses"?request.instructions:request.messages[0].content;
      const user=adapter.protocol==="openai-responses"?request.input
        :adapter.protocol==="gemini"?request.contents.at(-1).parts.at(-1).text:request.messages.at(-1).content;
      assert.ok(system.includes(rules));
      const evidence=decodeToon(user).transactions;
      assert.equal(evidence.length,fixtures.length);
      fixtures.forEach((fixture,index)=>{
        const row=evidence.find(row=>row.id===transactionIds[index]);
        assert.equal(row.institution,fixture.institution);
        assert.equal(row.account_type,fixture.type);
      });
      assert.doesNotMatch(user,/untrusted-source-institution|private-owned-account-name|private-owned-account-nickname/);
      assert.ok(evidence.every(row=>["account_name","nickname","account_id","matching_transaction","related_transactions"].every(field=>!Object.hasOwn(row,field))));
    }
    const saved=database.prepare(`SELECT original_details_json FROM transactions WHERE id IN (${transactionIds.map(()=>"?").join(",")}) ORDER BY id`).all(...transactionIds);
    assert.deepEqual(saved.map(row=>JSON.parse(row.original_details_json)),fixtures.map(fixture=>fixture.original));
  } finally {
    for(const accountId of accountIds)await fetch(`http://localhost:${port}/api/accounts/${accountId}`,{method:"DELETE"});
    await fetch(`http://localhost:${port}/api/settings/ai`,{
      method:"PUT",headers:{"content-type":"application/json"},
      body:JSON.stringify({protocol:"openai-compatible",endpoint:"",model:"",rules:"",clear_api_key:true})
    });
    database.close();
  }
});

test("CSV import works without a category and keeps explicit Moneta categories",async()=>{
  const accountResponse=await fetch(`http://localhost:${port}/api/accounts`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({institution:"CSV Test",name:"Evidence Import",type:"checking",balance:0})
  });
  const accountId=(await accountResponse.json()).id;
  const imported=await fetch(`http://localhost:${port}/api/import`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({account_id:accountId,rows:[
      {date:"2026-08-10",amount:-6.5,description:"Coffee shop purchase",external_id:"csv-categoryless"},
      {date:"2026-08-11",amount:-25,description:"A merchant with no useful name",moneta_category:"Groceries",external_id:"csv-explicit"}
    ]})
  });
  assert.equal(imported.status,200);
  const result=await imported.json();
  assert.equal(result.added,2);
  assert.equal(result.categorization.configured,false);
  assert.equal(result.categorization.requested,1);
  const transactions=(await (await fetch(`http://localhost:${port}/api/transactions?accounts=${accountId}`)).json()).transactions;
  const inferred=transactions.find(transaction=>transaction.external_id==="csv-categoryless");
  assert.equal(inferred.category,"Coffee Shops");
  assert.equal(inferred.category_source,"fallback");
  assert.equal(inferred.categorization_status,"pending");
  const explicit=transactions.find(transaction=>transaction.external_id==="csv-explicit");
  assert.equal(explicit.category,"Groceries");
  assert.equal(explicit.category_source,"manual");
  assert.equal(explicit.categorization_status,"categorized");
  const protectedImport=await fetch(`http://localhost:${port}/api/import`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({account_id:accountId,disable_ai_categorization:true,rows:[
      {date:"2026-08-12",amount:-15,description:"Protected coffee shop",external_id:"csv-protected"}
    ]})
  });
  const protectedImportResult=await protectedImport.json();
  assert.equal(protectedImportResult.added,1);
  assert.equal(protectedImportResult.categorization.requested,0);
  const protectedCsv=(await (await fetch(`http://localhost:${port}/api/transactions?accounts=${accountId}`)).json()).transactions.find(transaction=>transaction.external_id==="csv-protected");
  assert.equal(protectedCsv.category,"Coffee Shops");
  assert.equal(protectedCsv.categorization_status,"categorized");
  assert.equal(protectedCsv.ai_categorization_disabled,1);
  await fetch(`http://localhost:${port}/api/accounts/${accountId}`,{method:"DELETE"});
});

test("CSV import maps arbitrary columns and applies configurable duplicate rules",async()=>{
  const accountResponse=await fetch(`http://localhost:${port}/api/accounts`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({institution:"Mapped CSV Test",name:"Flexible Import",type:"checking",balance:0})
  });
  const accountId=(await accountResponse.json()).id;
  for(const note of ["Original database row","Extra database duplicate"]){
    const response=await fetch(`http://localhost:${port}/api/transactions`,{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({account_id:accountId,date:"2026-09-01",merchant:"Neighborhood Shop",amount:-9,category:"Groceries",note})
    });
    assert.equal(response.status,201);
  }
  const csv={
    headers:["Posted On","Narrative","Value","Chosen Bucket","Comment"],
    rows:[
      ["2026-09-01","Neighborhood Shop","($9.00)","Personal","CSV replacement"],
      ["2026-09-02","Train ticket","-4.50","Public Transit","Morning commute"]
    ]
  };
  const column_mapping={date:0,description:1,amount:2,moneta_category:3,memo:4};
  const keepDatabase=await fetch(`http://localhost:${port}/api/import`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      account_id:accountId,csv,column_mapping,deduplication:{fields:["date","amount","description"],keep:"database"}
    })
  });
  assert.equal(keepDatabase.status,200);
  const kept=await keepDatabase.json();
  assert.equal(kept.added,1);
  assert.equal(kept.skipped,1);
  assert.equal(kept.replaced,0);
  assert.equal(kept.duplicates_removed,1);
  let transactions=(await (await fetch(`http://localhost:${port}/api/transactions?accounts=${accountId}`)).json()).transactions;
  assert.equal(transactions.filter(transaction=>transaction.date==="2026-09-01"&&transaction.merchant==="Neighborhood Shop").length,1);
  assert.equal(transactions.find(transaction=>transaction.date==="2026-09-01").note,"Original database row");
  assert.equal(transactions.find(transaction=>transaction.date==="2026-09-02").category,"Public Transit");

  const keepCsv=await fetch(`http://localhost:${port}/api/import`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      account_id:accountId,csv:{headers:csv.headers,rows:[csv.rows[0]]},column_mapping,
      deduplication:{fields:["date","amount","description"],keep:"csv"},disable_ai_categorization:true
    })
  });
  const replaced=await keepCsv.json();
  assert.equal(replaced.added,0);
  assert.equal(replaced.replaced,1);
  transactions=(await (await fetch(`http://localhost:${port}/api/transactions?accounts=${accountId}`)).json()).transactions;
  const csvWinner=transactions.find(transaction=>transaction.date==="2026-09-01");
  assert.equal(csvWinner.category,"Personal");
  assert.equal(csvWinner.note,"CSV replacement");
  assert.equal(csvWinner.ai_categorization_disabled,1);
  const database=new DatabaseSync(join(temp,"test.db"));
  const original=JSON.parse(database.prepare("SELECT original_details_json FROM transactions WHERE id=?").get(csvWinner.id).original_details_json);
  assert.deepEqual(original.raw_csv.headers,csv.headers);
  assert.deepEqual(original.raw_csv.values,csv.rows[0]);
  database.close();

  const selectedFields=await fetch(`http://localhost:${port}/api/import`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      account_id:accountId,csv:{headers:csv.headers,rows:[["2026-09-02","Different description","-4.50","Personal",""]]},column_mapping,
      deduplication:{fields:["date","amount"],keep:"database"}
    })
  });
  const selectedResult=await selectedFields.json();
  assert.equal(selectedResult.skipped,1);
  assert.equal(selectedResult.added,0);
  await fetch(`http://localhost:${port}/api/accounts/${accountId}`,{method:"DELETE"});
});

test("CSV import normalizes common dates and requires a choice for ambiguous numeric dates",async()=>{
  const accountResponse=await fetch(`http://localhost:${port}/api/accounts`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({institution:"CSV Date Test",name:"Date Formats",type:"checking",balance:0})
  });
  const accountId=(await accountResponse.json()).id;
  const headers=["When","Value","Details"],column_mapping={date:0,amount:1,description:2};
  const importRows=async(rows,date_format="auto")=>fetch(`http://localhost:${port}/api/import`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      account_id:accountId,csv:{headers,rows},column_mapping,date_format,
      deduplication:{fields:["date","amount","description"],keep:"database"}
    })
  });

  const dayFirst=await importRows([
    ["31/08/2026","-1","Unambiguous day first"],
    ["05/09/2026","-2","Ambiguous row inferred day first"]
  ]);
  assert.equal(dayFirst.status,200);
  assert.equal((await dayFirst.json()).date_format.resolved,"dmy");

  const monthFirst=await importRows([
    ["09/30/26","-3","Unambiguous month first"],
    ["10/01/26","-4","Second month-first row"]
  ]);
  assert.equal(monthFirst.status,200);
  assert.equal((await monthFirst.json()).date_format.resolved,"mdy");

  const namedAndYearFirst=await importRows([
    ["September 7, 2026","-5","Named month"],
    ["20260908","-6","Compact ISO"],
    ["2026-09-09T18:30:00Z","-7","ISO timestamp"]
  ]);
  assert.equal(namedAndYearFirst.status,200);

  const ambiguous=await importRows([["06/07/2026","-8","Needs explicit order"]]);
  assert.equal(ambiguous.status,400);
  assert.match((await ambiguous.json()).error,/Could not distinguish MM\/DD\/YYYY from DD\/MM\/YYYY/);
  const explicit=await importRows([["06/07/2026","-8","Needs explicit order"]],"dmy");
  assert.equal(explicit.status,200);

  const transactions=(await (await fetch(`http://localhost:${port}/api/transactions?accounts=${accountId}`)).json()).transactions;
  const byMerchant=new Map(transactions.map(transaction=>[transaction.merchant,transaction]));
  assert.equal(byMerchant.get("Unambiguous day first").date,"2026-08-31");
  assert.equal(byMerchant.get("Ambiguous row inferred day first").date,"2026-09-05");
  assert.equal(byMerchant.get("Unambiguous month first").date,"2026-09-30");
  assert.equal(byMerchant.get("Named month").date,"2026-09-07");
  assert.equal(byMerchant.get("Compact ISO").date,"2026-09-08");
  assert.equal(byMerchant.get("ISO timestamp").date,"2026-09-09");
  const explicitTransaction=byMerchant.get("Needs explicit order");
  assert.equal(explicitTransaction.date,"2026-07-06");
  const database=new DatabaseSync(join(temp,"test.db"));
  const original=JSON.parse(database.prepare("SELECT original_details_json FROM transactions WHERE id=?").get(explicitTransaction.id).original_details_json);
  database.close();
  assert.equal(original.raw_csv.values[0],"06/07/2026");
  await fetch(`http://localhost:${port}/api/accounts/${accountId}`,{method:"DELETE"});
});

test("static app is served",async()=>{
  const res=await fetch(`http://localhost:${port}/`);
  assert.equal(res.status,200);
  const html=await res.text();
  assert.match(html,/Personal finance, made clear/);
  assert.match(html,/Cash flow/);
  assert.match(html,/Protect this category from AI/);
  assert.match(html,/Protect imported categories from AI/);
  assert.match(html,/csvColumnMapping/);
  assert.match(html,/csvDedupeFields/);
  assert.match(html,/csvDuplicateAction/);
  assert.match(html,/csvDateFormat/);
  assert.match(html,/class="close-btn" value="cancel" formnovalidate/);
  assert.match(html,/class="quiet-btn" value="cancel" formnovalidate>Cancel/);
  assert.match(html,/cashflowSankey/);
  assert.match(html,/cashflowBarTooltip/);
  assert.match(html,/cashflowMonthDetailsRows/);
  assert.match(html,/sankeyDetailsRows/);
  assert.match(html,/categorySelect/);
  assert.match(html,/plaidSettingsForm/);
  assert.match(html,/aiSettingsForm/);
  assert.match(html,/recategorizeAllBtn/);
  assert.match(html,/generateDemoBtn/);
  assert.match(html,/accountNicknameForm/);
  assert.match(html,/id="saveAccountNickname"/);
  const app=await (await fetch(`http://localhost:${port}/app.js`)).text();
  assert.match(app,/data-reauthenticate/);
  assert.match(app,/\/api\/plaid\/update-link-token/);
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
    body:JSON.stringify({account_id:accountId,date:date(today),merchant:"Daily expense",amount:-10,category:"Miscellaneous"})
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
  assert.equal(history.history[0].current,false);
  assert.equal(history.history[1].current,true);
  assert.equal(history.closing_dates,1);
  assert.equal(history.change,-10);
  await fetch(`http://localhost:${port}/api/accounts/${accountId}`,{method:"DELETE"});
});

test("net worth requires complete coverage only for the latest historical date",async()=>{
  const createAccount=async(name,balance)=>{
    const response=await fetch(`http://localhost:${port}/api/accounts`,{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({institution:"Closing Coverage",name,type:"investment",balance})
    });
    assert.equal(response.status,201);
    return (await response.json()).id;
  };
  const firstId=await createAccount("First market",100),secondId=await createAccount("Second market",200),noHistoryId=await createAccount("No transaction history",300);
  const today=new Date(),earlierPartialDate=new Date(today),commonDate=new Date(today),latestPartialDate=new Date(today);
  earlierPartialDate.setUTCDate(today.getUTCDate()-4);commonDate.setUTCDate(today.getUTCDate()-3);latestPartialDate.setUTCDate(today.getUTCDate()-2);
  const date=value=>value.toISOString().slice(0,10);
  const database=new DatabaseSync(join(temp,"test.db"));
  const save=database.prepare(`INSERT INTO account_balance_history(account_id,date,balance,source) VALUES(?,?,?,'reconstructed')
    ON CONFLICT(account_id,date) DO UPDATE SET balance=excluded.balance,source='reconstructed'`);
  save.run(firstId,date(earlierPartialDate),85);save.run(firstId,date(commonDate),90);save.run(firstId,date(latestPartialDate),95);save.run(secondId,date(commonDate),190);
  database.close();

  const combined=await (await fetch(`http://localhost:${port}/api/net-worth?from=${date(earlierPartialDate)}&to=${date(today)}&accounts=${firstId},${secondId},${noHistoryId}`)).json();
  assert.deepEqual(combined.history.map(point=>point.date),[date(earlierPartialDate),date(commonDate),date(today)]);
  assert.deepEqual(combined.history.map(point=>point.value),[85,280,600]);
  assert.deepEqual(combined.history.map(point=>point.current),[false,false,true]);
  assert.equal(combined.closing_dates,2);

  const filtered=await (await fetch(`http://localhost:${port}/api/net-worth?from=${date(earlierPartialDate)}&to=${date(today)}&accounts=${firstId}`)).json();
  assert.deepEqual(filtered.history.map(point=>point.date),[date(earlierPartialDate),date(commonDate),date(latestPartialDate),date(today)]);
  assert.deepEqual(filtered.history.map(point=>point.value),[85,90,95,100]);
  assert.equal(filtered.closing_dates,3);

  await fetch(`http://localhost:${port}/api/accounts/${firstId}`,{method:"DELETE"});
  await fetch(`http://localhost:${port}/api/accounts/${secondId}`,{method:"DELETE"});
  await fetch(`http://localhost:${port}/api/accounts/${noHistoryId}`,{method:"DELETE"});
});

test("report views persist configuration without calculated values",async()=>{
  const configuration={version:1,filters:{range:"custom",from:"2026-06-01",to:"2026-06-30",accounts:[1],categories:["Groceries"],search:"market"}};
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

test("saved cash-flow views retain optional month focus without narrowing their chart date range",async()=>{
  for(const month of ["2026-09","2026-13"]){
    const configuration={version:1,filters:{range:"custom",from:"2026-08-01",to:"2026-10-31",accounts:[],categories:[],search:"",month}};
    const created=await fetch(`http://localhost:${port}/api/views`,{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Month focus",configuration})
    });
    assert.equal(created.status,201);
    const view=await created.json();
    const fetched=await (await fetch(`http://localhost:${port}/api/views/${view.id}`)).json();
    assert.equal(fetched.configuration.filters.from,"2026-08-01");
    assert.equal(fetched.configuration.filters.to,"2026-10-31");
    if(month==="2026-09")assert.equal(fetched.configuration.filters.month,month);
    else assert.equal(Object.hasOwn(fetched.configuration.filters,"month"),false);
    assert.equal(Object.hasOwn(fetched,"summary"),false);
    assert.equal((await fetch(`http://localhost:${port}/api/views/${view.id}`,{method:"DELETE"})).status,200);
  }
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
    body:JSON.stringify({account_id:accountId,date:"2026-07-08",merchant:"Test Expense",amount:-12,category:"Miscellaneous"})
  });
  assert.equal(txRes.status,201);
  const txId=(await txRes.json()).id;

  const nicknameResponse=await fetch(`http://localhost:${port}/api/accounts/${accountId}`,{
    method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({nickname:"Travel Cash"})
  });
  assert.equal(nicknameResponse.status,200);
  const nicknamedAccount=await nicknameResponse.json();
  assert.equal(nicknamedAccount.name,"Travel Cash");
  assert.equal(nicknamedAccount.official_name,"Pocket");
  assert.equal(nicknamedAccount.nickname,"Travel Cash");
  const nicknameData=await (await fetch(`http://localhost:${port}/api/bootstrap`)).json();
  assert.equal(nicknameData.accounts.find(account=>account.id===accountId).name,"Travel Cash");
  assert.equal(nicknameData.transactions.find(transaction=>transaction.id===txId).account_name,"Travel Cash");
  const nicknameNetWorth=await (await fetch(`http://localhost:${port}/api/net-worth?accounts=${accountId}`)).json();
  assert.equal(nicknameNetWorth.accounts[0].name,"Travel Cash");

  const clearNickname=await fetch(`http://localhost:${port}/api/accounts/${accountId}`,{
    method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({nickname:""})
  });
  assert.equal(clearNickname.status,200);
  assert.equal((await clearNickname.json()).name,"Pocket");

  const removed=await fetch(`http://localhost:${port}/api/accounts/${accountId}`,{method:"DELETE"});
  assert.equal(removed.status,200);
  assert.equal((await removed.json()).transactions_deleted,1);
  const data=await (await fetch(`http://localhost:${port}/api/bootstrap`)).json();
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
  assert.equal(result.sync.investment_refreshed,true);
  assert.equal(plaidInvestmentRefreshes,1);

  const status=await (await fetch(`http://localhost:${port}/api/plaid/status`)).json();
  const item=status.items.find(row=>row.id===result.item_id);
  assert.equal(item.status,"connected");
  assert.equal(item.error_code,null);
  const bootstrap=await (await fetch(`http://localhost:${port}/api/bootstrap`)).json();
  const investmentAccount=bootstrap.accounts.find(account=>account.external_account_id==="investment-test");
  assert.equal(investmentAccount.balance,26000);
  const investmentTransaction=bootstrap.transactions.find(transaction=>transaction.external_id==="plaid:investment-tx-test");
  assert.equal(investmentTransaction.category,"Buy");
  assert.equal(investmentTransaction.category_group,"Transfers");
  assert.equal(Object.hasOwn(investmentTransaction,"kind"),false);
  const refresh=await fetch(`http://localhost:${port}/api/plaid/sync`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({item_id:result.item_id})
  });
  assert.equal(refresh.status,200);
  assert.equal((await refresh.json()).results[0].investment_refreshed,true);
  assert.equal(plaidInvestmentRefreshes,2);
  const refreshedBootstrap=await (await fetch(`http://localhost:${port}/api/bootstrap`)).json();
  assert.equal(refreshedBootstrap.accounts.find(account=>account.external_account_id==="investment-test").balance,27000);
  const today=new Date(),yesterday=new Date(today);yesterday.setUTCDate(today.getUTCDate()-1);
  const historyDatabase=new DatabaseSync(join(temp,"test.db"));
  historyDatabase.prepare(`INSERT INTO account_balance_history(account_id,date,balance,source) VALUES(?,?,99999,'plaid')
    ON CONFLICT(account_id,date) DO UPDATE SET balance=99999,source='plaid'`).run(investmentAccount.id,yesterday.toISOString().slice(0,10));
  historyDatabase.close();
  const history=await (await fetch(`http://localhost:${port}/api/net-worth?from=${yesterday.toISOString().slice(0,10)}&to=${today.toISOString().slice(0,10)}&accounts=${investmentAccount.id}`)).json();
  assert.equal(history.history[0].value,20000);
  assert.equal(history.history.at(-1).value,27000);
  assert.equal(history.latest,27000);
  assert.equal(history.reconstruction.accounts[0].extended,true);
  const reconstructedDatabase=new DatabaseSync(join(temp,"test.db"));
  const reconstructedDay=reconstructedDatabase.prepare("SELECT balance,source FROM account_balance_history WHERE account_id=? AND date=?").get(investmentAccount.id,yesterday.toISOString().slice(0,10));
  assert.equal(reconstructedDay.balance,20000);
  assert.equal(reconstructedDay.source,"reconstructed");
  assert.equal(reconstructedDatabase.prepare("SELECT COUNT(*) count FROM security_prices WHERE source='execution'").get().count,0);
  reconstructedDatabase.close();
  const cached=await (await fetch(`http://localhost:${port}/api/net-worth?from=${yesterday.toISOString().slice(0,10)}&to=${today.toISOString().slice(0,10)}&accounts=${investmentAccount.id}`)).json();
  assert.equal(cached.history[0].value,20000);
  assert.equal(cached.reconstruction.accounts[0].extended,false);

  const emptyDatabase=new DatabaseSync(join(temp,"test.db"));
  const emptyResult=emptyDatabase.prepare(`INSERT INTO accounts(
    institution,name,type,balance,color,last_sync,connected,plaid_item_id,external_account_id
  ) VALUES('Fidelity','Empty investment','investment',0,'#111827',datetime('now'),1,?,'empty-investment-test')`).run(result.item_id);
  const emptyAccountId=Number(emptyResult.lastInsertRowid);
  emptyDatabase.prepare("UPDATE plaid_items SET last_sync=datetime('now','-5 days') WHERE id=?").run(result.item_id);
  emptyDatabase.close();
  const withEmpty=await (await fetch(`http://localhost:${port}/api/net-worth?from=${yesterday.toISOString().slice(0,10)}&to=${today.toISOString().slice(0,10)}&accounts=${investmentAccount.id},${emptyAccountId}`)).json();
  assert.equal(withEmpty.history[0].date,yesterday.toISOString().slice(0,10));
  assert.equal(withEmpty.history[0].value,20000);
  const inferredResult=withEmpty.reconstruction.accounts.find(account=>account.account_id===emptyAccountId);
  assert.equal(inferredResult.inferred_zero,true);
  assert.equal(inferredResult.inference_date,yesterday.toISOString().slice(0,10));
  assert.deepEqual(inferredResult.warnings,[]);
  const inferredDatabase=new DatabaseSync(join(temp,"test.db"));
  const inferredRow=inferredDatabase.prepare("SELECT balance,source FROM account_balance_history WHERE account_id=? AND date=?").get(emptyAccountId,yesterday.toISOString().slice(0,10));
  assert.equal(inferredRow.balance,0);
  assert.equal(inferredRow.source,"inferred_zero");
  inferredDatabase.prepare("UPDATE plaid_items SET status='sync_error' WHERE id=?").run(result.item_id);
  inferredDatabase.close();
  const failedInference=await (await fetch(`http://localhost:${port}/api/net-worth?from=${yesterday.toISOString().slice(0,10)}&to=${today.toISOString().slice(0,10)}&accounts=${emptyAccountId}`)).json();
  assert.match(failedInference.reconstruction.warnings[0],/completed Plaid investment sync/);
  const invalidatedDatabase=new DatabaseSync(join(temp,"test.db"));
  assert.equal(invalidatedDatabase.prepare("SELECT COUNT(*) count FROM account_balance_history WHERE account_id=? AND source='inferred_zero'").get(emptyAccountId).count,0);
  invalidatedDatabase.prepare("UPDATE plaid_items SET status='connected' WHERE id=?").run(result.item_id);
  invalidatedDatabase.close();
  await fetch(`http://localhost:${port}/api/accounts/${emptyAccountId}`,{method:"DELETE"});
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

  const inProgress=await (await fetch(`http://localhost:${port}/api/bootstrap?from=2026-07-01&to=2026-07-31`)).json();
  assert.equal(inProgress.accounts.find(account=>account.external_account_id==="checking-test").plaid_status,"syncing");
  let data;
  for(let attempt=0;attempt<20;attempt++){
    await new Promise(resolve=>setTimeout(resolve,25));
    data=await (await fetch(`http://localhost:${port}/api/bootstrap?from=2026-07-01&to=2026-07-31`)).json();
    if(data.accounts.find(account=>account.external_account_id==="checking-test")?.plaid_status==="connected")break;
  }
  plaidSyncDelay=0;
  const checking=data.accounts.find(account=>account.external_account_id==="checking-test");
  const credit=data.accounts.find(account=>account.external_account_id==="credit-test");
  assert.equal(checking.balance,1250);
  assert.equal(credit.balance,-325);
  assert.equal(data.transactions.find(tx=>tx.external_id==="plaid:tx-out").amount,-42.5);
  assert.equal(data.transactions.find(tx=>tx.external_id==="plaid:tx-in").amount,2000);
  assert.equal(data.transactions.find(tx=>tx.external_id==="plaid:tx-out").category_group,"Food & Dining");
  assert.equal(data.transactions.find(tx=>tx.external_id==="plaid:tx-in").category_group,"Income");

  const reauthenticationDatabase=new DatabaseSync(join(temp,"test.db"));
  reauthenticationDatabase.prepare("UPDATE plaid_items SET status='sync_error',error_code='ITEM_LOGIN_REQUIRED' WHERE id=?").run(result.item_id);
  reauthenticationDatabase.close();
  const needsReauthentication=await (await fetch(`http://localhost:${port}/api/bootstrap`)).json();
  const affectedAccount=needsReauthentication.accounts.find(account=>account.external_account_id==="checking-test");
  assert.equal(affectedAccount.plaid_status,"sync_error");
  assert.equal(affectedAccount.plaid_error_code,"ITEM_LOGIN_REQUIRED");
  const updateTokenResponse=await fetch(`http://localhost:${port}/api/plaid/update-link-token`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({item_id:result.item_id})
  });
  assert.equal(updateTokenResponse.status,200);
  const updateToken=await updateTokenResponse.json();
  assert.equal(updateToken.link_token,"link-sandbox-test");
  assert.equal(updateToken.item_id,result.item_id);
  assert.equal(updateToken.institution_name,"Plaid Test Bank");
  assert.equal(updateToken.mode,"update");
  const updateRequest=plaidLinkTokenRequests.at(-1);
  assert.equal(updateRequest.access_token,"access-sandbox-test");
  assert.equal(updateRequest.products,undefined);
  assert.equal(updateRequest.user.client_user_id,"moneta-local-user");
  const missingUpdateToken=await fetch(`http://localhost:${port}/api/plaid/update-link-token`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({item_id:999999})
  });
  assert.equal(missingUpdateToken.status,404);
  const restoredDatabase=new DatabaseSync(join(temp,"test.db"));
  restoredDatabase.prepare("UPDATE plaid_items SET status='connected',error_code=NULL WHERE id=?").run(result.item_id);
  restoredDatabase.close();

  const nicknameResponse=await fetch(`http://localhost:${port}/api/accounts/${checking.id}`,{
    method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({nickname:"Household Checking"})
  });
  assert.equal(nicknameResponse.status,200);
  assert.equal((await nicknameResponse.json()).official_name,checking.name);

  const database=new DatabaseSync(join(temp,"test.db"));
  database.prepare(`UPDATE transactions SET category='Personal',category_source='ai',categorization_status='categorized',
    original_details_json=? WHERE external_id='plaid:tx-out'`).run(JSON.stringify({source:"legacy-plaid",merchant:"Corner Market"}));
  database.close();
  const replay=await fetch(`http://localhost:${port}/api/plaid/reimport-legacy`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({item_id:result.item_id})
  });
  assert.equal(replay.status,200);
  const replayResult=(await replay.json()).results[0];
  assert.equal(replayResult.raw_responses_stored,1);
  assert.equal(replayResult.legacy_remaining,0);
  const replayedDatabase=new DatabaseSync(join(temp,"test.db"));
  const replayed=replayedDatabase.prepare("SELECT category,category_source,categorization_status,original_details_json FROM transactions WHERE external_id='plaid:tx-out'").get();
  replayedDatabase.close();
  assert.equal(replayed.category,"Personal");
  assert.equal(replayed.category_source,"ai");
  assert.equal(replayed.categorization_status,"categorized");
  assert.equal(JSON.parse(replayed.original_details_json).source,"plaid");

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
  const afterRefresh=await (await fetch(`http://localhost:${port}/api/bootstrap?from=2026-07-01&to=2026-07-31`)).json();
  const refreshedChecking=afterRefresh.accounts.find(account=>account.external_account_id==="checking-test");
  assert.equal(refreshedChecking.name,"Household Checking");
  assert.equal(refreshedChecking.official_name,checking.name);
  assert.equal(afterRefresh.transactions.find(tx=>tx.external_id==="plaid:tx-out").account_name,"Household Checking");

  const deleteChecking=await fetch(`http://localhost:${port}/api/accounts/${checking.id}`,{method:"DELETE"});
  assert.equal(deleteChecking.status,200);
  assert.equal((await deleteChecking.json()).transactions_deleted,2);

  const syncAfterDelete=await fetch(`http://localhost:${port}/api/plaid/sync`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({item_id:result.item_id})
  });
  assert.equal(syncAfterDelete.status,200);
  const afterDelete=await (await fetch(`http://localhost:${port}/api/bootstrap?from=2026-07-01&to=2026-07-31`)).json();
  assert.equal(afterDelete.accounts.some(account=>account.external_account_id==="checking-test"),false);
  assert.equal(afterDelete.accounts.some(account=>account.external_account_id==="credit-test"),true);
  assert.equal(afterDelete.transactions.some(tx=>tx.external_id==="plaid:tx-out"),false);
  assert.equal(afterDelete.transactions.some(tx=>tx.external_id==="plaid:tx-in"),false);
});

test("AI categorization stores original details and batches transactions through a configurable provider",async()=>{
  const accountResponse=await fetch(`http://localhost:${port}/api/accounts`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({institution:"AI Test",name:"Batch Account",type:"cash",balance:0})
  });
  const accountId=(await accountResponse.json()).id,ids=[];
  for(const transaction of [
    {merchant:"Monthly salary from Acme Payroll",amount:5000,category:"Transfer",note:"Direct deposit"},
    {merchant:"Venmo dinner with friends",amount:-48,category:"Transfer",note:"Dinner split"}
  ]){
    const response=await fetch(`http://localhost:${port}/api/transactions`,{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({account_id:accountId,date:"2026-08-15",...transaction})
    });
    assert.equal(response.status,201);ids.push((await response.json()).id);
  }

  const rules="Acme Payroll deposits are Paychecks. Peer-to-peer dinner memos are Restaurants & Bars.";
  const settingsResponse=await fetch(`http://localhost:${port}/api/settings/ai`,{
    method:"PUT",headers:{"content-type":"application/json"},
    body:JSON.stringify({protocol:"openai-compatible",endpoint:`http://127.0.0.1:${plaidPort}/v1/chat/completions`,model:"mock-category-model",api_key:"test-ai-key",rules})
  });
  assert.equal(settingsResponse.status,200);
  const settings=(await settingsResponse.json()).ai;
  assert.equal(settings.configured,true);
  assert.equal(settings.api_key_configured,true);
  assert.equal("api_key" in settings,false);
  assert.equal(settings.rules,rules);

  aiRequests=[];
  const categorize=await fetch(`http://localhost:${port}/api/categorization/run`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({transaction_ids:ids})
  });
  assert.equal(categorize.status,200);
  const result=await categorize.json();
  assert.equal(result.requested,2);assert.equal(result.categorized,2);assert.equal(result.failed,0);assert.equal(result.requests,1);
  assert.equal(aiRequests.length,1);
  assert.equal(aiRequests[0].payload.model,"mock-category-model");
  assert.match(aiRequests[0].payload.messages[0].content,/User rules \(authoritative when relevant\)/);
  assert.match(aiRequests[0].payload.messages[0].content,/Peer-to-peer dinner memos/);
  const sent=decodeToon(aiRequests[0].payload.messages.at(-1).content).transactions;
  assert.equal(sent.length,2);
  assert.equal(sent[0].description,"Monthly salary from Acme Payroll");
  assert.equal(sent[0].account_type,"cash");
  assert.equal(sent[0].memo,"Direct deposit");
  assert.equal("date" in sent[0],false);
  assert.equal("original_details" in sent[0],false);
  assert.equal(sent[0].institution,"AI Test");
  assert.equal("source_category_confidence" in sent[0],false);

  const transactions=(await (await fetch(`http://localhost:${port}/api/transactions?accounts=${accountId}`)).json()).transactions;
  assert.equal(transactions.find(transaction=>transaction.id===ids[0]).category,"Paychecks");
  assert.equal(transactions.find(transaction=>transaction.id===ids[1]).category,"Restaurants & Bars");
  assert.ok(transactions.every(transaction=>transaction.category_source==="ai"&&transaction.categorization_status==="categorized"&&transaction.has_original_details));
  assert.ok(transactions.every(transaction=>!("original_details_json" in transaction)));

  aiRequests=[];
  const csvImport=await fetch(`http://localhost:${port}/api/import`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({account_id:accountId,rows:[{
      date:"2026-08-14",amount:-32,description:"P2P PAYMENT",memo:"Lunch with coworkers",
      source_category:"TRANSFER_OUT",source_category_detail:"TRANSFER_OUT_ACCOUNT_TRANSFER",
      source_category_confidence:"low",
      transaction_code:"DDA_TRANSACTION",payment_channel:"online",external_id:"csv-ai-evidence"
    }]})
  });
  assert.equal(csvImport.status,200);
  const csvResult=await csvImport.json();
  assert.equal(csvResult.added,1);
  assert.equal(csvResult.categorization.categorized,1);
  assert.equal(aiRequests.length,1);
  const csvEvidence=decodeToon(aiRequests[0].payload.messages.at(-1).content).transactions[0];
  assert.equal(csvEvidence.description,"P2P PAYMENT");
  assert.equal(csvEvidence.memo,"Lunch with coworkers");
  assert.equal(csvEvidence.source_category,"TRANSFER_OUT");
  assert.equal(csvEvidence.source_category_detail,"TRANSFER_OUT_ACCOUNT_TRANSFER");
  assert.equal(csvEvidence.source_category_confidence,"LOW");
  assert.equal(csvEvidence.transaction_code,"DDA_TRANSACTION");
  assert.equal(csvEvidence.account_type,"cash");
  assert.equal(csvEvidence.institution,"AI Test");
  assert.equal("date" in csvEvidence,false);
  assert.equal("payment_channel" in csvEvidence,false);
  assert.equal("external_id" in csvEvidence,false);
  assert.equal("account_name" in csvEvidence,false);
  assert.equal("category" in csvEvidence,false);

  aiRequests=[];
  const explicitImport=await fetch(`http://localhost:${port}/api/import`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({account_id:accountId,rows:[{
      date:"2026-08-13",amount:-21,description:"Neighborhood market",category:"Groceries",external_id:"csv-explicit-category"
    }]})
  });
  const explicitResult=await explicitImport.json();
  assert.equal(explicitResult.added,1);
  assert.equal(explicitResult.categorization.requested,0);
  assert.equal(aiRequests.length,0);
  const imported=(await (await fetch(`http://localhost:${port}/api/transactions?accounts=${accountId}`)).json()).transactions;
  const explicitTransaction=imported.find(transaction=>transaction.external_id==="csv-explicit-category");
  assert.equal(explicitTransaction.category,"Groceries");
  assert.equal(explicitTransaction.category_source,"manual");
  assert.equal(imported.find(transaction=>transaction.external_id==="csv-ai-evidence").category,"Restaurants & Bars");

  for(const adapter of [
    {protocol:"openai-responses",endpoint:`http://127.0.0.1:${plaidPort}/v1/responses`,model:"mock-openai",path:"/v1/responses",header:"authorization",headerValue:"Bearer provider-test-key"},
    {protocol:"anthropic",endpoint:`http://127.0.0.1:${plaidPort}/v1/messages`,model:"mock-anthropic",path:"/v1/messages",header:"x-api-key",headerValue:"provider-test-key"},
    {protocol:"gemini",endpoint:`http://127.0.0.1:${plaidPort}/v1beta`,model:"mock-gemini",path:"/v1beta/models/mock-gemini:generateContent",header:"x-goog-api-key",headerValue:"provider-test-key"}
  ]){
    const response=await fetch(`http://localhost:${port}/api/settings/ai`,{
      method:"PUT",headers:{"content-type":"application/json"},
      body:JSON.stringify({...adapter,api_key:"provider-test-key",rules})
    });
    assert.equal(response.status,200);
    aiRequests=[];
    const run=await fetch(`http://localhost:${port}/api/categorization/run`,{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({transaction_ids:ids})
    });
    assert.equal(run.status,200);
    const adapterResult=await run.json();
    assert.equal(adapterResult.configured,true);
    assert.equal(adapterResult.requested,2);
    assert.equal(adapterResult.categorized,2);
    assert.equal(adapterResult.failed,0);
    assert.equal(adapterResult.requests,1);
    assert.deepEqual(adapterResult.errors,[]);
    assert.equal(aiRequests.length,1);
    assert.equal(aiRequests[0].url,adapter.path);
    assert.equal(aiRequests[0].headers[adapter.header],adapter.headerValue);
    assert.equal(aiRequests[0].payload.model,adapter.protocol==="gemini"?undefined:adapter.model);
    if(adapter.protocol==="openai-responses")assert.equal(aiRequests[0].payload.text.format.type,"json_schema");
    if(adapter.protocol==="anthropic"){
      assert.equal(aiRequests[0].headers["anthropic-version"],"2023-06-01");
      assert.equal(aiRequests[0].payload.thinking.type,"disabled");
      assert.equal(aiRequests[0].payload.output_config.format.type,"json_schema");
      assert.deepEqual(new Set(aiRequests[0].payload.output_config.format.schema.required),new Set(ids.map(String)));
      assert.equal(aiRequests[0].payload.output_config.format.schema.additionalProperties,false);
      assert.deepEqual(new Set(Object.keys(aiRequests[0].payload.output_config.format.schema.properties)),new Set(ids.map(String)));
      assert.deepEqual(aiRequests[0].payload.output_config.format.schema.properties[String(ids[0])],{type:"string"});
      assert.equal("$defs" in aiRequests[0].payload.output_config.format.schema,false);
    }
    if(adapter.protocol==="gemini")assert.equal(aiRequests[0].payload.generationConfig.responseMimeType,"application/json");
  }

  await fetch(`http://localhost:${port}/api/settings/ai`,{
    method:"PUT",headers:{"content-type":"application/json"},
    body:JSON.stringify({protocol:"anthropic",endpoint:`http://127.0.0.1:${plaidPort}/v1/messages`,model:"mock-anthropic",api_key:"provider-test-key",rules})
  });
  const retryIds=imported.map(transaction=>transaction.id);
  aiRequests=[];aiResponseMode="truncate-over-two";aiResponseDelay=100;
  const retryPromise=fetch(`http://localhost:${port}/api/categorization/run`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({transaction_ids:retryIds})
  });
  let runningProgress;
  for(let attempt=0;attempt<20&&!runningProgress?.running;attempt++){
    await new Promise(resolve=>setTimeout(resolve,10));
    runningProgress=(await (await fetch(`http://localhost:${port}/api/settings`)).json()).ai.progress;
  }
  assert.equal(runningProgress.running,true);
  assert.equal(runningProgress.requested,4);
  const retryResult=await (await retryPromise).json();
  assert.equal(retryResult.stopped,false);
  assert.equal(retryResult.categorized,4);
  assert.equal(retryResult.failed,0);
  assert.equal(retryResult.requests,3);
  assert.deepEqual(aiRequests.map(request=>decodeToon(request.payload.messages.at(-1).content).transactions.length),[4,2,2]);
  aiResponseMode="";aiResponseDelay=0;

  aiRequests=[];aiResponseMode="schema-complex-over-two";
  const schemaRetryRun=await fetch(`http://localhost:${port}/api/categorization/run`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({transaction_ids:retryIds})
  });
  const schemaRetryResult=await schemaRetryRun.json();
  assert.equal(schemaRetryResult.stopped,false);
  assert.equal(schemaRetryResult.categorized,4);
  assert.equal(schemaRetryResult.failed,0);
  assert.equal(schemaRetryResult.requests,3);
  assert.deepEqual(aiRequests.map(request=>decodeToon(request.payload.messages.at(-1).content).transactions.length),[4,2,2]);
  aiResponseMode="";

  aiRequests=[];aiResponseMode="omit-over-two";
  const incompleteRun=await fetch(`http://localhost:${port}/api/categorization/run`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({transaction_ids:retryIds})
  });
  const incompleteResult=await incompleteRun.json();
  assert.equal(incompleteResult.stopped,false);
  assert.equal(incompleteResult.categorized,4);
  assert.equal(incompleteResult.failed,0);
  assert.equal(incompleteResult.requests,2);
  assert.deepEqual(aiRequests.map(request=>decodeToon(request.payload.messages.at(-1).content).transactions.length),[4,1]);
  assert.deepEqual(aiRequests[1].payload.output_config.format.schema.required,[aiRequests[0].payload.output_config.format.schema.required.at(-1)]);
  aiResponseMode="";

  const outageAccountResponse=await fetch(`http://localhost:${port}/api/accounts`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({institution:"Outage Test",name:"Stop Early",type:"cash",balance:0})
  });
  const outageAccountId=(await outageAccountResponse.json()).id;
  const outageRows=Array.from({length:55},(_,index)=>({
    date:"2026-08-12",amount:-(index+1),description:`Outage transaction ${index+1}`,
    category:"Miscellaneous",external_id:`outage-${index+1}`
  }));
  await fetch(`http://localhost:${port}/api/import`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({account_id:outageAccountId,rows:outageRows})
  });
  const outageIds=(await (await fetch(`http://localhost:${port}/api/transactions?accounts=${outageAccountId}`)).json()).transactions.map(transaction=>transaction.id);
  aiRequests=[];aiResponseMode="server-error";
  const outageRun=await fetch(`http://localhost:${port}/api/categorization/run`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({transaction_ids:outageIds})
  });
  const outageResult=await outageRun.json();
  assert.equal(outageResult.stopped,true);
  assert.equal(outageResult.requests,1);
  assert.equal(outageResult.failed,50);
  assert.equal(aiRequests.length,1);
  const outageTransactions=(await (await fetch(`http://localhost:${port}/api/transactions?accounts=${outageAccountId}`)).json()).transactions;
  assert.equal(outageTransactions.filter(transaction=>transaction.categorization_status==="error").length,50);
  assert.equal(outageTransactions.filter(transaction=>transaction.categorization_status==="categorized").length,5);
  aiResponseMode="";
  await fetch(`http://localhost:${port}/api/accounts/${outageAccountId}`,{method:"DELETE"});

  aiRequests=[];
  const recategorizeAll=await fetch(`http://localhost:${port}/api/categorization/run`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({all:true})
  });
  assert.equal(recategorizeAll.status,200);
  assert.ok((await recategorizeAll.json()).categorized>=2);
  const afterAll=(await (await fetch(`http://localhost:${port}/api/bootstrap`)).json()).transactions;
  for(const externalId of ["demo:tx:5","demo:tx:6"]){
    const transfer=afterAll.find(transaction=>transaction.external_id===externalId);
    assert.equal(transfer.category,"Miscellaneous");
    assert.equal(transfer.category_source,"ai");
    assert.equal(transfer.categorization_status,"categorized");
    assert.ok(transfer.transfer_pair_id);
  }
  await fetch(`http://localhost:${port}/api/accounts/${accountId}`,{method:"DELETE"});
});
