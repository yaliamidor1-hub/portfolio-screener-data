/**
 * build_facts.mjs — multi-year, deterministic company facts from the XBRL bundles, no network:
 *   data/<TICKER>.json (fetch_sec.mjs)  ->  data/facts/<TICKER>.json
 *
 * Annual (full-year, 10-K / 20-F / 40-F) values per fiscal year end, up to the 6 latest years:
 *   revenue, grossProfit, operatingIncome, netIncome, operatingCashFlow, capex, freeCashFlow (= operating cash flow - capex,
 *   only when both exist for that year), cash, longTermDebt, shortTermDebt, equity (balance-sheet values at that year end),
 * plus derived revenue / net income growth and margins. A value that is not in the filings is null — never 0 and never
 * summed from missing pieces. Only USD facts are used (other currencies: the company is listed with `currency` and no values).
 * The Stage 2 reviews cite these facts, and the Apps Script verification checks report numbers against them.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY_MS = 86_400_000;
export const FACT_YEARS = 6;

const ANNUAL_FORM = /^(10-K|20-F|40-F)/;
const FLOW = {   // duration facts, first tag with a value for a year wins
  revenue: ['us-gaap/Revenues', 'us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax', 'us-gaap/SalesRevenueNet', 'ifrs-full/Revenue'],
  grossProfit: ['us-gaap/GrossProfit'],
  operatingIncome: ['us-gaap/OperatingIncomeLoss'],
  netIncome: ['us-gaap/NetIncomeLoss', 'ifrs-full/ProfitLoss'],
  operatingCashFlow: ['us-gaap/NetCashProvidedByUsedInOperatingActivities', 'us-gaap/NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  capex: ['us-gaap/PaymentsToAcquirePropertyPlantAndEquipment', 'us-gaap/PaymentsToAcquireProductiveAssets'],
};
const STOCK = {  // instant (balance sheet) facts at the year end
  cash: ['us-gaap/CashAndCashEquivalentsAtCarryingValue'],
  longTermDebt: ['us-gaap/LongTermDebtNoncurrent', 'us-gaap/LongTermDebt', 'ifrs-full/Borrowings'],
  shortTermDebt: ['us-gaap/DebtCurrent', 'us-gaap/ShortTermBorrowings'],
  equity: ['us-gaap/StockholdersEquity', 'us-gaap/StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest', 'ifrs-full/EquityAttributableToOwnersOfParent', 'ifrs-full/Equity'],
};

/** USD entries of one tag in a bundle ([] when absent / another currency only). */
function usdEntries(bundle, tag) {
  const c = bundle && bundle.tags && bundle.tags[tag];
  const list = c && c.units && c.units.USD;
  return Array.isArray(list) ? list : [];
}

/** { 'yyyy-MM-dd': value } of the full-year values of a flow tag (latest filing of the year wins). */
export function annualValues(bundle, tag) {
  const best = {};
  for (const e of usdEntries(bundle, tag)) {
    if (!e.start || !ANNUAL_FORM.test(String(e.form))) continue;
    const days = (Date.parse(e.end) - Date.parse(e.start)) / DAY_MS;
    if (days < 340 || days > 390) continue;
    if (!best[e.end] || String(e.filed) > String(best[e.end].filed)) best[e.end] = e;
  }
  return Object.fromEntries(Object.entries(best).map(([end, e]) => [end, e.val]));
}

/** { 'yyyy-MM-dd': value } of an instant tag at the given ends. */
export function instantValues(bundle, tag, ends) {
  const want = new Set(ends), best = {};
  for (const e of usdEntries(bundle, tag)) {
    if (e.start || !want.has(e.end)) continue;
    if (!best[e.end] || String(e.filed) > String(best[e.end].filed)) best[e.end] = e;
  }
  return Object.fromEntries(Object.entries(best).map(([end, e]) => [end, e.val]));
}

const pick = (maps, end) => { for (const m of maps) if (m[end] !== undefined) return m[end]; return null; };
const ratio = (a, b) => (typeof a === 'number' && typeof b === 'number' && b !== 0 ? a / b : null);
const round = (x, d = 4) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

