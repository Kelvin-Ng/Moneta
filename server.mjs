import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import { DatabaseSync } from "node:sqlite";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
try { loadEnvFile(join(ROOT, ".env")); } catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const PLAID_BASE_OVERRIDE = process.env.PLAID_BASE_URL || "";
const MARKET_DATA_BASE = process.env.MARKET_DATA_BASE_URL || "https://query1.finance.yahoo.com/v8/finance/chart";
const PLAID_SYNC_RETRY_MS = Number(process.env.PLAID_SYNC_RETRY_MS || 3000);
const PLAID_SYNC_MAX_ATTEMPTS = Number(process.env.PLAID_SYNC_MAX_ATTEMPTS || 200);
const db = new DatabaseSync(process.env.FINANCE_DB_PATH || join(ROOT, "finance.db"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY,
    institution TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('checking','savings','credit','investment','cash')),
    balance REAL NOT NULL DEFAULT 0,
    color TEXT NOT NULL DEFAULT '#6d5dfc',
    last_sync TEXT,
    connected INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    merchant TEXT NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('income','expense','transfer','investment')),
    note TEXT NOT NULL DEFAULT '',
    pending INTEGER NOT NULL DEFAULT 0,
    transfer_pair_id INTEGER REFERENCES transactions(id),
    external_id TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS tx_date ON transactions(date);
  CREATE INDEX IF NOT EXISTS tx_kind ON transactions(kind);
  CREATE TABLE IF NOT EXISTS plaid_items (
    id INTEGER PRIMARY KEY,
    item_id TEXT NOT NULL UNIQUE,
    access_token TEXT NOT NULL,
    institution_id TEXT,
    institution_name TEXT NOT NULL DEFAULT 'Connected institution',
    cursor TEXT,
    status TEXT NOT NULL DEFAULT 'connected',
    error_code TEXT,
    last_sync TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ignored_external_accounts (
    external_account_id TEXT PRIMARY KEY,
    removed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS report_views (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    configuration_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS account_balance_history (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    balance REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'sync',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(account_id,date)
  );
  CREATE TABLE IF NOT EXISTS investment_securities (
    security_id TEXT PRIMARY KEY,
    ticker_symbol TEXT,
    name TEXT,
    type TEXT,
    subtype TEXT,
    is_cash_equivalent INTEGER NOT NULL DEFAULT 0,
    close_price REAL,
    close_price_as_of TEXT,
    currency_code TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS investment_holdings (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    security_id TEXT NOT NULL REFERENCES investment_securities(security_id) ON DELETE CASCADE,
    quantity REAL NOT NULL,
    institution_price REAL,
    institution_value REAL,
    price_as_of TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(account_id,security_id)
  );
  CREATE TABLE IF NOT EXISTS investment_ledger (
    external_id TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    security_id TEXT REFERENCES investment_securities(security_id),
    date TEXT NOT NULL,
    name TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 0,
    amount REAL NOT NULL DEFAULT 0,
    price REAL NOT NULL DEFAULT 0,
    fees REAL NOT NULL DEFAULT 0,
    type TEXT NOT NULL,
    subtype TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS investment_ledger_account_date ON investment_ledger(account_id,date);
  CREATE TABLE IF NOT EXISTS security_prices (
    security_id TEXT NOT NULL REFERENCES investment_securities(security_id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    close REAL NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY(security_id,date)
  );
  CREATE TABLE IF NOT EXISTS security_price_fetches (
    security_id TEXT PRIMARY KEY REFERENCES investment_securities(security_id) ON DELETE CASCADE,
    requested_from TEXT NOT NULL,
    attempted_through TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS investment_reconstruction_state (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    reconstructed_through TEXT,
    invalidated_from TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);
function ensureColumn(table, name, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}
ensureColumn("accounts", "plaid_item_id", "INTEGER REFERENCES plaid_items(id)");
ensureColumn("accounts", "external_account_id", "TEXT");
ensureColumn("security_price_fetches", "requested_from", "TEXT NOT NULL DEFAULT '9999-12-31'");
db.exec("DROP INDEX IF EXISTS account_external_id; CREATE UNIQUE INDEX account_external_id ON accounts(external_account_id);");

const getSetting = key => db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value;
const saveSetting = db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
function initializePlaidSettings() {
  if (getSetting("plaid_settings_initialized")) return;
  const environment=["sandbox","development","production"].includes(process.env.PLAID_ENV)?process.env.PLAID_ENV:"sandbox";
  db.exec("BEGIN");
  try {
    saveSetting.run("plaid_client_id",process.env.PLAID_CLIENT_ID||"");
    saveSetting.run("plaid_secret",process.env.PLAID_SECRET||"");
    saveSetting.run("plaid_environment",environment);
    saveSetting.run("plaid_redirect_uri",process.env.PLAID_REDIRECT_URI||"");
    saveSetting.run("plaid_settings_initialized","1");
    db.exec("COMMIT");
  } catch(error) { db.exec("ROLLBACK"); throw error; }
}
initializePlaidSettings();

function plaidConfiguration() {
  const environment=getSetting("plaid_environment");
  return {
    clientId:getSetting("plaid_client_id")||"",
    secret:getSetting("plaid_secret")||"",
    environment:["sandbox","development","production"].includes(environment)?environment:"sandbox",
    redirectUri:getSetting("plaid_redirect_uri")||""
  };
}
const plaidConfigured = () => {
  const configuration=plaidConfiguration();
  return Boolean(configuration.clientId&&configuration.secret);
};
function validPlaidRedirectUri(raw, environment) {
  if (!raw) return null;
  try {
    const uri = new URL(raw);
    const localhost = ["localhost", "127.0.0.1", "[::1]"].includes(uri.hostname);
    const clean = !uri.search && !uri.hash;
    if (clean && uri.protocol === "https:") return raw;
    if (clean && environment === "sandbox" && uri.protocol === "http:" && localhost) return raw;
  } catch {}
  return null;
}
function plaidRedirectStatus(configuration=plaidConfiguration()) {
  const configured = configuration.redirectUri;
  const used = validPlaidRedirectUri(configured,configuration.environment);
  return {
    configured,
    used,
    valid: !configured || Boolean(used),
    message: configured && !used
      ? "The redirect URI must be HTTPS outside Sandbox and cannot include a query string or fragment. Localhost HTTP is allowed only in Sandbox."
      : ""
  };
}
function publicSettings() {
  const configuration=plaidConfiguration();
  return {
    plaid:{
      client_id:configuration.clientId,
      secret_configured:Boolean(configuration.secret),
      environment:configuration.environment,
      redirect_uri:configuration.redirectUri,
      redirect:plaidRedirectStatus(configuration),
      configured:Boolean(configuration.clientId&&configuration.secret)
    },
    database:{
      accounts:db.prepare("SELECT COUNT(*) count FROM accounts").get().count,
      transactions:db.prepare("SELECT COUNT(*) count FROM transactions").get().count
    }
  };
}

const MONARCH_CATEGORY_GROUPS = [
  {name:"Income", kind:"income", categories:["Paychecks","Interest","Business Income","Other Income","Dividends & Capital Gains"]},
  {name:"Gifts & Donations", kind:"expense", categories:["Charity","Gifts"]},
  {name:"Auto & Transport", kind:"expense", categories:["Auto Payment","Public Transit","Gas","Auto Maintenance","Parking & Tolls","Taxi & Ride Shares"]},
  {name:"Housing", kind:"expense", categories:["Mortgage","Rent","Home Improvement"]},
  {name:"Bills & Utilities", kind:"expense", categories:["Garbage","Water","Gas & Electric","Internet & Cable","Phone"]},
  {name:"Food & Dining", kind:"expense", categories:["Groceries","Restaurants & Bars","Coffee Shops"]},
  {name:"Travel & Lifestyle", kind:"expense", categories:["Travel & Vacation","Entertainment & Recreation","Personal","Pets","Fun Money"]},
  {name:"Shopping", kind:"expense", categories:["Shopping","Clothing","Furniture & Housewares","Electronics"]},
  {name:"Children", kind:"expense", categories:["Child Care","Child Activities"]},
  {name:"Education", kind:"expense", categories:["Student Loans","Education"]},
  {name:"Health & Wellness", kind:"expense", categories:["Medical","Dentist","Fitness"]},
  {name:"Financial", kind:"expense", categories:["Loan Repayment","Financial & Legal Services","Financial Fees","Cash & ATM","Insurance","Taxes"]},
  {name:"Other", kind:"expense", categories:["Uncategorized","Check","Miscellaneous"]},
  {name:"Business", kind:"expense", categories:["Advertising & Promotion","Business Utilities & Communication","Employee Wages & Contract Labor","Business Travel & Meals","Business Auto Expenses","Business Insurance","Office Supplies & Expenses","Office Rent","Postage & Shipping"]},
  {name:"Transfers", kind:"transfer", categories:["Transfer","Credit Card Payment","Balance Adjustments","Buy","Sell"]}
];
const MONARCH_CATEGORIES = MONARCH_CATEGORY_GROUPS.flatMap(group => group.categories);
const MONARCH_CATEGORY_SET = new Set(MONARCH_CATEGORIES.map(category => category.toLowerCase()));
const MONARCH_CATEGORY_LOOKUP = new Map(MONARCH_CATEGORY_GROUPS.flatMap(group =>
  group.categories.map(category => [category.toLowerCase(), {group:group.name, kind:group.kind}])
));

function categoryGroupFor(category, kind) {
  const match = MONARCH_CATEGORY_LOOKUP.get(String(category || "").toLowerCase());
  if (match) return match.group;
  if (kind === "income") return "Income";
  if (kind === "transfer" || kind === "investment") return "Transfers";
  return "Other";
}

function categoryTaxonomy(dbCategories = []) {
  const groups = MONARCH_CATEGORY_GROUPS.map(group => ({...group,categories:[...group.categories]}));
  for (const row of dbCategories) {
    if (MONARCH_CATEGORY_LOOKUP.has(String(row.category).toLowerCase())) continue;
    const groupName = categoryGroupFor(row.category,row.kind);
    const group = groups.find(candidate => candidate.name === groupName);
    if (group && !group.categories.includes(row.category)) group.categories.push(row.category);
  }
  return groups;
}

const PLAID_DETAILED_CATEGORY_MAP = {
  INCOME_WAGES:"Paychecks",
  INCOME_INTEREST_EARNED:"Interest",
  INCOME_DIVIDENDS:"Dividends & Capital Gains",
  INCOME_RETIREMENT_PENSION:"Other Income",
  INCOME_TAX_REFUND:"Taxes",
  INCOME_UNEMPLOYMENT:"Other Income",
  INCOME_OTHER_INCOME:"Other Income",
  TRANSFER_IN_CASH_ADVANCES_AND_LOANS:"Loan Repayment",
  TRANSFER_IN_DEPOSIT:"Transfer",
  TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS:"Transfer",
  TRANSFER_IN_SAVINGS:"Transfer",
  TRANSFER_IN_ACCOUNT_TRANSFER:"Transfer",
  TRANSFER_IN_OTHER_TRANSFER_IN:"Transfer",
  TRANSFER_IN_WIRE:"Transfer",
  TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS:"Transfer",
  TRANSFER_OUT_SAVINGS:"Transfer",
  TRANSFER_OUT_WITHDRAWAL:"Cash & ATM",
  TRANSFER_OUT_ACCOUNT_TRANSFER:"Transfer",
  TRANSFER_OUT_OTHER_TRANSFER_OUT:"Transfer",
  TRANSFER_OUT_WIRE:"Transfer",
  LOAN_PAYMENTS_CAR_PAYMENT:"Auto Payment",
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT:"Credit Card Payment",
  LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT:"Loan Repayment",
  LOAN_PAYMENTS_MORTGAGE_PAYMENT:"Mortgage",
  LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT:"Student Loans",
  BANK_FEES_ATM_FEES:"Cash & ATM",
  BANK_FEES_FOREIGN_TRANSACTION_FEES:"Financial Fees",
  BANK_FEES_INSUFFICIENT_FUNDS:"Financial Fees",
  BANK_FEES_INTEREST_CHARGE:"Financial Fees",
  BANK_FEES_OVERDRAFT_FEES:"Financial Fees",
  BANK_FEES_OTHER_BANK_FEES:"Financial Fees",
  ENTERTAINMENT_CASINOS_AND_GAMBLING:"Entertainment & Recreation",
  ENTERTAINMENT_MUSIC_AND_AUDIO:"Entertainment & Recreation",
  ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS:"Entertainment & Recreation",
  ENTERTAINMENT_TV_AND_MOVIES:"Entertainment & Recreation",
  ENTERTAINMENT_VIDEO_GAMES:"Entertainment & Recreation",
  ENTERTAINMENT_OTHER_ENTERTAINMENT:"Entertainment & Recreation",
  FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR:"Restaurants & Bars",
  FOOD_AND_DRINK_COFFEE:"Coffee Shops",
  FOOD_AND_DRINK_FAST_FOOD:"Restaurants & Bars",
  FOOD_AND_DRINK_GROCERIES:"Groceries",
  FOOD_AND_DRINK_RESTAURANT:"Restaurants & Bars",
  FOOD_AND_DRINK_VENDING_MACHINES:"Restaurants & Bars",
  FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK:"Restaurants & Bars",
  GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS:"Shopping",
  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES:"Clothing",
  GENERAL_MERCHANDISE_CONVENIENCE_STORES:"Shopping",
  GENERAL_MERCHANDISE_DEPARTMENT_STORES:"Shopping",
  GENERAL_MERCHANDISE_DISCOUNT_STORES:"Shopping",
  GENERAL_MERCHANDISE_ELECTRONICS:"Electronics",
  GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES:"Gifts",
  GENERAL_MERCHANDISE_OFFICE_SUPPLIES:"Office Supplies & Expenses",
  GENERAL_MERCHANDISE_ONLINE_MARKETPLACES:"Shopping",
  GENERAL_MERCHANDISE_PET_SUPPLIES:"Pets",
  GENERAL_MERCHANDISE_SPORTING_GOODS:"Shopping",
  GENERAL_MERCHANDISE_SUPERSTORES:"Shopping",
  GENERAL_MERCHANDISE_TOBACCO_AND_VAPE:"Personal",
  GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE:"Shopping",
  HOME_IMPROVEMENT_FURNITURE:"Furniture & Housewares",
  HOME_IMPROVEMENT_HARDWARE:"Home Improvement",
  HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE:"Home Improvement",
  HOME_IMPROVEMENT_SECURITY:"Home Improvement",
  HOME_IMPROVEMENT_OTHER_HOME_IMPROVEMENT:"Home Improvement",
  MEDICAL_DENTAL_CARE:"Dentist",
  MEDICAL_EYE_CARE:"Medical",
  MEDICAL_NURSING_CARE:"Medical",
  MEDICAL_PHARMACIES_AND_SUPPLEMENTS:"Medical",
  MEDICAL_PRIMARY_CARE:"Medical",
  MEDICAL_VETERINARY_SERVICES:"Pets",
  MEDICAL_OTHER_MEDICAL:"Medical",
  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS:"Fitness",
  PERSONAL_CARE_HAIR_AND_BEAUTY:"Personal",
  PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING:"Personal",
  PERSONAL_CARE_OTHER_PERSONAL_CARE:"Personal",
  GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING:"Financial & Legal Services",
  GENERAL_SERVICES_AUTOMOTIVE:"Auto Maintenance",
  GENERAL_SERVICES_CHILDCARE:"Child Care",
  GENERAL_SERVICES_CONSULTING_AND_LEGAL:"Financial & Legal Services",
  GENERAL_SERVICES_EDUCATION:"Education",
  GENERAL_SERVICES_INSURANCE:"Insurance",
  GENERAL_SERVICES_POSTAGE_AND_SHIPPING:"Postage & Shipping",
  GENERAL_SERVICES_STORAGE:"Miscellaneous",
  GENERAL_SERVICES_OTHER_GENERAL_SERVICES:"Miscellaneous",
  GOVERNMENT_AND_NON_PROFIT_DONATIONS:"Charity",
  GOVERNMENT_AND_NON_PROFIT_GOVERNMENT_DEPARTMENTS_AND_AGENCIES:"Taxes",
  GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT:"Taxes",
  GOVERNMENT_AND_NON_PROFIT_OTHER_GOVERNMENT_AND_NON_PROFIT:"Miscellaneous",
  TRANSPORTATION_BIKES_AND_SCOOTERS:"Public Transit",
  TRANSPORTATION_GAS:"Gas",
  TRANSPORTATION_PARKING:"Parking & Tolls",
  TRANSPORTATION_PUBLIC_TRANSIT:"Public Transit",
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES:"Taxi & Ride Shares",
  TRANSPORTATION_TOLLS:"Parking & Tolls",
  TRANSPORTATION_OTHER_TRANSPORTATION:"Public Transit",
  TRAVEL_FLIGHTS:"Travel & Vacation",
  TRAVEL_LODGING:"Travel & Vacation",
  TRAVEL_RENTAL_CARS:"Travel & Vacation",
  TRAVEL_OTHER_TRAVEL:"Travel & Vacation",
  RENT_AND_UTILITIES_GAS_AND_ELECTRICITY:"Gas & Electric",
  RENT_AND_UTILITIES_INTERNET_AND_CABLE:"Internet & Cable",
  RENT_AND_UTILITIES_RENT:"Rent",
  RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT:"Garbage",
  RENT_AND_UTILITIES_TELEPHONE:"Phone",
  RENT_AND_UTILITIES_WATER:"Water",
  RENT_AND_UTILITIES_OTHER_UTILITIES:"Gas & Electric"
};
const PLAID_PRIMARY_CATEGORY_MAP = {
  INCOME:"Other Income",
  TRANSFER_IN:"Transfer",
  TRANSFER_OUT:"Transfer",
  LOAN_PAYMENTS:"Loan Repayment",
  BANK_FEES:"Financial Fees",
  ENTERTAINMENT:"Entertainment & Recreation",
  FOOD_AND_DRINK:"Restaurants & Bars",
  GENERAL_MERCHANDISE:"Shopping",
  HOME_IMPROVEMENT:"Home Improvement",
  MEDICAL:"Medical",
  PERSONAL_CARE:"Personal",
  GENERAL_SERVICES:"Miscellaneous",
  GOVERNMENT_AND_NON_PROFIT:"Miscellaneous",
  TRANSPORTATION:"Public Transit",
  TRAVEL:"Travel & Vacation",
  RENT_AND_UTILITIES:"Gas & Electric"
};

function isCreditCardPaymentText(value) {
  return /credit card|card.?pmt|card.?payment|autopay|e-?payment|payment received|bilt card.?pmt|citi autopay|discover-e-payment|capital one|american express|amex|amazon store card/.test(value);
}

function monarchKindFor({kind, category, merchant, amount, plaidPrimary, plaidDetailed}) {
  const text = `${merchant || ""} ${category || ""} ${plaidPrimary || ""} ${plaidDetailed || ""}`.toLowerCase();
  if (plaidPrimary?.startsWith("TRANSFER_") || plaidDetailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") return "transfer";
  if (kind === "transfer") return "transfer";
  if (isCreditCardPaymentText(text)) return "transfer";
  if (["income","expense","investment"].includes(kind)) return kind;
  return Number(amount) < 0 ? "expense" : "income";
}

function monarchCategoryFor({kind, category, merchant, plaidPrimary, plaidDetailed, investmentType, investmentSubtype, force = false}) {
  const text = `${merchant || ""} ${category || ""} ${plaidPrimary || ""} ${plaidDetailed || ""}`.toLowerCase();
  const existing = String(category || "").trim();
  if (!force && existing && MONARCH_CATEGORY_SET.has(existing.toLowerCase())) return MONARCH_CATEGORIES.find(c => c.toLowerCase() === existing.toLowerCase());
  if (kind === "transfer") {
    if (isCreditCardPaymentText(text))
      return "Credit Card Payment";
    if (/adjustment|opening balance|balance/.test(text)) return "Balance Adjustments";
    if (/buy|purchase/.test(`${investmentType || ""} ${investmentSubtype || ""}`.toLowerCase())) return "Buy";
    if (/sell/.test(`${investmentType || ""} ${investmentSubtype || ""}`.toLowerCase())) return "Sell";
    return "Transfer";
  }
  if (/dividend|capital gain/.test(text)) return "Dividends & Capital Gains";
  if (kind === "investment") {
    if (/sell/.test(text)) return "Sell";
    if (/buy|purchase|reinvest|investment/.test(text)) return "Buy";
    return "Transfer";
  }
  if (plaidDetailed && PLAID_DETAILED_CATEGORY_MAP[plaidDetailed]) return PLAID_DETAILED_CATEGORY_MAP[plaidDetailed];
  if (plaidPrimary && PLAID_PRIMARY_CATEGORY_MAP[plaidPrimary]) return PLAID_PRIMARY_CATEGORY_MAP[plaidPrimary];
  if (kind === "income") {
    if (/payroll|paycheck|salary|wage|amazon developme/.test(text)) return "Paychecks";
    if (/interest/.test(text)) return "Interest";
    if (/business|freelance|contract/.test(text)) return "Business Income";
    return "Other Income";
  }
  if (/whole foods|trader joe|grocery|groceries|market\b|corner market/.test(text)) return "Groceries";
  if (/coffee|blue bottle|starbucks|philz/.test(text)) return "Coffee Shops";
  if (/restaurant|bar|bakery|dining|nopa|tartine|food/.test(text)) return "Restaurants & Bars";
  if (/pge|pg&e|electric|utility|utilities|gas and electric/.test(text)) return "Gas & Electric";
  if (/internet|cable|comcast|xfinity/.test(text)) return "Internet & Cable";
  if (/phone|at&t|verizon|t-mobile|tmobile/.test(text)) return "Phone";
  if (/water/.test(text)) return "Water";
  if (/garbage|trash|sewage|waste/.test(text)) return "Garbage";
  if (/rent|apartment|housing|landlord/.test(text)) return "Rent";
  if (/mortgage/.test(text)) return "Mortgage";
  if (/toyota|auto payment|car payment/.test(text)) return "Auto Payment";
  if (/gas station|gasoline|fuel/.test(text)) return "Gas";
  if (/sfmta|public transit|transit|bart|muni/.test(text)) return "Public Transit";
  if (/uber|lyft|taxi|ride share/.test(text)) return "Taxi & Ride Shares";
  if (/parking|toll/.test(text)) return "Parking & Tolls";
  if (/united|delta|airline|hotel|travel/.test(text)) return "Travel & Vacation";
  if (/spotify|netflix|hulu|subscription|movie|entertainment/.test(text)) return "Entertainment & Recreation";
  if (/rei|amazon|shopping|store/.test(text)) return "Shopping";
  if (/student loan/.test(text)) return "Student Loans";
  if (/loan/.test(text)) return "Loan Repayment";
  if (/insurance/.test(text)) return "Insurance";
  if (/tax/.test(text)) return "Taxes";
  if (/atm|cash withdrawal/.test(text)) return "Cash & ATM";
  if (/fee|charge/.test(text)) return "Financial Fees";
  if (/check/.test(text)) return "Check";
  return "Uncategorized";
}

function migrateMonarchCategories() {
  const key = "category_schema";
  if (db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value === "monarch-defaults-2026-01-03-v2") return;
  const rows = db.prepare("SELECT id,merchant,category,kind,amount FROM transactions").all();
  const update = db.prepare("UPDATE transactions SET category=?, kind=? WHERE id=?");
  db.exec("BEGIN");
  try {
    for (const tx of rows) {
      const kind = monarchKindFor(tx);
      update.run(monarchCategoryFor({...tx, kind, force:true}), kind, tx.id);
    }
    db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, "monarch-defaults-2026-01-03-v2");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function generateDemoData() {
  const accounts = [
    ["checking","Demo Bank", "Everyday Checking", "checking", 8426.18, "#6d5dfc"],
    ["credit","Demo Card", "Rewards Card", "credit", -1284.42, "#ef6f6c"],
    ["investment","Demo Brokerage", "Individual Brokerage", "investment", 42890.35, "#2ab5a1"],
    ["savings","Demo Bank", "High-Yield Savings", "savings", 16320.00, "#f2a65a"]
  ];
  const addAccount = db.prepare(`INSERT INTO accounts(institution,name,type,balance,color,last_sync,external_account_id)
    VALUES(?,?,?,?,?,datetime('now'),?) ON CONFLICT(external_account_id) DO NOTHING`);
  const findAccount = db.prepare("SELECT id FROM accounts WHERE external_account_id=?");
  const accountIds={};
  let accountsAdded=0,transactionsAdded=0;
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM ignored_external_accounts WHERE external_account_id LIKE 'demo:%'").run();
    for (const [key,institution,name,type,balance,color] of accounts) {
      const externalId=`demo:${key}`;
      accountsAdded+=addAccount.run(institution,name,type,balance,color,externalId).changes;
      accountIds[key]=findAccount.get(externalId).id;
    }
  const dateDaysAgo=days=>{const date=new Date();date.setUTCHours(12,0,0,0);date.setUTCDate(date.getUTCDate()-days);return date.toISOString().slice(0,10)};
  const txs = [
    ["checking",2,"Acme Studio","Paychecks",4200,"income"],
    ["credit",3,"Neighborhood Bakery","Restaurants & Bars",-28.50,"expense"],
    ["credit",4,"Whole Foods Market","Groceries",-126.37,"expense"],
    ["investment",5,"Total Market Index Fund","Buy",500,"investment"],
    ["checking",6,"Mission Apartments","Rent",-2450,"expense"],
    ["checking",7,"Credit card payment","Credit Card Payment",-980,"transfer"],
    ["credit",7,"Payment received","Credit Card Payment",980,"transfer"],
    ["savings",9,"Interest payment","Interest",51.34,"income"],
    ["credit",10,"Electric utility","Gas & Electric",-93.20,"expense"],
    ["credit",13,"Coffee shop","Coffee Shops",-7.25,"expense"],
    ["checking",18,"Acme Studio","Paychecks",4200,"income"],
    ["credit",20,"United Airlines","Travel & Vacation",-458.10,"expense"],
    ["investment",23,"Total Market Index Fund","Buy",500,"investment"],
    ["credit",26,"Music subscription","Entertainment & Recreation",-11.99,"expense"],
    ["credit",28,"Trader Joe's","Groceries",-84.62,"expense"],
    ["checking",32,"Freelance project","Business Income",850,"income"],
    ["checking",36,"Mission Apartments","Rent",-2450,"expense"],
    ["investment",39,"Index fund dividend","Dividends & Capital Gains",94.75,"income"],
    ["credit",42,"Outdoor store","Shopping",-164.80,"expense"],
    ["credit",46,"Public transit","Public Transit",-81,"expense"],
    ["checking",49,"Acme Studio","Paychecks",4200,"income"],
    ["investment",54,"Total Market Index Fund","Buy",500,"investment"],
    ["credit",58,"Neighborhood restaurant","Restaurants & Bars",-96.40,"expense"],
    ["credit",62,"Whole Foods Market","Groceries",-139.11,"expense"],
    ["checking",67,"Mission Apartments","Rent",-2450,"expense"]
  ];
    const addTx = db.prepare("INSERT OR IGNORE INTO transactions(account_id,date,merchant,category,amount,kind,external_id) VALUES(?,?,?,?,?,?,?)");
    txs.forEach(([account,days,merchant,category,amount,kind],index)=>{
      transactionsAdded+=addTx.run(accountIds[account],dateDaysAgo(days),merchant,category,amount,kind,`demo:tx:${index}`).changes;
    });
    const pair = db.prepare("SELECT id FROM transactions WHERE external_id=?");
    const a = pair.get("demo:tx:5").id, b = pair.get("demo:tx:6").id;
    db.prepare("UPDATE transactions SET transfer_pair_id=? WHERE id=?").run(b, a);
    db.prepare("UPDATE transactions SET transfer_pair_id=? WHERE id=?").run(a, b);
    db.exec("COMMIT");
  } catch(error) { db.exec("ROLLBACK"); throw error; }
  snapshotAccountBalances(Object.values(accountIds),"demo");
  return {accounts_added:accountsAdded,transactions_added:transactionsAdded,accounts:accounts.length,transactions:25};
}
migrateMonarchCategories();

function snapshotAccountBalances(accountIds, source = "sync") {
  const ids = Array.isArray(accountIds) ? accountIds.map(Number).filter(Number.isInteger) : [];
  const accounts = ids.length
    ? db.prepare(`SELECT id,balance FROM accounts WHERE id IN (${ids.map(()=>"?").join(",")})`).all(...ids)
    : db.prepare("SELECT id,balance FROM accounts").all();
  const save = db.prepare(`
    INSERT INTO account_balance_history(account_id,date,balance,source)
    VALUES(?,date('now'),?,?)
    ON CONFLICT(account_id,date) DO UPDATE SET balance=excluded.balance,source=excluded.source,created_at=CURRENT_TIMESTAMP
  `);
  accounts.forEach(account=>save.run(account.id,account.balance,source));
}
snapshotAccountBalances([],"current");

const json = (res, data, status = 200) => {
  res.writeHead(status, {"content-type":"application/json; charset=utf-8"});
  res.end(JSON.stringify(data));
};
const body = async req => {
  let value = "";
  for await (const chunk of req) value += chunk;
  return value ? JSON.parse(value) : {};
};

async function plaid(path, payload) {
  const configuration=plaidConfiguration();
  if (!configuration.clientId || !configuration.secret) throw new Error("Plaid is not configured. Add your Plaid credentials in Settings.");
  const base=PLAID_BASE_OVERRIDE||`https://${configuration.environment}.plaid.com`;
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "PLAID-CLIENT-ID": configuration.clientId,
      "PLAID-SECRET": configuration.secret,
      "Plaid-Version": "2020-09-14"
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error_message || `Plaid request failed (${response.status})`);
    error.code = data.error_code;
    error.type = data.error_type;
    throw error;
  }
  return data;
}

const accountType = account => {
  if (account.type === "credit") return "credit";
  if (account.type === "investment") return "investment";
  if (account.subtype === "savings" || account.subtype === "money market") return "savings";
  return "checking";
};
const accountBalance = account => {
  const current = account.balances.current ?? account.balances.available ?? 0;
  return account.type === "credit" ? -current : current;
};
const titleCase = value => String(value || "Uncategorized").toLowerCase().replaceAll("_", " ").replace(/\b\w/g, c => c.toUpperCase());
const plaidCategory = (transaction, kind) => monarchCategoryFor({
  kind,
  category: transaction.category?.[0],
  merchant: transaction.merchant_name || transaction.name,
  plaidPrimary: transaction.personal_finance_category?.primary,
  plaidDetailed: transaction.personal_finance_category?.detailed
});
const plaidKind = transaction => {
  const primary = transaction.personal_finance_category?.primary || "";
  const detailed = transaction.personal_finance_category?.detailed || "";
  return monarchKindFor({
    kind: transaction.amount > 0 ? "expense" : "income",
    merchant: transaction.merchant_name || transaction.name,
    category: transaction.category?.[0],
    amount: -transaction.amount,
    plaidPrimary: primary,
    plaidDetailed: detailed
  });
};

function savePlaidAccounts(itemRowId, institutionName, accounts, {restoreIgnored = false} = {}) {
  if (restoreIgnored) {
    const restore = db.prepare("DELETE FROM ignored_external_accounts WHERE external_account_id=?");
    accounts.forEach(account => restore.run(account.account_id));
  }
  const ignored = new Set(db.prepare("SELECT external_account_id FROM ignored_external_accounts").all().map(row => row.external_account_id));
  const save = db.prepare(`
    INSERT INTO accounts(institution,name,type,balance,color,last_sync,connected,plaid_item_id,external_account_id)
    VALUES(?,?,?,?,?,datetime('now'),1,?,?)
    ON CONFLICT(external_account_id) DO UPDATE SET
      institution=excluded.institution,name=excluded.name,type=excluded.type,
      balance=excluded.balance,last_sync=datetime('now'),connected=1,plaid_item_id=excluded.plaid_item_id
  `);
  const palette = ["#6d5dfc","#28a792","#e97567","#e6a04b","#60a5c5"];
  accounts.filter(account => !ignored.has(account.account_id)).forEach((account, index) => save.run(
    institutionName,
    account.official_name || account.name,
    accountType(account),
    accountBalance(account),
    palette[index % palette.length],
    itemRowId,
    account.account_id
  ));
  snapshotAccountBalances(
    db.prepare("SELECT id FROM accounts WHERE plaid_item_id=?").all(itemRowId).map(account=>account.id),
    "plaid"
  );
}

function removeAccount(accountId) {
  const account = db.prepare("SELECT * FROM accounts WHERE id=?").get(accountId);
  if (!account) return null;
  const txIds = db.prepare("SELECT id FROM transactions WHERE account_id=?").all(accountId).map(row => row.id);
  db.exec("BEGIN");
  try {
    if (account.external_account_id)
      db.prepare("INSERT OR IGNORE INTO ignored_external_accounts(external_account_id) VALUES(?)").run(account.external_account_id);
    if (txIds.length) {
      const placeholders = txIds.map(() => "?").join(",");
      db.prepare(`UPDATE transactions SET transfer_pair_id=NULL WHERE id IN (${placeholders}) OR transfer_pair_id IN (${placeholders})`)
        .run(...txIds, ...txIds);
    }
    const transactionsDeleted = db.prepare("DELETE FROM transactions WHERE account_id=?").run(accountId).changes;
    db.prepare("DELETE FROM accounts WHERE id=?").run(accountId);
    let disconnectedItem = false;
    if (account.plaid_item_id) {
      const remaining = db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE plaid_item_id=?").get(account.plaid_item_id).n;
      if (!remaining) {
        db.prepare("DELETE FROM plaid_items WHERE id=?").run(account.plaid_item_id);
        disconnectedItem = true;
      }
    }
    db.exec("COMMIT");
    return {account, transactionsDeleted, disconnectedItem};
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function saveInvestmentSecurities(securities = []) {
  const save = db.prepare(`
    INSERT INTO investment_securities(
      security_id,ticker_symbol,name,type,subtype,is_cash_equivalent,close_price,close_price_as_of,currency_code
    ) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(security_id) DO UPDATE SET
      ticker_symbol=COALESCE(excluded.ticker_symbol,investment_securities.ticker_symbol),
      name=COALESCE(excluded.name,investment_securities.name),
      type=COALESCE(excluded.type,investment_securities.type),
      subtype=COALESCE(excluded.subtype,investment_securities.subtype),
      is_cash_equivalent=excluded.is_cash_equivalent,
      close_price=COALESCE(excluded.close_price,investment_securities.close_price),
      close_price_as_of=COALESCE(excluded.close_price_as_of,investment_securities.close_price_as_of),
      currency_code=COALESCE(excluded.currency_code,investment_securities.currency_code),updated_at=CURRENT_TIMESTAMP
  `);
  const savePrice = db.prepare(`
    INSERT INTO security_prices(security_id,date,close,source) VALUES(?,?,?,'plaid')
    ON CONFLICT(security_id,date) DO UPDATE SET close=excluded.close,source='plaid'
  `);
  for (const security of securities) {
    if (!security?.security_id) continue;
    save.run(
      security.security_id,security.ticker_symbol||null,security.name||null,security.type||null,
      security.subtype||null,security.is_cash_equivalent?1:0,
      Number.isFinite(Number(security.close_price))?Number(security.close_price):null,
      security.close_price_as_of||null,security.iso_currency_code||security.unofficial_currency_code||null
    );
    if (security.close_price_as_of && Number.isFinite(Number(security.close_price)))
      savePrice.run(security.security_id,security.close_price_as_of,Number(security.close_price));
  }
}

function invalidateInvestmentHistory(accountId,date) {
  db.prepare("DELETE FROM account_balance_history WHERE account_id=? AND source='reconstructed' AND date>=?").run(accountId,date);
  db.prepare(`
    INSERT INTO investment_reconstruction_state(account_id,invalidated_from) VALUES(?,?)
    ON CONFLICT(account_id) DO UPDATE SET invalidated_from=CASE
      WHEN invalidated_from IS NULL THEN excluded.invalidated_from
      ELSE MIN(invalidated_from,excluded.invalidated_from) END,updated_at=CURRENT_TIMESTAMP
  `).run(accountId,date);
}

function saveInvestmentHoldings(itemRowId, holdings = [], securities = []) {
  saveInvestmentSecurities(securities);
  const accounts = db.prepare("SELECT id,external_account_id FROM accounts WHERE plaid_item_id=? AND type='investment'").all(itemRowId);
  const accountIds = accounts.map(account=>account.id);
  const previousQuantities=new Map(accountIds.flatMap(accountId=>db.prepare("SELECT security_id,quantity FROM investment_holdings WHERE account_id=?").all(accountId).map(holding=>[`${accountId}\u0000${holding.security_id}`,holding.quantity])));
  if (accountIds.length)
    db.prepare(`DELETE FROM investment_holdings WHERE account_id IN (${accountIds.map(()=>"?").join(",")})`).run(...accountIds);
  const accountMap = new Map(accounts.map(account=>[account.external_account_id,account.id]));
  const ensureSecurity = db.prepare("INSERT OR IGNORE INTO investment_securities(security_id,name) VALUES(?,?)");
  const save = db.prepare(`
    INSERT INTO investment_holdings(account_id,security_id,quantity,institution_price,institution_value,price_as_of)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(account_id,security_id) DO UPDATE SET quantity=excluded.quantity,
      institution_price=excluded.institution_price,institution_value=excluded.institution_value,
      price_as_of=excluded.price_as_of,updated_at=CURRENT_TIMESTAMP
  `);
  for (const holding of holdings) {
    const accountId=accountMap.get(holding.account_id);
    if (!accountId || !holding.security_id) continue;
    ensureSecurity.run(holding.security_id,holding.security_id);
    save.run(accountId,holding.security_id,Number(holding.quantity||0),Number(holding.institution_price||0),Number(holding.institution_value||0),holding.institution_price_as_of||null);
  }
  for(const account of accounts){
    const prior=[...previousQuantities].filter(([key])=>key.startsWith(`${account.id}\u0000`)).map(([key,quantity])=>[key.split("\u0000")[1],quantity]).sort();
    const next=holdings.filter(holding=>accountMap.get(holding.account_id)===account.id).map(holding=>[holding.security_id,Number(holding.quantity||0)]).sort();
    if(JSON.stringify(prior)!==JSON.stringify(next)){
      const start=db.prepare("SELECT MIN(date) date FROM investment_ledger WHERE account_id=?").get(account.id)?.date||new Date().toISOString().slice(0,10);
      invalidateInvestmentHistory(account.id,start);
    }
  }
}

function saveInvestmentLedger(transaction) {
  const account = db.prepare("SELECT id FROM accounts WHERE external_account_id=?").get(transaction.account_id);
  if (!account || !transaction.investment_transaction_id) return;
  if (transaction.security_id)
    db.prepare("INSERT OR IGNORE INTO investment_securities(security_id,name) VALUES(?,?)").run(transaction.security_id,transaction.security_id);
  const externalId=`plaid:${transaction.investment_transaction_id}`;
  const values={
    security_id:transaction.security_id||null,date:transaction.date,name:transaction.name||"Investment activity",
    quantity:Number(transaction.quantity||0),amount:Number(transaction.amount||0),price:Number(transaction.price||0),
    fees:Number(transaction.fees||0),type:transaction.type||"cash",subtype:transaction.subtype||null
  };
  const previous=db.prepare("SELECT security_id,date,name,quantity,amount,price,fees,type,subtype FROM investment_ledger WHERE external_id=?").get(externalId);
  db.prepare(`
    INSERT INTO investment_ledger(external_id,account_id,security_id,date,name,quantity,amount,price,fees,type,subtype)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(external_id) DO UPDATE SET account_id=excluded.account_id,security_id=excluded.security_id,
      date=excluded.date,name=excluded.name,quantity=excluded.quantity,amount=excluded.amount,
      price=excluded.price,fees=excluded.fees,type=excluded.type,subtype=excluded.subtype,updated_at=CURRENT_TIMESTAMP
  `).run(externalId,account.id,values.security_id,values.date,values.name,values.quantity,values.amount,values.price,values.fees,values.type,values.subtype);
  if (!previous || Object.keys(values).some(key=>previous[key]!==values[key])) invalidateInvestmentHistory(account.id,values.date);
}

function upsertPlaidTransaction(transaction, investment = false) {
  const account = db.prepare("SELECT id FROM accounts WHERE external_account_id=?").get(transaction.account_id);
  if (!account) return;
  const externalId = `plaid:${investment ? transaction.investment_transaction_id : transaction.transaction_id}`;
  const rawAmount = Number(transaction.amount || 0);
  const kind = investment ? (transaction.type === "transfer" ? "transfer" : "investment") : plaidKind(transaction);
  const amount = kind === "expense" ? -Math.abs(rawAmount) :
    kind === "income" ? Math.abs(rawAmount) :
    investment ? -rawAmount : -rawAmount;
  const category = investment ? monarchCategoryFor({
    kind,
    merchant: transaction.name || "Investment activity",
    category: transaction.subtype || transaction.type,
    investmentType: transaction.type,
    investmentSubtype: transaction.subtype
  }) : plaidCategory(transaction, kind);
  db.prepare(`
    INSERT INTO transactions(account_id,date,merchant,category,amount,kind,note,pending,external_id)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(external_id) DO UPDATE SET
      account_id=excluded.account_id,date=excluded.date,merchant=excluded.merchant,
      category=excluded.category,amount=excluded.amount,kind=excluded.kind,
      note=excluded.note,pending=excluded.pending
  `).run(
    account.id,
    transaction.date || transaction.authorized_date,
    transaction.merchant_name || transaction.name || "Investment activity",
    category,
    amount,
    kind,
    investment ? `${titleCase(transaction.type)}${transaction.quantity ? ` · ${transaction.quantity} units` : ""}` : "",
    transaction.pending ? 1 : 0,
    externalId
  );
  if (investment) saveInvestmentLedger(transaction);
}

async function syncPlaidItem(itemRowId) {
  const item = db.prepare("SELECT * FROM plaid_items WHERE id=?").get(itemRowId);
  if (!item) throw new Error("Connected item not found");
  db.prepare("UPDATE plaid_items SET status='syncing',error_code=NULL WHERE id=?").run(item.id);
  const accountsData = await plaid("/accounts/get", {access_token:item.access_token});
  savePlaidAccounts(item.id, item.institution_name, accountsData.accounts);

  let cursor = item.cursor || undefined, added = 0, modified = 0, removed = 0, transactionsUpdateStatus = null;
  if (accountsData.accounts.some(account => ["depository","credit","loan"].includes(account.type))) {
    let hasMore = true;
    while (hasMore) {
      const data = await plaid("/transactions/sync", {
        access_token:item.access_token,
        ...(cursor ? {cursor} : {}),
        count:500,
        options:{include_original_description:true,personal_finance_category_version:"v2"}
      });
      transactionsUpdateStatus = data.transactions_update_status || transactionsUpdateStatus;
      db.exec("BEGIN");
      try {
        data.added.forEach(transaction => { upsertPlaidTransaction(transaction); added++; });
        data.modified.forEach(transaction => { upsertPlaidTransaction(transaction); modified++; });
        data.removed.forEach(transaction => {
          removed += db.prepare("DELETE FROM transactions WHERE external_id=?").run(`plaid:${transaction.transaction_id}`).changes;
        });
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      cursor = data.next_cursor;
      hasMore = data.has_more;
    }
  }

  let investments = 0;
  let investmentsPending = false;
  if (accountsData.accounts.some(account => account.type === "investment")) {
    try {
      const holdingsData=await plaid("/investments/holdings/get",{access_token:item.access_token});
      saveInvestmentHoldings(item.id,holdingsData.holdings||[],holdingsData.securities||[]);
    } catch (error) {
      if (!["PRODUCT_NOT_READY","PRODUCTS_NOT_SUPPORTED","NO_INVESTMENT_ACCOUNTS"].includes(error.code)) throw error;
      investmentsPending ||= error.code === "PRODUCT_NOT_READY";
    }
    const end = new Date(), start = new Date(end);
    start.setFullYear(end.getFullYear() - 2);
    let offset = 0, total = 1;
    try {
      while (offset < total) {
        const data = await plaid("/investments/transactions/get", {
          access_token:item.access_token,
          start_date:start.toISOString().slice(0,10),
          end_date:end.toISOString().slice(0,10),
          options:{count:500,offset}
        });
        saveInvestmentSecurities(data.securities||[]);
        total = data.total_investment_transactions;
        data.investment_transactions.forEach(transaction => { upsertPlaidTransaction(transaction, true); investments++; });
        offset += data.investment_transactions.length;
        if (!data.investment_transactions.length) break;
      }
    } catch (error) {
      if (!["PRODUCT_NOT_READY","PRODUCTS_NOT_SUPPORTED","NO_INVESTMENT_ACCOUNTS"].includes(error.code)) throw error;
      investmentsPending ||= error.code === "PRODUCT_NOT_READY";
    }
  }
  const transactionsPending = ["NOT_READY","INITIAL_UPDATE_COMPLETE"].includes(transactionsUpdateStatus);
  const pending = transactionsPending || investmentsPending;
  db.prepare(`UPDATE plaid_items SET cursor=?,status=?,error_code=NULL,
    last_sync=CASE WHEN ? THEN last_sync ELSE datetime('now') END WHERE id=?`)
    .run(cursor ?? null,pending?"syncing":"connected",pending?1:0,item.id);
  detectTransfers();
  return {added,modified,removed,investments,pending,transactions_update_status:transactionsUpdateStatus};
}

const activePlaidSyncs = new Map();
const wait = milliseconds => new Promise(resolve=>setTimeout(resolve,milliseconds));

function startPlaidSync(itemId) {
  itemId=Number(itemId);
  if (activePlaidSyncs.has(itemId)) return {item_id:itemId,pending:true,already_running:true};
  if (!db.prepare("SELECT id FROM plaid_items WHERE id=?").get(itemId)) throw new Error("Connected item not found");
  db.prepare("UPDATE plaid_items SET status='syncing',error_code=NULL WHERE id=?").run(itemId);
  const job=(async()=>{
    const totals={item_id:itemId,added:0,modified:0,removed:0,investments:0};
    try {
      for(let attempt=0;attempt<PLAID_SYNC_MAX_ATTEMPTS;attempt++){
        const result=await syncPlaidItem(itemId);
        for(const key of ["added","modified","removed","investments"])totals[key]+=result[key]||0;
        if(!result.pending)return {...totals,pending:false,transactions_update_status:result.transactions_update_status};
        await wait(PLAID_SYNC_RETRY_MS);
      }
      const error=new Error("Plaid is taking longer than expected to prepare this account. Try syncing again.");
      error.code="SYNC_TIMEOUT";
      throw error;
    }catch(error){
      db.prepare("UPDATE plaid_items SET status='sync_error',error_code=? WHERE id=?").run(error.code||"SYNC_ERROR",itemId);
      return {...totals,pending:false,error:error.message,code:error.code||"SYNC_ERROR"};
    }finally{activePlaidSyncs.delete(itemId)}
  })();
  activePlaidSyncs.set(itemId,job);
  return {item_id:itemId,pending:true,already_running:false};
}

function listTransactions(params) {
  const clauses = ["1=1"], values = [];
  if (params.get("from")) { clauses.push("t.date >= ?"); values.push(params.get("from")); }
  if (params.get("to")) { clauses.push("t.date <= ?"); values.push(params.get("to")); }
  if (params.get("kinds")) {
    const kinds = params.get("kinds").split(",").filter(Boolean);
    if (kinds.length) { clauses.push(`t.kind IN (${kinds.map(()=>"?").join(",")})`); values.push(...kinds); }
  }
  if (params.get("accounts")) {
    const ids = params.get("accounts").split(",").filter(Boolean).map(Number);
    if (ids.length) { clauses.push(`t.account_id IN (${ids.map(()=>"?").join(",")})`); values.push(...ids); }
  }
  if (params.get("categories")) {
    const cats = params.get("categories").split(",").filter(Boolean);
    if (cats.length) { clauses.push(`t.category IN (${cats.map(()=>"?").join(",")})`); values.push(...cats); }
  }
  if (params.get("search")) {
    clauses.push("(t.merchant LIKE ? OR t.category LIKE ? OR t.note LIKE ?)");
    const q = `%${params.get("search")}%`; values.push(q,q,q);
  }
  return db.prepare(`
    SELECT t.*, a.name account_name, a.institution, a.color account_color
    FROM transactions t JOIN accounts a ON a.id=t.account_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY t.date DESC, t.id DESC
  `).all(...values).map(transaction => ({
    ...transaction,
    category_group:categoryGroupFor(transaction.category,transaction.kind)
  }));
}

function summary(rows) {
  const totals = { income:0, expense:0, investment:0, transfer:0 };
  const categories = {}, groups = {}, months = {};
  for (const tx of rows) {
    const group = tx.category_group || categoryGroupFor(tx.category,tx.kind);
    if (tx.kind === "income") {
      totals.income += tx.amount;
      groups[`income:${group}`] = (groups[`income:${group}`] || 0) + tx.amount;
    }
    if (tx.kind === "expense") {
      totals.expense += Math.abs(tx.amount);
      categories[tx.category] = (categories[tx.category] || 0) + Math.abs(tx.amount);
      groups[`expense:${group}`] = (groups[`expense:${group}`] || 0) + Math.abs(tx.amount);
    }
    if (tx.kind === "investment") totals.investment += Math.abs(tx.amount);
    if (tx.kind === "transfer") totals.transfer += tx.amount;
    const month = tx.date.slice(0,7);
    months[month] ||= { income:0, expense:0, investment:0 };
    if (tx.kind === "income") months[month].income += tx.amount;
    if (tx.kind === "expense") months[month].expense += Math.abs(tx.amount);
    if (tx.kind === "investment") months[month].investment += Math.abs(tx.amount);
  }
  totals.net = totals.income - totals.expense;
  return {
    totals,
    categories: Object.entries(categories).map(([name,value])=>({name,group:categoryGroupFor(name,"expense"),value})).sort((a,b)=>b.value-a.value),
    groups: Object.entries(groups).map(([key,value])=>{const [kind,...name]=key.split(":");return {name:name.join(":"),kind,value}}).sort((a,b)=>b.value-a.value),
    months: Object.entries(months).map(([month,values])=>({month,...values})).sort((a,b)=>a.month.localeCompare(b.month))
  };
}

function normalizeReportConfiguration(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const filters = source.filters && typeof source.filters === "object" ? source.filters : {};
  const validKinds = new Set(["income","expense","investment","transfer"]);
  const range = ["month","quarter","year","all","custom"].includes(filters.range) ? filters.range : "custom";
  const date = input => /^\d{4}-\d{2}-\d{2}$/.test(String(input || "")) ? String(input) : "";
  const strings = input => Array.isArray(input) ? [...new Set(input.map(item=>String(item).trim()).filter(Boolean))] : [];
  const accounts = Array.isArray(filters.accounts)
    ? [...new Set(filters.accounts.map(Number).filter(id=>Number.isInteger(id) && id > 0))]
    : [];
  return {
    version:1,
    filters:{
      range,
      from:date(filters.from),
      to:date(filters.to),
      kinds:strings(filters.kinds).filter(kind=>validKinds.has(kind)),
      accounts,
      categories:strings(filters.categories),
      search:String(filters.search || "").trim().slice(0,200)
    }
  };
}

function reportView(row) {
  if (!row) return null;
  let configuration;
  try { configuration = normalizeReportConfiguration(JSON.parse(row.configuration_json)); }
  catch { configuration = normalizeReportConfiguration(); }
  const {configuration_json, ...view} = row;
  return {...view, configuration};
}

function listReportViews() {
  return db.prepare("SELECT * FROM report_views ORDER BY name COLLATE NOCASE, id").all().map(reportView);
}

function marketSymbol(security) {
  const ticker=String(security.ticker_symbol||"").trim();
  if (!ticker) return "";
  if ((security.type==="cryptocurrency"||security.subtype==="cryptocurrency")&&!ticker.includes("-")) return `${ticker}-USD`;
  return ticker;
}

async function ensureSecurityPrices(security,from,through) {
  if (security.is_cash_equivalent) return null;
  const symbol=marketSymbol(security);
  if (!symbol) return `${security.name||security.security_id}: no public ticker; using the latest institution price`;
  const prior=db.prepare("SELECT requested_from,attempted_through FROM security_price_fetches WHERE security_id=?").get(security.security_id);
  if (prior&&prior.requested_from<=from&&prior.attempted_through>=through) return null;
  const start=prior?.requested_from&&prior.requested_from<from?prior.requested_from:from;
  const period1=Math.floor(new Date(`${start}T00:00:00Z`).getTime()/1000);
  const end=new Date(`${through}T00:00:00Z`);end.setUTCDate(end.getUTCDate()+2);
  const url=`${MARKET_DATA_BASE}/${encodeURIComponent(symbol)}?${new URLSearchParams({period1:String(period1),period2:String(Math.floor(end.getTime()/1000)),interval:"1d",events:"history,div,splits"})}`;
  try {
    const response=await fetch(url,{headers:{"user-agent":"Mozilla/5.0 Moneta/1.0"}});
    if (!response.ok) throw new Error(`market data returned ${response.status}`);
    const result=(await response.json())?.chart?.result?.[0];
    if (!result) throw new Error("no daily prices returned");
    const timestamps=result.timestamp||[],closes=result.indicators?.quote?.[0]?.close||[];
    const save=db.prepare(`INSERT INTO security_prices(security_id,date,close,source) VALUES(?,?,?,'yahoo') ON CONFLICT(security_id,date) DO UPDATE SET close=excluded.close,source='yahoo'`);
    timestamps.forEach((timestamp,index)=>{
      const close=Number(closes[index]);
      if(Number.isFinite(close))save.run(security.security_id,new Date(timestamp*1000).toISOString().slice(0,10),close);
    });
    db.prepare(`
      INSERT INTO security_price_fetches(security_id,requested_from,attempted_through) VALUES(?,?,?)
      ON CONFLICT(security_id) DO UPDATE SET requested_from=MIN(requested_from,excluded.requested_from),
        attempted_through=MAX(attempted_through,excluded.attempted_through),updated_at=CURRENT_TIMESTAMP
    `).run(security.security_id,start,through);
    return timestamps.length?null:`${security.name||symbol}: no daily prices returned; using transaction and institution prices`;
  } catch (error) {
    db.prepare(`
      INSERT INTO security_price_fetches(security_id,requested_from,attempted_through) VALUES(?,?,?)
      ON CONFLICT(security_id) DO UPDATE SET requested_from=MIN(requested_from,excluded.requested_from),
        attempted_through=MAX(attempted_through,excluded.attempted_through),updated_at=CURRENT_TIMESTAMP
    `).run(security.security_id,start,through);
    return `${security.name||symbol}: ${error.message}; using transaction and institution prices`;
  }
}

async function reconstructInvestmentAccount(account,through) {
  const state=db.prepare("SELECT reconstructed_through,invalidated_from FROM investment_reconstruction_state WHERE account_id=?").get(account.id);
  if (state?.reconstructed_through>=through&&!state.invalidated_from) return {account_id:account.id,through,extended:false,warnings:[]};
  const ledger=db.prepare("SELECT * FROM investment_ledger WHERE account_id=? ORDER BY date,external_id").all(account.id);
  const holdings=db.prepare(`
    SELECT h.*,s.ticker_symbol,s.name security_name,s.type security_type,s.subtype security_subtype,
      s.is_cash_equivalent,s.close_price,s.close_price_as_of
    FROM investment_holdings h JOIN investment_securities s ON s.security_id=h.security_id
    WHERE h.account_id=?
  `).all(account.id);
  if (!ledger.length&&!holdings.length) return {account_id:account.id,through,extended:false,warnings:[`${account.name}: sync holdings and investment transactions before reconstruction`]};
  const start=ledger[0]?.date||through;
  const securityIds=[...new Set([...ledger.map(row=>row.security_id),...holdings.map(row=>row.security_id)].filter(Boolean))];
  const securities=securityIds.length?db.prepare(`SELECT * FROM investment_securities WHERE security_id IN (${securityIds.map(()=>"?").join(",")})`).all(...securityIds):[];
  const warnings=[];
  for(let index=0;index<securities.length;index+=6){
    const results=await Promise.all(securities.slice(index,index+6).map(security=>ensureSecurityPrices(security,start,through)));
    warnings.push(...results.filter(Boolean));
  }
  const saveExecutionPrice=db.prepare("INSERT OR IGNORE INTO security_prices(security_id,date,close,source) VALUES(?,?,?,'execution')");
  ledger.forEach(row=>{if(row.security_id&&row.price>0)saveExecutionPrice.run(row.security_id,row.date,row.price)});
  const prices=securityIds.length?db.prepare(`SELECT security_id,date,close FROM security_prices WHERE security_id IN (${securityIds.map(()=>"?").join(",")}) AND date<=? ORDER BY date`).all(...securityIds,through):[];
  const pricesByDate=new Map(),lastPrices=new Map();
  prices.forEach(row=>{
    if(row.date<start)lastPrices.set(row.security_id,row.close);
    else{if(!pricesByDate.has(row.date))pricesByDate.set(row.date,[]);pricesByDate.get(row.date).push(row)}
  });
  holdings.forEach(holding=>{if(!lastPrices.has(holding.security_id)&&Number(holding.institution_price)>0)lastPrices.set(holding.security_id,Number(holding.institution_price))});
  const currentQuantities=new Map(holdings.map(holding=>[holding.security_id,Number(holding.quantity||0)]));
  const quantities=new Map(currentQuantities);
  for(const row of ledger)if(row.security_id)quantities.set(row.security_id,(quantities.get(row.security_id)||0)-Number(row.quantity||0));
  const currentSecurities=holdings.reduce((sum,holding)=>sum+Number(holding.institution_value||Number(holding.quantity||0)*Number(holding.institution_price||0)),0);
  const cashDelta=ledger.reduce((sum,row)=>sum-Number(row.amount||0),0);
  let cash=Number(account.balance)-currentSecurities-cashDelta;
  const events=new Map();ledger.forEach(row=>{if(!events.has(row.date))events.set(row.date,[]);events.get(row.date).push(row)});
  const exact=new Map(db.prepare("SELECT date,balance FROM account_balance_history WHERE account_id=? AND source!='reconstructed' AND date>=? AND date<=?").all(account.id,start,through).map(row=>[row.date,row.balance]));
  const saveBalance=db.prepare("INSERT OR IGNORE INTO account_balance_history(account_id,date,balance,source) VALUES(?,?,?,'reconstructed')");
  let written=0;
  db.exec("BEGIN");
  try{
    for(let cursor=new Date(`${start}T12:00:00Z`);cursor<=new Date(`${through}T12:00:00Z`);cursor.setUTCDate(cursor.getUTCDate()+1)){
      const date=cursor.toISOString().slice(0,10);
      for(const row of events.get(date)||[]){
        if(row.security_id)quantities.set(row.security_id,(quantities.get(row.security_id)||0)+Number(row.quantity||0));
        cash-=Number(row.amount||0);
      }
      for(const price of pricesByDate.get(date)||[])lastPrices.set(price.security_id,price.close);
      let value=cash;
      for(const [securityId,quantity] of quantities){
        if(Math.abs(quantity)<1e-10)continue;
        const price=lastPrices.get(securityId);
        if(Number.isFinite(price))value+=quantity*price;
      }
      if(exact.has(date)){cash+=exact.get(date)-value;value=exact.get(date)}
      written+=saveBalance.run(account.id,date,value).changes;
    }
    db.exec("COMMIT");
  }catch(error){db.exec("ROLLBACK");throw error}
  db.prepare(`
    INSERT INTO investment_reconstruction_state(account_id,reconstructed_through,invalidated_from)
    VALUES(?,?,NULL) ON CONFLICT(account_id) DO UPDATE SET reconstructed_through=excluded.reconstructed_through,
      invalidated_from=NULL,updated_at=CURRENT_TIMESTAMP
  `).run(account.id,through);
  return {account_id:account.id,through,extended:Boolean(written),days_written:written,warnings};
}

async function ensureInvestmentHistories(accountIds,through) {
  const selected=Array.isArray(accountIds)&&accountIds.length;
  const where=selected?`AND id IN (${accountIds.map(()=>"?").join(",")})`:"";
  const accounts=db.prepare(`SELECT id,name,balance FROM accounts WHERE type='investment' ${where}`).all(...(selected?accountIds:[]));
  const results=[];
  for(const account of accounts)results.push(await reconstructInvestmentAccount(account,through));
  return {accounts:results,warnings:results.flatMap(result=>result.warnings)};
}

function netWorthHistory(params) {
  const requestedIds = (params.get("accounts") || "").split(",").map(Number).filter(id=>Number.isInteger(id)&&id>0);
  const accountFilter = params.has("accounts");
  if (accountFilter && !requestedIds.length) return {history:[],accounts:[],latest:0,change:0,snapshot_dates:0};
  const where = accountFilter ? `WHERE id IN (${requestedIds.map(()=>"?").join(",")})` : "";
  const accounts = db.prepare(`SELECT id,institution,name,type,balance,color FROM accounts ${where} ORDER BY id`).all(...requestedIds);
  if (!accounts.length) return {history:[],accounts:[],latest:0,change:0,snapshot_dates:0};

  const ids = accounts.map(account=>account.id), placeholders = ids.map(()=>"?").join(",");
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "";
  const today = new Date().toISOString().slice(0,10);
  let to = validDate(params.get("to")) || today;
  if (to > today) to = today;
  const earliest = db.prepare(`
    SELECT MIN(date) date FROM (
      SELECT date FROM transactions WHERE account_id IN (${placeholders})
      UNION ALL SELECT date FROM account_balance_history WHERE account_id IN (${placeholders})
    )
  `).get(...ids,...ids)?.date;
  const defaultStart = new Date(`${today}T12:00:00Z`);defaultStart.setUTCDate(defaultStart.getUTCDate()-89);
  let from = validDate(params.get("from")) || earliest || defaultStart.toISOString().slice(0,10);
  const limit = new Date(`${today}T12:00:00Z`);limit.setUTCFullYear(limit.getUTCFullYear()-5);
  if (from < limit.toISOString().slice(0,10)) from = limit.toISOString().slice(0,10);
  if (from > to) from = to;

  const transactions = db.prepare(`
    SELECT account_id,date,SUM(amount) amount FROM transactions
    WHERE account_id IN (${placeholders}) AND date>=? AND date<=?
    GROUP BY account_id,date
  `).all(...ids,from,today);
  const snapshots = db.prepare(`
    SELECT account_id,date,balance,source FROM account_balance_history
    WHERE account_id IN (${placeholders}) AND date>=? AND date<=?
  `).all(...ids,from,today);
  const txByAccount = new Map(), snapshotsByAccount = new Map();
  transactions.forEach(row=>{if(!txByAccount.has(row.account_id))txByAccount.set(row.account_id,new Map());txByAccount.get(row.account_id).set(row.date,row.amount)});
  snapshots.forEach(row=>{if(!snapshotsByAccount.has(row.account_id))snapshotsByAccount.set(row.account_id,new Map());snapshotsByAccount.get(row.account_id).set(row.date,row.balance)});

  const totals = new Map();
  for (const account of accounts) {
    let balance = account.balance;
    const tx = account.type === "investment" ? new Map() : (txByAccount.get(account.id) || new Map());
    const known = snapshotsByAccount.get(account.id) || new Map();
    for (let cursor = new Date(`${today}T12:00:00Z`); cursor >= new Date(`${from}T12:00:00Z`); cursor.setUTCDate(cursor.getUTCDate()-1)) {
      const date = cursor.toISOString().slice(0,10);
      if (known.has(date)) balance = known.get(date);
      if (date <= to) totals.set(date,(totals.get(date)||0)+balance);
      balance -= tx.get(date) || 0;
    }
  }
  const history = [...totals].map(([date,value])=>({date,value})).sort((a,b)=>a.date.localeCompare(b.date));
  return {
    history,
    accounts,
    latest:accounts.reduce((sum,account)=>sum+account.balance,0),
    change:history.length>1?history.at(-1).value-history[0].value:0,
    snapshot_dates:new Set(snapshots.filter(snapshot=>snapshot.source!=="reconstructed").map(snapshot=>snapshot.date)).size
  };
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    const accounts = db.prepare(`
      SELECT a.*, p.status plaid_status, p.last_sync plaid_last_sync
      FROM accounts a LEFT JOIN plaid_items p ON p.id=a.plaid_item_id ORDER BY a.id
    `).all();
    const transactions = listTransactions(url.searchParams);
    const dbCategories = db.prepare("SELECT DISTINCT category,kind FROM transactions ORDER BY category").all();
    const categories = [...new Set([...MONARCH_CATEGORIES, ...dbCategories.map(row=>row.category)])];
    return json(res, {accounts, transactions, categories, category_groups:categoryTaxonomy(dbCategories), views:listReportViews(), summary:summary(transactions)});
  }
  if (req.method === "GET" && url.pathname === "/api/settings") {
    return json(res,publicSettings());
  }
  if (req.method === "PUT" && url.pathname === "/api/settings/plaid") {
    const value=await body(req);
    const clientId=String(value.client_id||"").trim().slice(0,300);
    const environment=String(value.environment||"sandbox");
    const redirectUri=String(value.redirect_uri||"").trim().slice(0,1000);
    if(!["sandbox","development","production"].includes(environment))
      return json(res,{error:"Choose Sandbox, Development, or Production."},400);
    if(redirectUri&&!validPlaidRedirectUri(redirectUri,environment))
      return json(res,{error:"Redirect URI must be HTTPS without a query or fragment. Sandbox also allows HTTP localhost URLs."},400);
    db.exec("BEGIN");
    try {
      saveSetting.run("plaid_client_id",clientId);
      saveSetting.run("plaid_environment",environment);
      saveSetting.run("plaid_redirect_uri",redirectUri);
      if(value.clear_secret)saveSetting.run("plaid_secret","");
      else if(String(value.secret||"").trim())saveSetting.run("plaid_secret",String(value.secret).trim().slice(0,500));
      db.exec("COMMIT");
    } catch(error) { db.exec("ROLLBACK"); throw error; }
    return json(res,publicSettings());
  }
  if (req.method === "POST" && url.pathname === "/api/settings/demo-data") {
    return json(res,{...generateDemoData(),settings:publicSettings()},201);
  }
  if (req.method === "POST" && url.pathname === "/api/views") {
    const value = await body(req);
    const name = String(value.name || "").trim().slice(0,80);
    if (!name) return json(res,{error:"A report view name is required"},400);
    const configuration = normalizeReportConfiguration(value.configuration);
    const result = db.prepare("INSERT INTO report_views(name,configuration_json) VALUES(?,?)")
      .run(name,JSON.stringify(configuration));
    return json(res,reportView(db.prepare("SELECT * FROM report_views WHERE id=?").get(Number(result.lastInsertRowid))),201);
  }
  if (req.method === "GET" && /^\/api\/views\/\d+$/.test(url.pathname)) {
    const view = reportView(db.prepare("SELECT * FROM report_views WHERE id=?").get(Number(url.pathname.split("/").pop())));
    if (!view) return json(res,{error:"Report view not found"},404);
    return json(res,view);
  }
  if (req.method === "DELETE" && /^\/api\/views\/\d+$/.test(url.pathname)) {
    const result = db.prepare("DELETE FROM report_views WHERE id=?").run(Number(url.pathname.split("/").pop()));
    if (!result.changes) return json(res,{error:"Report view not found"},404);
    return json(res,{ok:true});
  }
  if (req.method === "GET" && url.pathname === "/api/plaid/status") {
    const configuration=plaidConfiguration();
    const items = db.prepare("SELECT id,institution_id,institution_name,status,error_code,last_sync,created_at FROM plaid_items ORDER BY id").all();
    return json(res, {configured:plaidConfigured(),environment:configuration.environment,redirect:plaidRedirectStatus(configuration),items});
  }
  if (req.method === "GET" && url.pathname === "/api/net-worth") {
    const accountIds=(url.searchParams.get("accounts")||"").split(",").map(Number).filter(id=>Number.isInteger(id)&&id>0);
    const reconstruction=await ensureInvestmentHistories(url.searchParams.has("accounts")?accountIds:null,new Date().toISOString().slice(0,10));
    return json(res,{...netWorthHistory(url.searchParams),reconstruction});
  }
  if (req.method === "POST" && url.pathname === "/api/plaid/link-token") {
    if (!plaidConfigured()) return json(res,{error:"Plaid is not configured. Add your client ID and secret in Settings."},503);
    const value = await body(req);
    const investment = value.connection_type === "investment";
    const payload = {
      client_name:"Moneta",
      language:"en",
      country_codes:["US"],
      user:{client_user_id:"moneta-local-user"},
      products:[investment ? "investments" : "transactions"],
      optional_products:[investment ? "transactions" : "investments"]
    };
    if (!investment) payload.transactions={days_requested:730};
    const configuration=plaidConfiguration();
    const redirectUri = validPlaidRedirectUri(configuration.redirectUri,configuration.environment);
    if (redirectUri) payload.redirect_uri=redirectUri;
    const data = await plaid("/link/token/create", payload);
    return json(res,{link_token:data.link_token,expiration:data.expiration});
  }
  if (req.method === "POST" && url.pathname === "/api/plaid/exchange") {
    const value = await body(req);
    if (!value.public_token) return json(res,{error:"public_token is required"},400);
    const exchange = await plaid("/item/public_token/exchange", {public_token:value.public_token});
    const institution = value.institution || {};
    db.prepare(`
      INSERT INTO plaid_items(item_id,access_token,institution_id,institution_name,status)
      VALUES(?,?,?,?, ?)
      ON CONFLICT(item_id) DO UPDATE SET access_token=excluded.access_token,
        institution_id=excluded.institution_id,institution_name=excluded.institution_name,status=excluded.status,error_code=NULL
    `).run(exchange.item_id,exchange.access_token,institution.institution_id||null,institution.name||"Connected institution",value.background?"syncing":"connected");
    const item = db.prepare("SELECT id FROM plaid_items WHERE item_id=?").get(exchange.item_id);
    const accounts = await plaid("/accounts/get", {access_token:exchange.access_token});
    savePlaidAccounts(item.id,institution.name||"Connected institution",accounts.accounts,{restoreIgnored:true});
    if(value.background){
      const sync=startPlaidSync(item.id);
      return json(res,{item_id:item.id,accounts:accounts.accounts.length,sync},202);
    }
    let sync;
    try { sync=await syncPlaidItem(item.id); }
    catch (error) {
      db.prepare("UPDATE plaid_items SET status='sync_error',error_code=? WHERE id=?").run(error.code||"SYNC_ERROR",item.id);
      if (error.code !== "PRODUCT_NOT_READY") throw error;
      sync={added:0,modified:0,removed:0,investments:0,pending:true};
    }
    return json(res,{item_id:item.id,accounts:accounts.accounts.length,sync},201);
  }
  if (req.method === "POST" && url.pathname === "/api/plaid/sync") {
    const value=await body(req);
    const items=value.item_id
      ? db.prepare("SELECT id FROM plaid_items WHERE id=?").all(Number(value.item_id))
      : db.prepare("SELECT id FROM plaid_items").all();
    if(value.background){
      const results=items.map(item=>startPlaidSync(item.id));
      return json(res,{results},202);
    }
    const results=[];
    for (const item of items) {
      try { results.push({item_id:item.id,...await syncPlaidItem(item.id)}); }
      catch (error) {
        db.prepare("UPDATE plaid_items SET status='sync_error',error_code=? WHERE id=?").run(error.code||"SYNC_ERROR",item.id);
        results.push({item_id:item.id,error:error.message,code:error.code});
      }
    }
    return json(res,{results},results.some(result=>result.error)?207:200);
  }
  if (req.method === "GET" && url.pathname === "/api/transactions") {
    const rows = listTransactions(url.searchParams);
    return json(res, {transactions:rows, summary:summary(rows)});
  }
  if (req.method === "POST" && url.pathname === "/api/transactions") {
    const v = await body(req);
    if (!v.account_id || !v.date || !v.merchant || !["income","expense","transfer","investment"].includes(v.kind))
      return json(res,{error:"Missing or invalid transaction fields"},400);
    let amount = Math.abs(Number(v.amount));
    const kind = monarchKindFor({kind:v.kind, category:v.category, merchant:v.merchant, amount});
    if (kind === "expense") amount *= -1;
    const category = monarchCategoryFor({kind, category:v.category, merchant:v.merchant});
    const out = db.prepare("INSERT INTO transactions(account_id,date,merchant,category,amount,kind,note,pending) VALUES(?,?,?,?,?,?,?,?)")
      .run(v.account_id,v.date,v.merchant,category,amount,kind,v.note || "",v.pending?1:0);
    return json(res,{id:Number(out.lastInsertRowid)},201);
  }
  if (req.method === "PATCH" && /^\/api\/transactions\/\d+$/.test(url.pathname)) {
    const id = Number(url.pathname.split("/").pop()), v = await body(req);
    const fields = ["date","merchant","category","amount","kind","note","account_id"];
    const present = fields.filter(k=>v[k] !== undefined);
    if (!present.length) return json(res,{error:"No fields to update"},400);
    if (present.includes("category")) {
      const current = db.prepare("SELECT merchant,kind FROM transactions WHERE id=?").get(id);
      v.category = monarchCategoryFor({kind:v.kind || current?.kind, category:v.category, merchant:v.merchant || current?.merchant});
    }
    db.prepare(`UPDATE transactions SET ${present.map(k=>`${k}=?`).join(",")} WHERE id=?`).run(...present.map(k=>v[k]),id);
    return json(res,{ok:true});
  }
  if (req.method === "DELETE" && /^\/api\/transactions\/\d+$/.test(url.pathname)) {
    db.prepare("DELETE FROM transactions WHERE id=?").run(Number(url.pathname.split("/").pop()));
    return json(res,{ok:true});
  }
  if (req.method === "POST" && url.pathname === "/api/import") {
    const v = await body(req);
    if (!v.account_id || !Array.isArray(v.rows)) return json(res,{error:"account_id and rows are required"},400);
    let added=0, skipped=0;
    const insert = db.prepare("INSERT OR IGNORE INTO transactions(account_id,date,merchant,category,amount,kind,note,external_id) VALUES(?,?,?,?,?,?,?,?)");
    db.exec("BEGIN");
    try {
      for (const [i,r] of v.rows.entries()) {
        const amount=Number(r.amount);
        const kind=monarchKindFor({kind:r.kind, category:r.category, merchant:r.merchant, amount});
        const key=r.external_id || `import-${v.account_id}-${r.date}-${r.merchant}-${amount}-${i}`;
        const category=monarchCategoryFor({kind,category:r.category,merchant:r.merchant});
        const result=insert.run(v.account_id,r.date,r.merchant,category,amount,kind,r.note||"",key);
        result.changes ? added++ : skipped++;
      }
      db.exec("COMMIT");
    } catch(e) { db.exec("ROLLBACK"); throw e; }
    detectTransfers();
    return json(res,{added,skipped});
  }
  if (req.method === "POST" && url.pathname === "/api/detect-transfers") {
    return json(res,detectTransfers());
  }
  if (req.method === "POST" && url.pathname === "/api/accounts") {
    const v=await body(req);
    if (!v.institution || !v.name || !v.type) return json(res,{error:"Missing account fields"},400);
    const r=db.prepare("INSERT INTO accounts(institution,name,type,balance,color,last_sync) VALUES(?,?,?,?,?,datetime('now'))")
      .run(v.institution,v.name,v.type,Number(v.balance||0),v.color||"#6d5dfc");
    const id=Number(r.lastInsertRowid);snapshotAccountBalances([id],"manual");
    return json(res,{id},201);
  }
  if (req.method === "DELETE" && /^\/api\/accounts\/\d+$/.test(url.pathname)) {
    const id = Number(url.pathname.split("/").pop());
    const result = removeAccount(id);
    if (!result) return json(res,{error:"Account not found"},404);
    return json(res,{
      ok:true,
      transactions_deleted:result.transactionsDeleted,
      disconnected_item:result.disconnectedItem
    });
  }
  return false;
}

function detectTransfers() {
  const candidates=db.prepare(`
    SELECT t.* FROM transactions t WHERE t.transfer_pair_id IS NULL
      AND (t.kind='transfer' OR lower(t.category) LIKE '%payment%' OR lower(t.merchant) LIKE '%payment%')
    ORDER BY t.date
  `).all();
  let matched=0;
  for (let i=0;i<candidates.length;i++) for(let j=i+1;j<candidates.length;j++) {
    const a=candidates[i], b=candidates[j];
    const days=Math.abs((new Date(a.date)-new Date(b.date))/86400000);
    if (a.account_id!==b.account_id && days<=4 && Math.abs(a.amount+b.amount)<0.01 && !a.transfer_pair_id && !b.transfer_pair_id) {
      db.prepare("UPDATE transactions SET kind='transfer',category='Credit Card Payment',transfer_pair_id=? WHERE id=?").run(b.id,a.id);
      db.prepare("UPDATE transactions SET kind='transfer',category='Credit Card Payment',transfer_pair_id=? WHERE id=?").run(a.id,b.id);
      a.transfer_pair_id=b.id; b.transfer_pair_id=a.id; matched++;
    }
  }
  return {matched};
}

const mime={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".svg":"image/svg+xml"};
createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,`http://${req.headers.host}`);
    if(url.pathname.startsWith("/api/")) {
      const handled=await api(req,res,url);
      if(handled===false) json(res,{error:"Not found"},404);
      return;
    }
    const appRoute = ["/","/overview","/cash-flow","/net-worth","/transactions","/accounts","/insights","/settings"].includes(url.pathname)
      || /^\/views\/\d+\/?$/.test(url.pathname);
    const path=appRoute ? "public/index.html" : normalize(`public${url.pathname}`);
    if(!path.startsWith("public")) return json(res,{error:"Forbidden"},403);
    const data=await readFile(join(ROOT,path));
    res.writeHead(200,{"content-type":mime[extname(path)]||"application/octet-stream"});
    res.end(data);
  } catch(e) {
    if(e.code==="ENOENT") return json(res,{error:"Not found"},404);
    console.error(e); json(res,{error:e.message||"Server error"},500);
  }
}).listen(PORT,HOST,()=>console.log(`Moneta is running at http://localhost:${PORT}`));
