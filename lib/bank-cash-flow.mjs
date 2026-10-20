// An account-boundary report projection. Stored categories and links stay intact.
import { normalizeExclusionRules, exclusionMatcher } from "./report-exclusions.mjs";
import { investmentTrade, transferPairEligible } from "./transfer-matching.mjs";
export const CASH_FLOW_MODES = new Set(["transactions", "bank-endpoints"]);
export const ENDPOINT_ACCOUNT_TYPES = new Set(["checking", "savings", "cash", "investment", "credit"]);

export function normalizeCashFlowConfiguration(value = {}) {
  const source=value && typeof value === "object" ? value : {};
  const exclusions=normalizeExclusionRules(source.exclusions);
  return {
    mode:CASH_FLOW_MODES.has(source.mode)?source.mode:"transactions",
    endpoint_account_ids:Array.isArray(source.endpoint_account_ids)
      ? [...new Set(source.endpoint_account_ids.map(Number).filter(id=>Number.isInteger(id)&&id>0))] : [],
    ...(exclusions.length?{exclusions}:{})
  };
}

function internalPair(row,peer,endpoints,byAccount) {
  // Existing automatic links are heuristic. Do not let a stale, one-way,
  // same-sign, pending, or non-transfer link silently hide a cash movement.
  if(!peer||peer.id===row.id||peer.transfer_pair_id!==row.id||row.account_id===peer.account_id)return false;
  return endpoints.has(peer.account_id)&&transferPairEligible(row,peer,byAccount);
}

export function bankCashFlowReport(rows,accounts,filters={}) {
  const endpoints=new Set(accounts.map(account=>account.id));
  const byId=new Map(rows.map(row=>[row.id,row]));
  const byAccount=new Map(accounts.map(account=>[account.id,account]));
  const hasCreditEndpoint=accounts.some(account=>account.type==="credit");
  const nameCounts=new Map();
  accounts.forEach(account=>nameCounts.set(account.name,(nameCounts.get(account.name)||0)+1));
  const categories=new Set(filters.categories||[]),search=String(filters.search||"").toLocaleLowerCase("en-US");
  const visible=row=>(!filters.from||row.date>=filters.from)&&(!filters.to||row.date<=filters.to)
    &&(!categories.size||categories.has(row.category))
    &&(!search||[row.merchant,row.category,row.note].some(value=>String(value||"").toLocaleLowerCase("en-US").includes(search)));
  const transactions=[],internal_transfers=[],investment_activity=[],excluded_transactions=[];
  const excludedBy=exclusionMatcher(filters.exclusions);
  let pending_count=0,unmatched_transfer_count=0;
  for(const row of rows){
    if(!endpoints.has(row.account_id)||!Number.isFinite(Number(row.amount)))continue;
    const account=byAccount.get(row.account_id);
    const endpoint_name=nameCounts.get(account.name)>1?`${account.name} · ${account.institution} (#${account.id})`:account.name;
    const projected={...row,amount:Number(row.amount),endpoint_name,report_adjustment:"bank_cash_movement"};
    const trade=investmentTrade(row,account),fee=trade?Number(row.investment_fees)||0:0;
    const feeRow=Number.isFinite(fee)&&fee?{...projected,amount:-fee,category:"Financial Fees",category_group:"Financial",report_component:"trade_fee",original_category:row.category,original_amount:row.amount}:null;
    const reasons=excludedBy(row);
    // Keep the full byId context above: excluding one side must not turn the
    // other side of an internal transfer into external income or an expense.
    if(reasons.length){
      if(visible(row)||(feeRow&&visible(feeRow)))excluded_transactions.push({...projected,excluded_by:reasons});
      continue;
    }
    if(trade){
      if(row.pending){if(visible(row))pending_count++;continue}
      if(visible(row))investment_activity.push(projected);
      // Trades swap assets inside an investment account. Only an explicitly
      // reported embedded fee crosses the boundary; never count trade principal.
      if(feeRow&&visible(feeRow))transactions.push(feeRow);
      continue;
    }
    if(!visible(row)||!Number(row.amount))continue;
    if(row.pending){pending_count++;continue}
    const peer=byId.get(row.transfer_pair_id);
    if(internalPair(row,peer,endpoints,byAccount)){
      internal_transfers.push({...projected,counterpart_account_name:byAccount.get(peer.account_id).name});
      continue;
    }
    if((row.category==="Transfer"||(hasCreditEndpoint&&row.category==="Credit Card Payment"))&&(!peer||peer.transfer_pair_id!==row.id))unmatched_transfer_count++;
    transactions.push(projected);
  }
  const totals={income:0,expense:0,net:0},months=new Map();
  for(const row of transactions){
    const month=row.date.slice(0,7),values=months.get(month)||{month,income:0,expense:0};
    if(row.amount>0){totals.income+=row.amount;values.income+=row.amount}
    else{totals.expense-=row.amount;values.expense-=row.amount}
    months.set(month,values);
  }
  const round=value=>Math.round(value*100)/100;
  totals.income=round(totals.income);totals.expense=round(totals.expense);totals.net=round(totals.income-totals.expense);
  return {transactions,internal_transfers,investment_activity,excluded_transactions,pending_count,unmatched_transfer_count,summary:{totals,
    months:[...months.values()].sort((a,b)=>a.month.localeCompare(b.month)).map(row=>({...row,income:round(row.income),expense:round(row.expense)}))}};
}
