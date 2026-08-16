# Moneta

Moneta is a private, local-first personal finance dashboard for one user. It
combines bank accounts, credit cards, cash, and investments in a single SQLite
database and can import financial data through Plaid or CSV.

## Features

- Unified activity classified by category group: Income, Transfers, or expenses
- Plaid connections for supported banks, cards, and brokerages
- Credit-card payment matching so transfers are not counted as duplicate expenses
- Monarch-style category groups and categories
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

The project currently has no third-party npm runtime dependencies.

## Quick start

```bash
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

## Local data and security

By default, all persistent state is stored in `finance.db`, including:

- Accounts and transactions
- Plaid configuration and access tokens
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

CSV files require `date`, `merchant`, `amount`, and `category` columns. Optional
columns are `note` and `external_id`.

```csv
date,merchant,amount,category
2026-07-01,Example Payroll,3500,Paychecks
2026-07-02,Local Market,-82.14,Groceries
2026-07-03,Local Market Refund,20.00,Groceries
```

Amounts are signed: positive values are money in or credits, while negative
values are money out or charges. Classification comes only from the category's
group. Categories in Income are income, categories in Transfers are transfers,
and all other categories are expenses. A positive expense, such as the refund
above, reduces the expense total without being reclassified as income.

Use a stable `external_id` when available to make repeated imports safely skip
the same records. CSV import remains available for institutions or products not
supported by your Plaid access level.

## Tests

```bash
npm test
```

The tests use temporary databases and a local mock of Plaid; they do not modify
your `finance.db`.
