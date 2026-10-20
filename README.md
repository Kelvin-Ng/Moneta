# Moneta

Moneta is a private, local-first personal finance dashboard for one user. It
combines bank accounts, credit cards, cash, and investments in a single SQLite
database and can import financial data through Plaid or CSV.

## Features

- Unified activity classified by category group: Income, Transfers, or expenses
- Plaid connections for supported banks, cards, and brokerages, including on-demand investment refreshes
- Standalone account sync and optional daily scheduling, independent of the web server
- Optional account nicknames shown throughout reports, filters, and transaction lists
- Credit-card payments and transfers excluded by category; automatic pairing keeps categories unchanged
- Monarch-style category groups and categories
- Batched AI categorization with provider-neutral rules and re-categorization
- Filterable cash-flow totals, monthly bar chart, and interactive Sankey report
- Account-endpoint cash-flow mode with a configurable boundary including bank, investment, cash, and credit-card accounts
- Conditional cash-flow exclusions with an inspectable match list and saved-view support
- Take-home or full-paycheck reporting (take-home plus payroll retirement contributions), with explicit plan-account roles to avoid counting internal movements twice
- Daily net-worth history that uses source-labelled dates directly, preserves
  partial earlier history, and requires complete selected-account coverage only
  for the newest historical date
- A current net-worth point calculated from the latest institution-reported
  account balances; earlier investment history uses daily closing prices
- Auditable inferred-zero closes for successfully synced, always-empty
  investment accounts with no holdings, ledger activity, or prior nonzero value;
  the zero carries forward until contradictory Plaid data invalidates it
- Saved report views whose values are recalculated from current data
- Local SQLite persistence with no application login

Every main page has a direct URL, including `/overview`, `/cash-flow`,
`/net-worth`, `/transactions`, `/accounts`, `/insights`, and `/settings`.

On the cash-flow report, click a month in the bar chart to filter the totals,
Sankey, and transaction details to that month within the active report filters.
The bar chart retains all months in the date range for comparison. Click the
selected month again to clear the month filter. Saved views remember the month
filter as part of their configuration.

### Account cash flow

On **Cash flow → View**, choose **Account cash flow**, select your endpoint accounts,
and click **Apply endpoints**. All account types can be endpoints: checking, savings,
cash, investments, and credit cards. Selected accounts define the reporting boundary.
For example, select both Wealthfront and Robinhood to treat matched funding transfers
as internal movements rather than cash outflows. Leave Robinhood unchecked to see
investment funding as money leaving your bank-only boundary. Endpoint selection is
explicit, so an unconfigured view asks you to choose accounts rather than guessing.

This mode measures cash crossing the selected account boundary:

- Posted positive amounts are cash inflows; negative amounts are cash outflows.
  Refunds are inflows, not reductions to spending. These are not taxable-income or
  expense totals.
- With bank-only endpoints, credit-card payments count on the bank posting date;
  purchases on unselected cards do not appear. Include a card to count its actual
  purchases and exclude matched payments between that card and other selected
  accounts. Leave Venmo/PayPal wallets unchecked if you want funding-bank entries
  rather than activity within the wallets. Pending entries are excluded.
- Investment buys, sells, and reinvestment trades exchange assets inside the account
  and are excluded. The excluded trades remain inspectable. Explicitly reported
  embedded trading fees are included as Financial Fees; separately posted fees,
  interest, dividends, and external contributions still count. Source investment
  metadata identifies trades, with Buy/Sell categories as a fallback when metadata
  is unavailable. Market-value changes are not cash flow. Payroll contributions
  count only when recorded in a selected account; the full-paycheck projection
  applies only to the regular transaction-based report.
- Reciprocally paired **Transfer** entries between selected endpoints are excluded
  from headline totals. The links must connect different accounts, have opposite
  amounts, and post within seven calendar days. Both entries must be posted and categorized
  Transfer, or Transfer/Credit Card Payment when a selected card is involved.
  Peer context is checked outside the visible date/category/search
  filters, including across month boundaries. The exclusion list remains available
  to inspect; categories and pairing metadata are never rewritten by reporting.
