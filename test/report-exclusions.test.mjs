import test from "node:test";
import assert from "node:assert/strict";
import { normalizeExclusionRules, exclusionMatcher } from "../lib/report-exclusions.mjs";

const condition=(field,operator,value)=>({field,operator,value});
const rule=(conditions,extra={})=>({name:"Test rule",enabled:true,conditions,...extra});
const row={id:1,date:"2026-09-10",merchant:"Example Store",report_description:"ORIGINAL source detail",note:"Lunch refund",report_memo:"Shared bill",amount:-50,account_id:7,category:"Groceries",category_group:"Food & Dining",institution:"Test Bank"};

test("exclusion rules AND their conditions, OR separate rules, and ignore disabled rules",()=>{
  const rules=[rule([condition("description","contains","example"),condition("amount","lte",-50)],{name:"Matching rule"}),
    rule([condition("description","contains","example"),condition("account_id","eq",8)]),
    rule([condition("note","contains","shared")],{name:"Second match"}),
    rule([condition("amount","eq",-50)],{name:"Disabled",enabled:false})];
  const snapshot=structuredClone(rules);
  assert.deepEqual(exclusionMatcher(rules)(row),["Matching rule","Second match"]);
  assert.deepEqual(rules,snapshot);
  assert.deepEqual(exclusionMatcher([])(row),[]);
});

test("description comparisons use literal case-insensitive displayed and original text, not regex",()=>{
  for(const [operator,value] of [["contains","SOURCE"],["eq","Original SOURCE detail"],["starts_with","ORIGINAL"],["ends_with","DETAIL"],["not_contains","unrelated"],["neq","other"]]){
    assert.equal(exclusionMatcher([rule([condition("description",operator,value)])])(row).length,1);
  }
  assert.equal(exclusionMatcher([rule([condition("description","not_contains","STORE")])])(row).length,0);
  assert.equal(exclusionMatcher([rule([condition("description","neq","EXAMPLE STORE")])])(row).length,0);
  assert.equal(exclusionMatcher([rule([condition("description","contains",".*")])])(row).length,0);
  assert.equal(exclusionMatcher([rule([condition("description","contains","[.*]")])])({...row,merchant:"Text [.*] literal"}).length,1);
});

test("numeric, account, date, category and group conditions use source values including zero",()=>{
  const conditions=[condition("amount","lt",0),condition("absolute_amount","eq",50),condition("account_id","eq",7),condition("date","gte","2026-09-01"),condition("date","lt","2026-10-01"),condition("category","eq","groceries"),condition("category_group","neq","Income"),condition("institution","contains","BANK")];
  assert.equal(exclusionMatcher([rule(conditions)])(row).length,1);
  assert.equal(exclusionMatcher([rule([condition("amount","eq",0)])])({...row,amount:0}).length,1);
  assert.equal(exclusionMatcher([rule([condition("amount","gt",0)])])(row).length,0);
  assert.equal(exclusionMatcher([rule([condition("date","lte","2026-09-09")])])(row).length,0);
});

test("invalid or empty conditions cannot accidentally exclude everything",()=>{
  const invalid=[null,{},rule([]),rule([condition("description","contains","")]),rule([condition("description","regex",".*")]),
    rule([condition("amount","eq","")]),rule([condition("amount","eq",null)]),rule([condition("absolute_amount","eq",-1)]),
    rule([condition("date","eq","2026-02-30")]),rule([condition("date","eq","09/10/2026")]),rule([condition("account_id","eq",0)]),
    rule([condition("amount","eq",true)]),rule([condition("unknown","eq","x")]),rule([condition("__proto__","eq","x")]),rule([condition("constructor","eq","x")]),rule([condition("note","contains","x")],{enabled:"false"}),
    rule([condition("description","contains","valid"),condition("amount","eq","")])];
  for(const value of invalid){
    assert.throws(()=>normalizeExclusionRules([value],{strict:true}));
    assert.deepEqual(exclusionMatcher([value])(row),[]);
  }
  assert.throws(()=>normalizeExclusionRules("invalid",{strict:true}));
  assert.throws(()=>normalizeExclusionRules(Array.from({length:31},()=>rule([condition("amount","eq",1)])),{strict:true}));
  assert.throws(()=>normalizeExclusionRules([rule(Array.from({length:11},()=>condition("amount","eq",1)))],{strict:true}));
  assert.throws(()=>normalizeExclusionRules([rule([condition("description","contains","x".repeat(501))])],{strict:true}));
});
