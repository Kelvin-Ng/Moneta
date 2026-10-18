import test from "node:test";
import assert from "node:assert/strict";
import { normalizePaycheckReporting, projectPaycheckTransactions } from "../lib/paycheck-reporting.mjs";

const configuration=normalizePaycheckReporting({paycheck_mode:"full-paycheck",contribution_account_ids:[1],plan_account_ids:[2,3]});
const row=(id,account_id,amount,category,investment_action,investment_subtype)=>({
  id,account_id,amount,category,category_group:category==="Paychecks"?"Income":"Transfers",investment_action,investment_subtype
});

test("full-paycheck counts the payroll entry once, not subsequent plan transfers or purchases",()=>{
  const rows=[
    row(1,4,5500,"Paychecks"),
    row(2,1,2000,"Transfer","cash","contribution"),
    row(3,1,0,"Transfer","cash","withdrawal"),
    row(4,2,2000,"Paychecks","cash","deposit"), // Bad AI category must not double income.
    row(5,2,-2000,"Miscellaneous","buy","buy"),
    row(6,3,500,"Paychecks","cash","deposit"),
    row(7,3,-500,"Miscellaneous","transfer","transfer"),
    row(8,5,7000,"Transfer","cash","contribution") // Self-funded IRA, outside the plan.
  ];
  const original=structuredClone(rows),projected=projectPaycheckTransactions(rows,configuration);
  assert.equal(projected.filter(row=>row.category_group==="Income").reduce((sum,row)=>sum+row.amount,0),7500);
  assert.equal(projected.filter(row=>row.report_adjustment==="payroll_contribution").length,1);
  assert.equal(projected.find(row=>row.id===4).category,"Transfer");
  assert.equal(projected.find(row=>row.id===5).category,"Buy");
  assert.equal(projected.find(row=>row.id===8).category,"Transfer");
  assert.deepEqual(rows,original);
  assert.equal(projectPaycheckTransactions(rows,configuration,"take-home"),rows);
});

test("only explicit cash contributions count; corrections subtract and existing income is not duplicated",()=>{
  const rows=[
    row(1,1,2000,"Paychecks","cash","contribution"),
    row(2,1,-100,"Transfer","cash","contribution"),
    row(3,1,2000,"Transfer","cash","deposit"),
    row(4,1,-2000,"Transfer","buy","contribution"),
    {...row(5,1,2000,"Transfer"),merchant:"Payroll contribution"},
    row(6,1,2000,"Paychecks","cash","rollover"),
    row(7,2,20,"Dividends & Capital Gains","cash","deposit"),
    row(8,2,2000,"Dividends & Capital Gains","cash","contribution")
  ];
  const projected=projectPaycheckTransactions(rows,configuration);
  assert.equal(projected.length,rows.length);
  assert.equal(projected.filter(row=>row.category==="Paychecks").reduce((sum,row)=>sum+row.amount,0),1900);
  assert.equal(projected.find(row=>row.id===7).category,"Dividends & Capital Gains");
  assert.equal(projected.find(row=>row.id===8).category,"Transfer");
});

test("configuration defaults to take-home and includes contribution sources within the plan",()=>{
  assert.deepEqual(normalizePaycheckReporting(),{paycheck_mode:"take-home",contribution_account_ids:[],plan_account_ids:[]});
  assert.deepEqual(normalizePaycheckReporting({paycheck_mode:"other",contribution_account_ids:[1,1,"2",-1],plan_account_ids:[3,1]}),{
    paycheck_mode:"take-home",contribution_account_ids:[1,2],plan_account_ids:[3,1,2]
  });
});