- Automatic matching links only posted, non-trade transfers where each entry has
  exactly one eligible counterpart in the seven-day window. Repeated amounts with
  multiple possible matches are left unmatched rather than guessed. Existing links
  are preserved. Matching never changes categories or AI-protection settings.
- Transfers to an account outside the selected boundary count as cash crossing
  that boundary. Unpaired Transfer entries remain included and are called out;
  equal amounts alone are not grounds to discard a movement.

The endpoint table shows inflows, outflows, internal-transfer net, and total posted
cash movement per account. Different posting dates can leave cash in transit.
Monthly bars, account-based Sankey nodes, and drill-down lists use the same endpoint
cash-flow data. Click an account node or flow to inspect its transactions. Clicking
a month also updates the endpoint table without hiding the other monthly bars.
Account filters narrow the endpoint boundary; category and search filters narrow
the displayed movements using their stored categories and descriptions.

The mode and endpoint choices persist in SQLite and can be saved in a report view.
Overview, transaction activity, net-worth reporting, and AI categorization are
unchanged.

### Exclude transactions from cash-flow reports

Open **Cash flow → Exclude transactions**, add a rule, and click **Apply exclusions**.
For example: **Description contains "Example Merchant" AND Account equals "Checking"**.
All conditions in a rule must match (AND); any matching rule excludes the transaction
(OR). Rules can be named, disabled, edited, or removed. Remove all rules and apply to
clear exclusions. Apply draft changes before saving a view.

Conditions support description, note/memo, institution, account, category, category
group, date, signed amount, and absolute amount. Text supports contains, does not
contain, equals, does not equal, starts with, and ends with. Text comparisons are
literal and case-insensitive, not regular expressions. Numeric/date comparisons
support equality and ordered comparisons; dates use ISO calendar dates. Up to 30
rules with 10 conditions each are supported.

Rules match the stored/source transaction fields before full-paycheck or investment
fee projections. Description matching checks both the displayed description and the
original Plaid/CSV description; memo matching also checks the source memo. Excluding
an investment trade removes its projected trading fee too. Transfer matching retains
its complete peer context, so excluding one internal-transfer leg cannot turn the
other leg into external income or an expense.

Both transaction and account-endpoint cash-flow modes apply the rules consistently
to totals, monthly bars, Sankey, account summaries, and drill-down lists. Expand
**Inspect transactions excluded by rules** to see source transactions and matched
rule names under the current filters and selected month. Rules persist locally in
SQLite and are included in saved report configurations; matches are recalculated
from current data. Overview, activity, stored categories, AI protection, and net
worth are unchanged. A view with no exclusions does not inherit another report's
rules. Report configurations are sent in a read-only POST request body, avoiding
URL-length limits for larger rule sets.

### Paycheck reporting

Use the **Paycheck reporting** selector in the toolbar to choose:

- **Take-home**: report the stored transaction categories as usual.
- **Full paycheck**: include take-home pay plus payroll retirement contributions.
  This is not gross salary; withheld taxes and benefits are not inferred.

In **Settings → Paycheck reporting**, identify your retirement-plan accounts.
Mark the account where payroll contributions first arrive as **Contribution
source**. Mark downstream accounts, such as BrokerageLink, as **Within plan**.
Only explicit cash/contribution events in a contribution-source account become
Paychecks in full-paycheck reports. Generic deposits, withdrawals, transfers,
and trades within the configured plan remain transfers, preventing a contribution
from being counted again when it moves or is invested. Contribution corrections
reduce income. Interest and dividends retain their income categories. Do not
select a self-funded IRA as a payroll contribution source.

This requires structured investment-action/subtype metadata from Plaid or mapped
CSV columns; descriptions alone are not used to infer payroll income. Select only
one entry point for each contribution stream, not every account receiving it.
All report filters, chart totals, Sankey flows, and drill-down lists use the same
reporting mode. Account filters still apply, so excluding the contribution-source
account excludes its payroll contributions. Mode and account roles are stored in
SQLite; saved report views also remember their own reporting mode. No stored
transaction categories, AI protection flags, or net-worth balances are changed.