/** One bundle -> facts object (see the header). Returns null when the bundle has no annual revenue / net income / cash flow. */
export function buildFacts(bundle) {
  if (!bundle || !bundle.tags) return null;
  const flow = {};
  for (const [k, tags] of Object.entries(FLOW)) flow[k] = tags.map((t) => annualValues(bundle, t));
  const ends = [...new Set(Object.values(flow).flat().flatMap((m) => Object.keys(m)))].sort().reverse().slice(0, FACT_YEARS);
  if (!ends.length) return null;
  const stock = {};
  for (const [k, tags] of Object.entries(STOCK)) stock[k] = tags.map((t) => instantValues(bundle, t, ends));

  const years = ends.map((end) => {
    const y = { end };
    for (const k of Object.keys(FLOW)) y[k] = pick(flow[k], end);
    for (const k of Object.keys(STOCK)) y[k] = pick(stock[k], end);
    y.freeCashFlow = typeof y.operatingCashFlow === 'number' && typeof y.capex === 'number' ? y.operatingCashFlow - Math.abs(y.capex) : null;
    return y;
  });
  // derived, only between consecutive fiscal years (about a year apart)
  years.forEach((y, i) => {
    const prev = years[i + 1];
    const gap = prev ? (Date.parse(y.end) - Date.parse(prev.end)) / DAY_MS : 0;
    const consecutive = prev && gap > 340 && gap < 390;
    y.revenueGrowth = consecutive && prev.revenue > 0 ? round(ratio(y.revenue, prev.revenue) - 1) : null;
    y.netIncomeGrowth = consecutive && prev.netIncome > 0 ? round(ratio(y.netIncome, prev.netIncome) - 1) : null;
    y.grossMargin = round(ratio(y.grossProfit, y.revenue));
    y.operatingMargin = round(ratio(y.operatingIncome, y.revenue));
    y.netMargin = round(ratio(y.netIncome, y.revenue));
    y.fcfMargin = round(ratio(y.freeCashFlow, y.revenue));
    y.cashConversion = y.netIncome > 0 ? round(ratio(y.freeCashFlow, y.netIncome)) : null;
  });
  const hasData = years.some((y) => y.revenue !== null || y.netIncome !== null || y.operatingCashFlow !== null);
  if (!hasData) return null;
  return { ticker: bundle.ticker, cik: bundle.cik, generatedAt: bundle.generatedAt, source: 'SEC EDGAR XBRL (companyconcept), annual filings', currency: 'USD', years };
}

export async function run({ root, log = console.log } = {}) {
  const dataDir = path.join(root, 'data'), outDir = path.join(dataDir, 'facts');
  await mkdir(outDir, { recursive: true });
  const files = (await readdir(dataDir)).filter((f) => f.endsWith('.json') && f !== 'meta.json');
  let written = 0, unchanged = 0, none = [];
  for (const f of files) {
    let bundle;
    try { bundle = JSON.parse(await readFile(path.join(dataDir, f), 'utf8')); } catch { none.push(f.replace('.json', '') + '(unreadable)'); continue; }
    const facts = buildFacts(bundle);
    if (!facts) { none.push(f.replace('.json', '')); continue; }
    const out = path.join(outDir, f), text = JSON.stringify(facts, null, 1) + '\n';
    let prev = '';
    try { prev = await readFile(out, 'utf8'); } catch { prev = ''; }
    if (prev === text) { unchanged++; continue; }
    await writeFile(out, text); written++;
  }
  log(`facts: ${written} written, ${unchanged} unchanged, ${none.length} without annual data${none.length ? ' (' + none.slice(0, 12).join(', ') + (none.length > 12 ? ', …' : '') + ' - the bundle has no annual revenue / net income / cash flow yet)' : ''}`);
  return { written, unchanged, none };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') }).catch((e) => { console.log('::warning::build_facts failed: ' + (e && e.message ? e.message : e)); });
}
