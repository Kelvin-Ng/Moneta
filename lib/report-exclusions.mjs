const textOperators=new Set(["contains","not_contains","eq","neq","starts_with","ends_with"]);
const orderedOperators=new Set(["eq","neq","lt","lte","gt","gte"]);
const fields={description:textOperators,note:textOperators,institution:textOperators,
  category:new Set(["eq","neq"]),category_group:new Set(["eq","neq"]),
  account_id:new Set(["eq","neq"]),amount:orderedOperators,absolute_amount:orderedOperators,date:orderedOperators};
const text=value=>String(value??"").normalize("NFKC").toLocaleLowerCase("en-US");

export function normalizeExclusionRules(value,{strict=false}={}) {
  const fail=message=>{if(strict)throw new Error(message)};
  if(value===undefined)return [];
  if(!Array.isArray(value)){fail("Exclusions must be a list of rules.");return []}
  if(value.length>30){fail("Use at most 30 exclusion rules.");return []}
  const rules=[];
  value.forEach((rule,index)=>{
    const label=`Exclusion rule ${index+1}`;
    if(!rule||typeof rule!=="object"||!Array.isArray(rule.conditions)||!rule.conditions.length||rule.conditions.length>10){
      fail(`${label} needs 1–10 conditions.`);return;
    }
    if(rule.enabled!==undefined&&typeof rule.enabled!=="boolean"){
      fail(`${label} enabled must be true or false.`);return;
    }
    const conditions=[];
    for(const condition of rule.conditions){
      if(!condition||!Object.hasOwn(fields,condition.field)||!fields[condition.field].has(condition.operator)){
        fail(`${label} has an unsupported field or comparison.`);return;
      }
      let normalized=condition.value;
      if(["amount","absolute_amount","account_id"].includes(condition.field)){
        if(normalized===null||normalized===undefined||typeof normalized==="boolean"||typeof normalized==="object"||String(normalized).trim()===""||!Number.isFinite(Number(normalized))){
          fail(`${label} needs a numeric value.`);return;
        }
        normalized=Number(normalized);
        if(condition.field==="account_id"&&(!Number.isInteger(normalized)||normalized<=0)){
          fail(`${label} needs a valid account ID.`);return;
        }
        if(condition.field==="absolute_amount"&&normalized<0){fail(`${label} needs a nonnegative absolute amount.`);return}
      }else{
        if(typeof normalized!=="string"||!normalized.trim()||normalized.length>500){
          fail(`${label} needs a nonempty text value of at most 500 characters.`);return;
        }
        normalized=normalized.trim();
        if(condition.field==="date"){
          const date=new Date(`${normalized}T00:00:00Z`);
          if(!/^\d{4}-\d{2}-\d{2}$/.test(normalized)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==normalized){
            fail(`${label} needs a valid ISO calendar date (YYYY-MM-DD).`);return;
          }
        }
      }
      conditions.push({field:condition.field,operator:condition.operator,value:normalized});
    }
    rules.push({name:String(rule.name||`Rule ${index+1}`).trim().slice(0,80)||`Rule ${index+1}`,enabled:rule.enabled!==false,conditions});
  });
  return rules;
}

function conditionMatches(row,{field,operator,value},cache) {
  if(["amount","absolute_amount","account_id","date"].includes(field)){
    const actual=field==="absolute_amount"?Math.abs(Number(row.amount)):field==="date"?row.date:Number(row[field]);
    if(actual===undefined||(typeof actual==="number"&&!Number.isFinite(actual)))return false;
    return operator==="eq"?actual===value:operator==="neq"?actual!==value:operator==="lt"?actual<value:operator==="lte"?actual<=value:operator==="gt"?actual>value:actual>=value;
  }
  // Description means both the displayed description and the original source
  // description; CSV merchant and description need not be the same column.
  if(!cache.has(field)){
    const values=field==="description"?[row.merchant,row.report_description]:field==="note"?[row.note,row.report_memo]:[row[field]];
    cache.set(field,values.map(text));
  }
  const matches=cache.get(field).some(actual=>operator==="contains"||operator==="not_contains"?actual.includes(value)
    :operator==="starts_with"?actual.startsWith(value):operator==="ends_with"?actual.endsWith(value):actual===value);
  return ["neq","not_contains"].includes(operator)?!matches:matches;
}

export function exclusionMatcher(rules) {
  const active=normalizeExclusionRules(rules).filter(rule=>rule.enabled).map(rule=>({...rule,conditions:rule.conditions.map(condition=>
    ["amount","absolute_amount","account_id","date"].includes(condition.field)?condition:{...condition,value:text(condition.value)})}));
  if(!active.length)return ()=>[];
  // Every condition within one rule must match. Any matching rule excludes.
  return row=>{
    const cache=new Map();
    return active.filter(rule=>rule.conditions.every(condition=>conditionMatches(row,condition,cache))).map(rule=>rule.name);
  };
}
