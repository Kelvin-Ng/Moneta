// Calendar dates are compared as labelled, independently of the local timezone.
export const TRANSFER_MATCH_WINDOW_DAYS = 7;
const TRANSFER_CATEGORIES = new Set(["Transfer", "Credit Card Payment"]);

export function investmentTrade(row, account) {
  if (account?.type !== "investment") return false;
  const action = String(row.investment_action || "").trim().toLowerCase();
  return ["buy", "sell"].includes(action) || (!action && ["Buy", "Sell"].includes(row.category));
}

function calendarDay(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date ? time / 86400000 : NaN;
}

function cents(row) {
  if (row.amount === null || row.amount === undefined || row.amount === "") return NaN;
  const amount = Math.round(Number(row.amount) * 100);
  return Number.isSafeInteger(amount) ? amount : NaN;
}

function eligible(row, byAccount) {
  const account = byAccount.get(row.account_id);
  return Boolean(account && !row.pending && TRANSFER_CATEGORIES.has(row.category)
    && !investmentTrade(row, account) && cents(row) && Number.isFinite(calendarDay(row.date)));
}

// Used both when creating links and when validating stored links for a report.
// Link reciprocity and the selected reporting boundary are checked by the caller.
export function transferPairEligible(row, peer, byAccount) {
  if (!row || !peer || row.id === peer.id || row.account_id === peer.account_id) return false;
  if (!eligible(row, byAccount) || !eligible(peer, byAccount)) return false;
  const credit = [byAccount.get(row.account_id), byAccount.get(peer.account_id)].some(account => account.type === "credit");
  if (!credit && (row.category !== "Transfer" || peer.category !== "Transfer")) return false;
  return cents(row) === -cents(peer)
    && Math.abs(calendarDay(row.date) - calendarDay(peer.date)) <= TRANSFER_MATCH_WINDOW_DAYS;
}

export function findTransferPairs(rows, accounts) {
  const byAccount = new Map(accounts.map(account => [account.id, account]));
  const candidates = rows.filter(row => row.transfer_pair_id == null && eligible(row, byAccount));
  const byAmount = new Map();
  for (const row of candidates) {
    const amount = cents(row), bucket = byAmount.get(amount) || [];
    bucket.push(row);
    byAmount.set(amount, bucket);
  }

  // Compute all choices from the same snapshot. Never pick the first or nearest
  // equal amount, or remove a matched pair to manufacture uniqueness elsewhere.
  const choices = new Map();
  for (const row of candidates) {
    choices.set(row.id, (byAmount.get(-cents(row)) || []).filter(peer => transferPairEligible(row, peer, byAccount)));
  }
  const pairs = [];
  for (const row of candidates) {
    const peers = choices.get(row.id);
    if (peers.length !== 1) continue;
    const peer = peers[0], reverse = choices.get(peer.id);
    if (row.id < peer.id && reverse.length === 1 && reverse[0].id === row.id) pairs.push([row.id, peer.id]);
  }
  return pairs;
}
