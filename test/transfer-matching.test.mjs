import test from "node:test";
import assert from "node:assert/strict";
import { findTransferPairs, TRANSFER_MATCH_WINDOW_DAYS } from "../lib/transfer-matching.mjs";
import { bankCashFlowReport } from "../lib/bank-cash-flow.mjs";

const accounts = [
  { id: 1, name: "Checking", type: "checking" },
  { id: 2, name: "Brokerage", type: "investment" },
  { id: 3, name: "Card", type: "credit" }
];
const row = (id, account_id, amount, date, extra = {}) => ({
  id, account_id, amount, date, category: "Transfer", pending: 0, transfer_pair_id: null,
  merchant: "Transfer", ...extra
});
const linked = (rows, pairs) => rows.map(source => {
  const pair = pairs.find(pair => pair.includes(source.id));
  return pair ? { ...source, transfer_pair_id: pair.find(id => id !== source.id) } : { ...source };
});

test("seven-calendar-day matching fixes delayed and cross-month transfers without changing source records", () => {
  assert.equal(TRANSFER_MATCH_WINDOW_DAYS, 7);
  const rows = [
    row(1, 1, -2390.37, "2026-03-27", { ai_categorization_disabled: 1 }),
    row(2, 2, 2390.37, "2026-04-01", { investment_action: "transfer" }),
    row(3, 1, -6412.11, "2026-10-09"),
    row(4, 2, 6412.11, "2026-10-15", { investment_action: "transfer" }),
    row(5, 1, -100, "2026-03-07"),
    row(6, 2, 100, "2026-03-14"), // Inclusive seven-day boundary across DST.
    row(7, 1, -200, "2026-03-07"),
    row(8, 2, 200, "2026-03-15") // Eight days is too far.
  ];
  const snapshot = structuredClone(rows), pairs = findTransferPairs(rows, accounts);
  assert.deepEqual(pairs, [[1, 2], [3, 4], [5, 6]]);
  assert.deepEqual(rows, snapshot);
  const context = linked(rows.slice(0, 4), pairs);
  for (const [from, to, internalIds] of [
    ["2026-03-01", "2026-03-31", [1]],
    ["2026-04-01", "2026-04-30", [2]],
    ["2026-10-01", "2026-10-31", [3, 4]]
  ]) {
    const report = bankCashFlowReport(context, accounts.slice(0, 2), { from, to });
    assert.deepEqual(report.summary.totals, { income: 0, expense: 0, net: 0 });
    assert.deepEqual(report.internal_transfers.map(row => row.id), internalIds);
  }
  assert.equal(bankCashFlowReport(context, [accounts[0]], { from: "2026-03-01", to: "2026-03-31" }).summary.totals.expense, 2390.37);
  const atBoundary = bankCashFlowReport(linked(rows.slice(4, 6), pairs), accounts);
  assert.equal(atBoundary.internal_transfers.length, 2);
  const outsideWindow = bankCashFlowReport(linked(rows.slice(6), [[7, 8]]), accounts);
  assert.equal(outsideWindow.internal_transfers.length, 0);
});

test("both sides must have a unique eligible counterpart, regardless of row order or nearest date", () => {
  const ambiguous = [
    row(1, 1, -100, "2026-10-01"), row(2, 2, 100, "2026-10-02"),
    row(3, 1, -100, "2026-10-04")
  ];
  assert.deepEqual(findTransferPairs(ambiguous, accounts), []);
  assert.deepEqual(findTransferPairs([...ambiguous].reverse(), accounts), []);
  const chain = [
    row(1, 1, -100, "2026-10-01"), row(2, 2, 100, "2026-10-07"),
    row(3, 1, -100, "2026-10-13"), row(4, 2, 100, "2026-10-19")
  ];
  assert.deepEqual(findTransferPairs(chain, accounts), []);
  assert.deepEqual(findTransferPairs([chain[2], chain[0], chain[3], chain[1]], accounts), []);
});

test("equal recurring amounts can match when their windows do not overlap", () => {
  const rows = [
    row(1, 1, -100, "2026-09-01"), row(2, 2, 100, "2026-09-07"),
    row(3, 1, -100, "2026-10-01"), row(4, 2, 100, "2026-10-07")
  ];
  assert.deepEqual(findTransferPairs(rows, accounts), [[1, 2], [3, 4]]);
});

test("only posted cash-transfer categories qualify, not trades, adjustments, or payment descriptions", () => {
  for (const extra of [
    { pending: 1 }, { category: "Buy" }, { category: "Sell" }, { category: "Balance Adjustments" },
    { category: "Groceries", merchant: "Credit card payment" },
    { category: "Paychecks", merchant: "Payment" },
    { investment_action: "buy" }, { investment_action: " SELL " },
    { category: "Credit Card Payment" }
  ]) {
    const rows = [row(1, 1, -100, "2026-10-01"), row(2, 2, 100, "2026-10-02", extra)];
    assert.deepEqual(findTransferPairs(rows, accounts), []);
    assert.equal(bankCashFlowReport(linked(rows, [[1, 2]]), accounts).internal_transfers.length, 0);
  }
});

test("credit-card payments match only when one of the two accounts is a card", () => {
  for (const category of ["Transfer", "Credit Card Payment"]) {
    const rows = [row(1, 1, -100, "2026-10-01", { category }), row(2, 3, 100, "2026-10-08", { category: "Credit Card Payment" })];
    assert.deepEqual(findTransferPairs(rows, accounts), [[1, 2]]);
    assert.equal(bankCashFlowReport(linked(rows, [[1, 2]]), accounts).internal_transfers.length, 2);
  }
  // An unrelated selected card must not legitimize a bank/brokerage payment pair.
  assert.deepEqual(findTransferPairs([
    row(1, 1, -100, "2026-10-01", { category: "Credit Card Payment" }), row(2, 2, 100, "2026-10-02")
  ], accounts), []);
});

test("existing links are preserved and cannot be reused by new matching", () => {
  const rows = [
    row(1, 1, -100, "2026-10-01", { transfer_pair_id: 2 }),
    row(2, 2, 100, "2026-10-02", { transfer_pair_id: 1 }),
    row(3, 1, -100, "2026-10-01"), row(4, 2, 100, "2026-10-03"),
    row(5, 1, -200, "2026-10-01", { transfer_pair_id: 999 }),
    row(6, 2, 200, "2026-10-02")
  ];
  const snapshot = structuredClone(rows);
  assert.deepEqual(findTransferPairs(rows, accounts), [[3, 4]]);
  assert.deepEqual(rows, snapshot);
});

test("invalid dates, amounts, account IDs, and same-account movements do not match", () => {
  const baseline = row(1, 1, -100, "2026-03-01");
  for (const extra of [
    { date: "2026-02-30" }, { date: "03/02/2026" }, { date: "2026-03-02T00:00:00Z" },
    { amount: NaN }, { amount: Infinity }, { amount: null }, { amount: 0 }, { amount: 99.99 },
    { amount: -100 }, { account_id: 999 }, { account_id: 1 }
  ]) assert.deepEqual(findTransferPairs([baseline, row(2, 2, 100, "2026-03-02", extra)], accounts), []);
  assert.deepEqual(findTransferPairs([
    row(1, 1, -0.1 - 0.2, "2026-03-01"), row(2, 2, 0.3, "2026-03-02")
  ], accounts), [[1, 2]]);
});
