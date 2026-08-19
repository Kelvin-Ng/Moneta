# Moneta

Moneta is a private, local-first personal finance dashboard for one user. It
combines bank accounts, credit cards, cash, and investments in a single SQLite
database and can import financial data through Plaid or CSV.

## Features

- Unified activity classified by category group: Income, Transfers, or expenses
- Plaid connections for supported banks, cards, and brokerages
- Optional account nicknames shown throughout reports, filters, and transaction lists
- Credit-card payment matching so transfers are not counted as duplicate expenses
- Monarch-style category groups and categories
- Batched AI categorization with provider-neutral rules and re-categorization
- Filterable cash-flow totals, monthly bar chart, and interactive Sankey report
- Daily net-worth history with account filters
- Investment-history reconstruction using transactions, holdings, and closing prices
- Saved report views whose values are recalculated from current data
- Local SQLite persistence with no application login

Every main page has a direct URL, including `/overview`, `/cash-flow`,
`/net-worth`, `/transactions`, `/accounts`, `/insights`, and `/settings`.

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
Peer-to-peer payment memos mentioning lunch or dinner are Restaurants & Bars.
```

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
the signed amount, description, and account type plus useful fields that are
actually available, such as merchant, memo, counterparty, source categories,
transaction code, and investment facts. Batches are serialized as TOON to avoid
repeating field names; provider responses remain schema-validated JSON.

Older transactions are backfilled with the details already present in Moneta,
because source fields that were never stored cannot be recovered retroactively.

Categorization sends the compact evidence fields and natural-language rules to
the configured AI provider. It does not send transaction dates, payment channels,
account or institution names, balances, external IDs, locations, or full source
payloads. Review that provider's privacy and data-retention terms before using
the feature with real financial data.

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

CSV files require `date`, `amount`, and either `description` or `merchant`.
`category` is no longer required.

```csv
date,amount,description,merchant,memo,source_category,source_category_detail,transaction_code
2026-07-01,3500,ACH CREDIT ACME PAYROLL,Acme Payroll,,INCOME,INCOME_WAGES,DDA_TRANSACTION
2026-07-02,-82.14,CARD PURCHASE LOCAL MARKET,Local Market,,FOOD_AND_DRINK,FOOD_AND_DRINK_GROCERIES,
2026-07-03,20.00,CARD REFUND LOCAL MARKET,Local Market,Refund,FOOD_AND_DRINK,FOOD_AND_DRINK_GROCERIES,
```

Optional categorization evidence columns are `merchant`, `memo` or `note`,
`counterparty`, `source_category`, `source_category_detail`, `transaction_code`,
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

Use a stable `external_id` when available to make repeated imports safely skip
the same records. CSV import remains available for institutions or products not
supported by your Plaid access level.

## Tests

```bash
npm test
```

The tests use temporary databases and a local mock of Plaid; they do not modify
your `finance.db`.
