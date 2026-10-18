// Report projections only: never rewrite the ledger, categories, or balances.
export const PAYCHECK_MODES = new Set(["take-home", "full-paycheck"]);

export function normalizePaycheckReporting(value = {}) {
  const ids = values => Array.isArray(values)
    ? [...new Set(values.map(Number).filter(id => Number.isInteger(id) && id > 0))] : [];
  const contribution_account_ids = ids(value.contribution_account_ids);
  return {
    paycheck_mode: PAYCHECK_MODES.has(value.paycheck_mode) ? value.paycheck_mode : "take-home",
    contribution_account_ids,
    plan_account_ids: [...new Set([...ids(value.plan_account_ids), ...contribution_account_ids])]
  };
}

const action = row => String(row.investment_action || "").toLowerCase();
const subtype = row => String(row.investment_subtype || "").toLowerCase();

export function isContribution(row) {
  // A purchase, generic deposit, or a description containing "contribution"
  // is not evidence of new payroll money. Source account roles are explicit.
  return action(row) === "cash" && subtype(row) === "contribution";
}

function planMovementCategory(row) {
  const type = action(row), detail = subtype(row);
  if (type === "buy") return "Buy";
  if (type === "sell") return "Sell";
  if (type === "transfer") return "Transfer";
  // Preserve actual interest/dividends, which some sources label cash/deposit.
  if (type === "cash" && detail === "deposit" && ["Interest", "Dividends & Capital Gains"].includes(row.category)) return null;
  if (type === "cash" && ["contribution", "deposit", "withdrawal", "rollover", "conversion", "transfer"].includes(detail)) return "Transfer";
  return null;
}

export function projectPaycheckTransactions(rows, configuration, mode = configuration.paycheck_mode) {
  if (mode !== "full-paycheck") return rows;
  const sources = new Set(configuration.contribution_account_ids);
  const plan = new Set(configuration.plan_account_ids);
  return rows.map(row => {
    const contribution = sources.has(row.account_id) && isContribution(row);
    const category = contribution ? "Paychecks" : plan.has(row.account_id) ? planMovementCategory(row) : null;
    if (!category) return row;
    return {
      ...row,
      original_category: row.category,
      category,
      category_group: contribution ? "Income" : "Transfers",
      report_adjustment: contribution ? "payroll_contribution" : "plan_movement"
    };
  });
}
