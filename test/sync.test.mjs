import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createSyncLock } from "../lib/sync-lock.mjs";
import { syncTimerUnits } from "../lib/sync-schedule.mjs";

const root=fileURLToPath(new URL("../",import.meta.url));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function child(args,env,cwd=root) {
  const process=spawn(globalThis.process.execPath,args,{cwd,env,stdio:["ignore","pipe","pipe"]});
  let stdout="",stderr="";
  process.stdout.on("data",data=>stdout+=data);
  process.stderr.on("data",data=>stderr+=data);
  const finished=new Promise((resolve,reject)=>{
    process.once("error",reject);
    process.once("close",code=>resolve({code,stdout,stderr}));
  });
  return {process,finished,output:()=>stdout,errorOutput:()=>stderr};
}
async function until(predicate) {
  for(let attempt=0;attempt<200;attempt++) {
    if(await predicate())return;
    await pause(10);
  }
  throw new Error("Timed out waiting for test process");
}
async function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),"moneta-sync-test-"));
  const states={calls:0,statuses:[],block:null,entered:null};
  const mock=createServer(async(req,res)=>{
    let raw="";for await(const chunk of req)raw+=chunk;
    const payload=JSON.parse(raw);
    if(payload.access_token==="access-bad") {
      res.writeHead(400,{"content-type":"application/json"});
      return res.end(JSON.stringify({error_code:"ITEM_LOGIN_REQUIRED",error_message:"Re-authentication required"}));
    }
    let data;
    const suffix=payload.access_token==="access-second"?"second":"first";
    if(req.url==="/accounts/get")data={accounts:[{account_id:`account-${suffix}`,name:`Account ${suffix}`,type:"depository",subtype:"checking",balances:{current:1000}}]};
    if(req.url==="/transactions/sync") {
      states.calls++;
      const block=states.block;states.block=null;
      states.entered?.();states.entered=null;
      if(block)await block;
      const status=states.statuses.shift()||"HISTORICAL_UPDATE_COMPLETE";
      data={transactions_update_status:status,added:status==="NOT_READY"||payload.cursor?[]:[{
        transaction_id:`tx-${suffix}`,account_id:`account-${suffix}`,date:"2026-10-01",name:"Local Market",amount:25,pending:false
      }],modified:[],removed:[],next_cursor:status==="NOT_READY"?"":"cursor-complete",has_more:false};
    }
    res.writeHead(data?200:404,{"content-type":"application/json"});
    res.end(JSON.stringify(data||{error_code:"UNEXPECTED_ENDPOINT"}));
  });
  await new Promise(resolve=>mock.listen(0,"127.0.0.1",resolve));
  const env={...process.env,PORT:"0",FINANCE_DB_PATH:join(directory,"finance.db"),
    PLAID_CLIENT_ID:"test-client",PLAID_SECRET:"test-secret",PLAID_ENV:"sandbox",
    PLAID_BASE_URL:`http://127.0.0.1:${mock.address().port}`,PLAID_SYNC_RETRY_MS:"10",PLAID_SYNC_MAX_ATTEMPTS:"200"};
  const processes=[];
  const launch=(args,cwd)=>{const running=child(args,env,cwd);processes.push(running);return running;};
  t.after(async()=>{
    for(const running of processes)if(running.process.exitCode===null)running.process.kill();
    await Promise.all(processes.map(running=>running.finished));
    await new Promise(resolve=>mock.close(resolve));
    rmSync(directory,{recursive:true,force:true});
  });
  const empty=await launch([join(root,"scripts/sync.mjs")],directory).finished;
  assert.equal(empty.code,0,empty.stderr);
  assert.match(empty.stdout,/"connections":0/);
  assert.doesNotMatch(empty.stdout,/Moneta is running/);
  const db=new DatabaseSync(env.FINANCE_DB_PATH);
  db.exec("PRAGMA busy_timeout=5000;");
  t.after(()=>db.close());
  const add=(id,token)=>db.prepare("INSERT INTO plaid_items(id,item_id,access_token,institution_name) VALUES(?,?,?,?)").run(id,`item-${id}`,token,`Institution ${id}`);
  return {directory,states,env,db,add,launch};
}

test("standalone sync works without a server, retries pending history, and continues after failures",async t=>{
  const f=await fixture(t);
  f.add(1,"access-first");f.add(2,"access-bad");f.add(3,"access-second");
  f.states.statuses=["NOT_READY","HISTORICAL_UPDATE_COMPLETE"];
  const result=await f.launch([join(root,"scripts/sync.mjs")],f.directory).finished;
  assert.equal(result.code,1);
  assert.match(result.stdout,/waiting_for_history/);
  assert.match(result.stdout,/ITEM_LOGIN_REQUIRED/);
  assert.match(result.stdout,/"connections":3,"failed":1/);
  assert.doesNotMatch(result.stdout,/access-first|access-bad|test-secret|Moneta is running/);
  assert.equal(f.states.calls,3);
  assert.deepEqual(f.db.prepare("SELECT id,status,error_code FROM plaid_items ORDER BY id").all().map(row=>({...row})),[
    {id:1,status:"connected",error_code:null},{id:2,status:"sync_error",error_code:"ITEM_LOGIN_REQUIRED"},{id:3,status:"connected",error_code:null}
  ]);
  assert.equal(f.db.prepare("SELECT COUNT(*) count FROM transactions").get().count,2);
  assert.equal(f.db.prepare("SELECT COUNT(*) count FROM plaid_sync_locks").get().count,0);
});