## Requirements

- Node.js 22.5 or newer; Node.js 24 is recommended
- A Plaid developer account only if you want automatic account connections
- An AI provider or compatible local model server only if you want AI categorization

The only third-party runtime dependency is the official TOON encoder used to
compact transaction evidence sent to an AI provider.

## Quick start

```bash
npm install
npm start
```

Open [http://localhost:4173](http://localhost:4173).

On its first run, Moneta creates `finance.db` beside `server.mjs`, creates the
database schema, and leaves the database empty. Accounts and transactions are
not generated automatically.

To explore the application with sample data:

1. Open **Settings**.
2. Select **Generate demo data**.

This adds four local demo accounts and 25 recent sample transactions. The action
does not modify existing records and is safe to run repeatedly without creating
duplicates.

For automatic restart during development, use:

```bash
npm run dev
```

## Configure Plaid

Plaid configuration is managed from Moneta's Settings page:

1. Create an account in the [Plaid dashboard](https://dashboard.plaid.com/).
2. Open **Settings → Plaid configuration**.
3. Select **Sandbox** and enter your Plaid client ID and Sandbox secret.
4. Save the settings.
5. Open **Accounts → Connect account**.

Plaid settings take effect immediately; the server does not need to be restarted.
The secret is stored in SQLite and is not returned to the browser after it has
been saved.

Use Sandbox while testing. Switch to Development or Production only after Plaid
has granted the corresponding access, and save the matching secret for that
environment.

### OAuth redirect URI

The redirect URI is usually left blank for local Sandbox connections. OAuth
institutions in Development or Production require an exact HTTPS redirect URI:

1. Register the URI in the Plaid dashboard.
2. Enter the identical URI in Moneta's Settings page.

The URI cannot contain a query string or fragment. HTTP localhost redirect URIs
are accepted only in Sandbox.

### Re-authenticate a connection

When Plaid reports that a connection needs renewed credentials, MFA, or consent,
the affected account cards show **Re-authenticate** instead of **Retry sync**.
Complete the institution's Plaid Link flow; Moneta keeps the existing Plaid Item,
accounts, nicknames, and transaction history, then starts a background sync
automatically. OAuth re-authentication uses the configured redirect URI and can
resume after the browser returns to Moneta.

### Unattended sync

Sync every saved Plaid connection without opening the website:

```bash
npm run sync
```

The command uses the same database, Plaid settings, transaction cursors,
investment refreshes, transfer matching, and optional AI categorization as the
website. Transfer matching only links transactions for reconciliation; it never
changes categories or AI/manual categorization metadata. Regular transaction-report
totals depend on category groups; account-endpoint reports also use validated links
to exclude internal transfers. It works whether the web server is
running or stopped and can be run from any directory with
`node /absolute/path/to/Moneta/scripts/sync.mjs`.
Per-connection database locks prevent simultaneous jobs from importing from the
same cursor; locks left by terminated processes are recovered automatically.
Incomplete initial history is retried, and a failed connection does not prevent
the remaining connections from syncing. The command prints timestamped JSON
progress and exits nonzero for sync or categorization failures. Connections that
need renewed login or consent still require **Re-authenticate** in the website.

On Linux with systemd, install a daily user timer:

```bash
npm run sync:schedule
```

The default schedule is **9:00 PM America/Los_Angeles**, following Pacific
daylight-saving changes. `Persistent=true` runs a missed job when the user
scheduler next becomes available; the machine does not need the web server
running. To change the schedule, run the installer again with, for example,
`npm run sync:schedule -- --time=08:00 --timezone=America/New_York`.

```bash
systemctl --user list-timers moneta-sync.timer
journalctl --user -u moneta-sync.service
systemctl --user start moneta-sync.service       # Run now
systemctl --user disable --now moneta-sync.timer # Stop daily scheduling
```

To keep the user scheduler running while logged out, enable lingering with
`loginctl enable-linger "$USER"` (administrator approval may be required).
The timer's program and project paths are captured at installation; rerun the
installer if you move the project or change the Node.js installation. Scheduled
sync reads `.env` beside `server.mjs`, just like the server. Put a custom
`FINANCE_DB_PATH` there so unattended runs use the intended database.

For cron or another scheduler, invoke the absolute Node.js and script paths.
Scheduling requires the machine to be on and network access to be available.

## Configure AI categorization

AI categorization is optional and disabled until a provider is configured. Open
**Settings → AI provider** and choose one of these protocols:

- OpenAI Responses
- OpenAI-compatible Chat Completions, including compatible hosted gateways or
  local servers
- Anthropic Messages
- Google Gemini

Enter the API endpoint, provider model ID, and an API key when the provider
requires one. Moneta does not lock categorization to a specific model or vendor;
provider-specific request formatting is isolated behind adapters, while the
prompt, supported categories, validation, batching, and database state are
shared.

Natural-language rules can be added in the same form. For example:

```text
Transactions from Acme Payroll are Paychecks.
Payments recorded in a peer-to-peer account with lunch or dinner memos are Restaurants & Bars; source-bank funding entries are Transfer.
```

Rules can be scoped to the account's institution and type. The institution
identifies where the account is held, not the merchant or recipient. Relevant
user rules take precedence over the prompt's general guidance and source
category hints.

New uncategorized transactions retain a deterministic fallback category until
AI categorization succeeds. Moneta sends multiple pending transactions together,
up to 50 per provider request. Failed requests keep the existing category and
can be retried with **Categorize pending**. Categories explicitly selected by a
user are authoritative. Use **Re-categorize all** after changing models or rules
when you intentionally want to replace existing categories.

Manual entry and CSV import offer a **Protect category from AI** option.
Protected transactions are persistently excluded from automatic categorization,
**Categorize pending**, explicit AI requests, and **Re-categorize all**. Their
categories can still be changed manually.

The Settings page shows live processed, categorized, failed, and request counts
while a run is active. Every provider response must contain exactly the requested
transaction IDs. If a provider reaches its output limit or omits transactions,
Moneta retries the affected records in smaller batches, with a bounded attempt
limit. Authentication failures, outages, and other systemic errors stop the run
instead of continuing through the remaining batches. Anthropic thinking is
disabled for this classification workload so it cannot consume the JSON output
budget.

The complete source payload received for each new Plaid, CSV, demo, or manual
transaction is stored locally for future re-categorization. It is not sent to
the AI provider. Moneta extracts a compact, shared evidence record containing
the signed amount, description, account institution, and account type plus useful
fields that are actually available, such as merchant, memo, counterparty, source
categories, source-category confidence, transaction code, and investment facts. Source
categories are hints: the prompt treats low or unknown confidence as weak
evidence and prioritizes explicit card-repayment wording over conflicting
spending categories. Card branding alone does not turn an actual rent payment
into a credit-card payment. Batches are serialized as TOON to avoid
repeating field names; provider responses remain schema-validated JSON.

Older transactions are backfilled with the details already present in Moneta,
because source fields that were never stored cannot be recovered retroactively.

Categorization sends the compact evidence fields and natural-language rules to
the configured AI provider. It does not send transaction dates, payment channels,
account names or nicknames, account numbers, balances, external IDs, locations,
or full source payloads. Review that provider's privacy and data-retention terms
before using the feature with real financial data.

## Local data and security

By default, all persistent state is stored in `finance.db`, including:

- Accounts and transactions
- Plaid configuration and access tokens
- AI provider configuration, API key, categorization rules, and original
  transaction details
- Saved report views
- Balance history, holdings, and cached market prices

The database is local but is not encrypted by Moneta. Do not commit it, share it,
or place it in an untrusted backup. SQLite sidecar files such as `finance.db-wal`
and `finance.db-shm` may also contain financial data and must remain private. The
provided `.gitignore` excludes these files, `.env`, and `node_modules`.

Moneta has no authentication because it is intended for a single user on a local
machine. The server binds to `127.0.0.1` by default. Do not expose it to an
untrusted network without adding appropriate authentication and transport
security.

To create a fresh database, stop the server and remove `finance.db` and any
matching `finance.db-wal` or `finance.db-shm` files. The next start recreates an
empty database.

## Optional server environment settings

Plaid credentials do not belong in `.env`. The file is only needed when changing
server-level defaults. Copy `.env.example` to `.env` and uncomment the settings
you need:

```dotenv
# PORT=4173
# HOST=127.0.0.1
# FINANCE_DB_PATH=/absolute/path/to/finance.db
```

When using `FINANCE_DB_PATH`, its containing directory must already exist.

## CSV import

CSV files can use any column names. After choosing a file, map its columns to
Moneta fields in the import dialog. `Date`, `Amount`, and `Description` are the
only required mappings; the remaining mappings are optional and can improve
categorization.

Imported dates are validated and stored as ISO calendar dates (`YYYY-MM-DD`).
Supported inputs include year-first dates (`2026-09-05`, `2026/09/05`, or
`20260905`), numeric month-first or day-first dates (`09/05/2026` or
`05/09/2026`), two-digit years, ISO timestamps, and English month names such as
`September 5, 2026` or `5 Sep 2026`.

The default **Auto-detect** setting examines the complete date column and a
format hint such as `DD/MM/YYYY` in its header. For example, the presence of
`31/08/2026` establishes day-first order for other rows in that import. If every
numeric date is ambiguous, choose **Month / day / year** or **Day / month / year**
in the import dialog. Moneta rejects invalid dates and files that demonstrably
mix both orders instead of silently storing uncertain values.

```csv
date,amount,description,merchant,memo,source_category,source_category_detail,transaction_code
2026-07-01,3500,ACH CREDIT ACME PAYROLL,Acme Payroll,,INCOME,INCOME_WAGES,DDA_TRANSACTION
2026-07-02,-82.14,CARD PURCHASE LOCAL MARKET,Local Market,,FOOD_AND_DRINK,FOOD_AND_DRINK_GROCERIES,
2026-07-03,20.00,CARD REFUND LOCAL MARKET,Local Market,Refund,FOOD_AND_DRINK,FOOD_AND_DRINK_GROCERIES,
```

Optional categorization evidence columns are `merchant`, `memo` or `note`,
`counterparty`, `source_category`, `source_category_detail`,
`source_category_confidence`, `transaction_code`,
`investment_action`, `investment_subtype`, `security_name`, `ticker`, `quantity`,
`price`, and `fees`. Empty optional fields are not sent to the AI provider.

Use `moneta_category` to provide an authoritative supported Moneta category.
For backward compatibility, `category` is accepted as an alias. If either value
matches a supported category, Moneta keeps it without automatic AI
categorization. An unrecognized `category` is treated as a source category hint.
Enable **Protect imported categories from AI** when imported or fallback
categories must also remain unchanged during future AI runs.

Amounts are signed: positive values are money in or credits, while negative
values are money out or charges. Classification comes only from the resulting
category's group. Categories in Income are income, categories in Transfers are
transfers, and all other categories are expenses. A positive expense, such as
the refund above, reduces the expense total without being reclassified as income.

Before importing, choose the fields used for duplicate matching. Moneta considers
two transactions duplicates when all selected fields match within the destination
account. Date, amount, and description are selected by default; mapped merchant,
category, memo/note, and external ID fields can also be used. Text comparisons
ignore surrounding whitespace and letter case, while dates and external IDs are
matched exactly.

For each match, choose whether to keep the existing database transaction or
replace it with the CSV transaction. Replacement updates the existing record in
place, including its category-protection setting. If the database already has
multiple matching records, the oldest one is retained and the extras are removed.
The original CSV headers and row values are stored with each imported transaction
for future inspection and AI re-categorization.

CSV import remains available for institutions or products not supported by your
Plaid access level.

## Tests

```bash
npm test
```

The tests use temporary databases and a local mock of Plaid; they do not modify
your `finance.db`.