test("standalone and website syncs safely share a database while the server is running",async t=>{
  const f=await fixture(t);f.add(1,"access-first");
  const portServer=createServer();
  await new Promise(resolve=>portServer.listen(0,"127.0.0.1",resolve));
  f.env.PORT=String(portServer.address().port);
  await new Promise(resolve=>portServer.close(resolve));
  const webServer=f.launch([join(root,"server.mjs")]);
  const base=`http://127.0.0.1:${f.env.PORT}`;
  await until(async()=>{try{return (await fetch(`${base}/api/plaid/status`)).ok}catch{return false}});

  let release;
  f.states.block=new Promise(resolve=>release=resolve);
  const entered=new Promise(resolve=>f.states.entered=resolve);
  const web=fetch(`${base}/api/plaid/sync`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({item_id:1})});
  await entered;
  const cli=f.launch([join(root,"scripts/sync.mjs")],f.directory);
  await until(()=>cli.output().includes("waiting_for_sync"));
  // A different process may briefly write to SQLite while Plaid is replying.
  // The page import must wait for that writer rather than fail mid-transaction.
  f.db.exec("BEGIN IMMEDIATE");
  const writerReleased=new Promise(resolve=>setTimeout(()=>{f.db.exec("COMMIT");resolve();},50));
  release();
  await writerReleased;
  const webResponse=await web;
  assert.equal(webResponse.status,200,JSON.stringify(await webResponse.json())+webServer.errorOutput());
  const result=await cli.finished;
  assert.equal(result.code,0,result.stderr);
  assert.doesNotMatch(result.stdout,/Moneta is running/);
  assert.equal(f.db.prepare("SELECT COUNT(*) count FROM transactions").get().count,1);

  f.states.block=new Promise(resolve=>release=resolve);
  const enteredAgain=new Promise(resolve=>f.states.entered=resolve);
  const cliAgain=f.launch([join(root,"scripts/sync.mjs")],f.directory);
  await enteredAgain;
  const overlapping=await fetch(`${base}/api/plaid/sync`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({item_id:1})});
  assert.equal(overlapping.status,202);
  assert.equal((await overlapping.json()).results[0].already_running,true);
  assert.equal(f.db.prepare("SELECT status FROM plaid_items WHERE id=1").get().status,"syncing");
  release();
  assert.equal((await cliAgain.finished).code,0);
  assert.equal(f.db.prepare("SELECT status FROM plaid_items WHERE id=1").get().status,"connected");
  assert.equal(f.db.prepare("SELECT COUNT(*) count FROM transactions").get().count,1);
});

test("sync locks recover dead owners and release after errors",async()=>{
  const db=new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE plaid_items(id INTEGER PRIMARY KEY); INSERT INTO plaid_items VALUES(1);");
    const lock=createSyncLock(db);
    db.prepare("INSERT INTO plaid_sync_locks(plaid_item_id,owner,pid) VALUES(?,?,?)").run(1,"dead-process",2147483647);
    assert.equal(await lock(1,async()=>"recovered"),"recovered");
    await assert.rejects(lock(1,async()=>{throw new Error("test failure")}),/test failure/);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM plaid_sync_locks").get().count,0);
    let release;
    const held=lock(1,()=>new Promise(resolve=>release=resolve));
    await assert.rejects(lock(1,async()=>{}),error=>error.code==="SYNC_IN_PROGRESS");
    release();await held;
  } finally { db.close(); }
});

test("daily sync units use explicit Pacific time, absolute quoted paths, and missed-run catch-up",()=>{
  const units=syncTimerUnits({root:"/tmp/Moneta project%",nodeExecutable:"/usr/bin/node"});
  assert.match(units.timer,/OnCalendar=\*-\*-\* 21:00:00 America\/Los_Angeles/);
  assert.match(units.timer,/Persistent=true/);
  assert.match(units.service,/WorkingDirectory=\/tmp\/Moneta project%%\n/);
  assert.match(units.service,/ExecStart="\/usr\/bin\/node" "\/tmp\/Moneta project%%\/scripts\/sync.mjs"/);
  assert.match(units.service,/UMask=0077/);
  assert.match(syncTimerUnits({root:"/tmp/$Moneta",nodeExecutable:"/usr/bin/node"}).service,/ExecStart="\/usr\/bin\/node" "\/tmp\/\$\$Moneta\/scripts\/sync.mjs"/);
  assert.throws(()=>syncTimerUnits({root:"relative/path",nodeExecutable:"/bin/node"}),/program path/);
  assert.throws(()=>syncTimerUnits({root:"/tmp",nodeExecutable:"/bin/node",time:"25:00"}),/Time/);
  assert.throws(()=>syncTimerUnits({root:"/tmp",nodeExecutable:"/bin/node",timezone:"bad\nTimezone"}),/timezone/);
});
