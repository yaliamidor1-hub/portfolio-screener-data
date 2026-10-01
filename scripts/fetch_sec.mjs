#!/usr/bin/env node
/**
 * fetch_sec.mjs — downloads SEC EDGAR XBRL "companyconcept" data for the tickers in
 * tickers.txt and writes one bundle per ticker to data/<TICKER>.json:
 *   { ticker, cik, generatedAt, tags: { "<taxonomy>/<TAG>": <trimmed concept JSON> } }
 * plus data/meta.json (run summary). Node 20+, no dependencies (built-in fetch).
 *
 * Why this exists: SEC answers HTTP 403 to Google Apps Script, so the Apps Script project
 * reads these files from raw.githubusercontent.com instead of calling SEC itself.
 *
 * Needs env SEC_CONTACT_EMAIL (a GitHub Actions secret). SEC's fair-access rules require
 * a User-Agent with a contact. The email is NEVER written to a file or printed.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Tags the Apps Script backup computation (debtToEquity, fcfYield) reads, "<taxonomy>/<TAG>".
 * KEEP IDENTICAL to EDGAR_TAGS in the Apps Script project's src/Edgar.gs; a test there compares them.
 */
export const EDGAR_TAGS = [
  'us-gaap/LongTermDebtNoncurrent',
  'us-gaap/DebtCurrent',
  'us-gaap/LongTermDebt',
  'us-gaap/ShortTermBorrowings',
  'us-gaap/StockholdersEquity',
  'us-gaap/StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
  'us-gaap/NetCashProvidedByUsedInOperatingActivities',
  'us-gaap/NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
  'us-gaap/PaymentsToAcquirePropertyPlantAndEquipment',
  'us-gaap/PaymentsToAcquireProductiveAssets',
  'ifrs-full/Borrowings',
  'ifrs-full/EquityAttributableToOwnersOfParent',
  'ifrs-full/Equity',
  'dei/EntityCommonStockSharesOutstanding',
];

/**
 * Extra tags for the multi-year facts files (scripts/build_facts.mjs -> data/facts/<TICKER>.json): revenue, profit,
 * operating income, gross profit, cash. Apps Script does not read these; the reviews and the verification do.
 */
export const FACTS_TAGS = [
  'us-gaap/Revenues',
  'us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax',
  'us-gaap/SalesRevenueNet',
  'us-gaap/NetIncomeLoss',
  'us-gaap/OperatingIncomeLoss',
  'us-gaap/GrossProfit',
  'us-gaap/CashAndCashEquivalentsAtCarryingValue',
  'ifrs-full/Revenue',
  'ifrs-full/ProfitLoss',
];
export const TAGS = [...EDGAR_TAGS, ...FACTS_TAGS];

export const KEEP_PERIODS = 12;            // most recent distinct period ends kept per tag
export const KEEP_ANNUAL = 6;              // ... plus the ends of the most recent annual (full-year) facts
export const MIN_INTERVAL_MS = 220;        // <= ~4.5 requests/second (SEC allows 10)
export const MAX_ATTEMPTS = 4;             // per request, on 429 / 5xx / network errors
export const REFRESH_AFTER_DAYS = 3;       // rewrite an unchanged bundle at least this often
const ALLOWED_FORMS = new Set(['10-K', '10-K/A', '10-Q', '10-Q/A', '20-F', '20-F/A', '40-F', '40-F/A']);
const DAY_MS = 86_400_000;

/* ---------- pure helpers (unit-tested) ---------- */

/** "brk.b" -> "BRK-B": the spelling used by SEC's ticker list and by the file names. */
export function normalizeTicker(t) {
  return String(t).trim().toUpperCase().replace(/\./g, '-');
}

/** tickers.txt -> [{ ticker, cik|null }]. Lines: "TICKER" or "TICKER,CIK"; '#' comments. */
export function parseTickers(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const parts = line.split(/[,\s]+/);
    if (parts.length > 2 || (parts[1] && !/^\d{1,10}$/.test(parts[1]))) continue; // malformed line
    const [t, c] = parts;
    const ticker = normalizeTicker(t);
    if (!/^[A-Z0-9-]{1,12}$/.test(ticker) || seen.has(ticker)) continue;
    seen.add(ticker);
    const cik = c && /^\d{1,10}$/.test(c) ? Number(c) : null;
    out.push({ ticker, cik });
  }
  return out;
}

/**
 * Keep only what the consumer needs from one companyconcept response: entries from
 * annual/quarterly filings whose period `end` is among the KEEP_PERIODS most recent
 * distinct ends, slimmed to { start?, end, val, form, filed }. Shape stays
 * { taxonomy, tag, units: { <unit>: [...] } }. Returns null if nothing is left.
 */
export function trimConcept(concept, keep = KEEP_PERIODS) {
  if (!concept || typeof concept.units !== 'object' || !concept.units) return null;
  const units = {};
  for (const [unit, list] of Object.entries(concept.units)) {
    if (!Array.isArray(list)) continue;
    const ok = list.filter((e) => e && e.end && typeof e.val === 'number' && Number.isFinite(e.val) && ALLOWED_FORMS.has(e.form));
    const ends = [...new Set(ok.map((e) => e.end))].sort().reverse().slice(0, keep);
    const keepEnds = new Set(ends);
    // full-year facts of annual filings: the quarters crowd the latest 12 ends, so older fiscal years would be lost
    const annualEnds = [...new Set(ok.filter((e) => isAnnualFact(e)).map((e) => e.end))].sort().reverse().slice(0, KEEP_ANNUAL);
    annualEnds.forEach((e) => keepEnds.add(e));
    const slim = ok
      .filter((e) => keepEnds.has(e.end))
      .map((e) => (e.start ? { start: e.start, end: e.end, val: e.val, form: e.form, filed: e.filed } : { end: e.end, val: e.val, form: e.form, filed: e.filed }))
      .sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : String(a.filed) < String(b.filed) ? 1 : -1));
    if (slim.length) units[unit] = slim;
  }
  if (!Object.keys(units).length) return null;
  return { taxonomy: concept.taxonomy, tag: concept.tag, units };
}

/** A duration fact of about a year reported in an annual filing (10-K / 20-F / 40-F). */
export function isAnnualFact(e) {
  if (!e || !e.start || !e.end || !/^(10-K|20-F|40-F)/.test(String(e.form))) return false;
  const days = (Date.parse(e.end) - Date.parse(e.start)) / 86_400_000;
  return days >= 340 && days <= 390;
}

/** Pad a CIK to the 10 digits SEC's URLs use. */
export function cik10(cik) {
  return String(cik).padStart(10, '0');
}

/**
 * Should an existing, unchanged bundle be left untouched (avoids a daily commit for every
 * file)? Only while its generatedAt is still recent, so the freshness the consumer checks
 * (5 days) is never allowed to lapse.
 */
export function canKeepBundle(prev, cik, tags, nowMs) {
  if (!prev || prev.cik !== cik) return false;
  const t = Date.parse(prev.generatedAt);
  if (!Number.isFinite(t) || nowMs - t >= REFRESH_AFTER_DAYS * DAY_MS) return false;
  return JSON.stringify(prev.tags) === JSON.stringify(tags);
}

/* ---------- HTTP ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;

async function pace() {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

/**
 * GET with pacing and retry/backoff. 404 is a normal answer (e.g. a company that does not
 * use a tag): { status: 404 }. Never logs headers (the User-Agent holds the email).
 * mode 'json' -> data = parsed JSON; 'text' -> data = response text.
 * Returns { status, data?, error? }.
 */
async function request(url, userAgent, fetchImpl, mode) {
  let last = { status: 0, error: 'no attempt' };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await pace();
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': userAgent, Accept: mode === 'json' ? 'application/json' : 'text/html,application/xhtml+xml,*/*' },
        signal: AbortSignal.timeout(90_000),
      });
      if (res.status === 200) {
        try { return { status: 200, data: mode === 'json' ? await res.json() : await res.text() }; }
        catch { return { status: 200, error: mode === 'json' ? 'invalid JSON' : 'unreadable body' }; }
      }
      if (res.status === 404) return { status: 404 };
      last = { status: res.status, error: `HTTP ${res.status}` };
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 1000 * 2 ** (attempt - 1));
        continue;
      }
      return last; // 403 etc.: not retryable
    } catch (e) {
      last = { status: 0, error: `network error: ${e?.cause?.code ?? e?.code ?? 'unknown'}` };
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  return last;
}

export const getJson = (url, userAgent, fetchImpl = fetch) => request(url, userAgent, fetchImpl, 'json');
export const getText = (url, userAgent, fetchImpl = fetch) => request(url, userAgent, fetchImpl, 'text');
/* ---------- main ---------- */

async function readJsonIfExists(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

export async function run({ root, email, now = () => Date.now(), fetchImpl = fetch, log = console.log } = {}) {
  const userAgent = `PortfolioScreener/1.0 (${email})`;
  const dataDir = path.join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const tickers = parseTickers(await readFile(path.join(root, 'tickers.txt'), 'utf8'));
  const generatedAt = new Date(now()).toISOString();
  const meta = { generatedAt, tickersTotal: tickers.length, succeeded: 0, unchanged: 0, failed: 0, tagCount: TAGS.length, failures: [] };
  const writeMeta = () => writeFile(path.join(dataDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

  // ticker -> CIK from SEC's list (a CIK given in tickers.txt wins)
  const needMap = tickers.some((t) => !t.cik);
  let map = {};
  if (needMap) {
    const r = await getJson('https://www.sec.gov/files/company_tickers.json', userAgent, fetchImpl);
    if (r.status !== 200 || !r.data) {
      meta.error = `company_tickers.json unavailable (${r.error ?? 'HTTP ' + r.status}); no data files were touched`;
      meta.failed = tickers.length;
      meta.failures = tickers.map((t) => ({ ticker: t.ticker, reason: 'ticker->CIK list unavailable' }));
      await writeMeta();
      log(meta.error);
      return { meta, exitCode: 1 };
    }
    for (const e of Object.values(r.data)) if (e?.ticker && e?.cik_str) map[normalizeTicker(e.ticker)] = Number(e.cik_str);
  }

  let consecutiveBlocked = 0;
  for (const { ticker, cik: given } of tickers) {
    const cik = given ?? map[ticker] ?? null;
    if (!cik) { meta.failed++; meta.failures.push({ ticker, reason: 'no CIK in SEC ticker list' }); continue; }

    const tags = {};
    let hard = null;
    for (const key of TAGS) {
      const [taxonomy, tag] = key.split('/');
      const r = await getJson(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik10(cik)}/${taxonomy}/${tag}.json`, userAgent, fetchImpl);
      if (r.status === 404) continue;                       // tag not used by this company: normal
      if (r.status !== 200 || !r.data) { hard = `${key}: ${r.error ?? 'HTTP ' + r.status}`; break; }
      const t = trimConcept(r.data);
      if (t) tags[key] = t;
    }
    if (!hard && !Object.keys(tags).length) hard = 'no XBRL data for any tag (no US-GAAP/IFRS filings found)';
    if (hard) {
      // keep the previous file untouched; the consumer ignores it once it is >5 days old
      meta.failed++; meta.failures.push({ ticker, reason: hard });
      consecutiveBlocked = /HTTP 403/.test(hard) ? consecutiveBlocked + 1 : 0;
      if (consecutiveBlocked >= 3) {
        meta.error = 'SEC answered HTTP 403 three times in a row — stopping (blocked?)';
        break;
      }
      continue;
    }
    consecutiveBlocked = 0;

    const file = path.join(dataDir, `${ticker}.json`);
    const prev = await readJsonIfExists(file);
    meta.succeeded++;
    if (canKeepBundle(prev, cik, tags, now())) { meta.unchanged++; continue; }
    await writeFile(file, JSON.stringify({ ticker, cik, generatedAt, tags }) + '\n');
  }

  const attempted = meta.succeeded + meta.failed;
  if (attempted < meta.tickersTotal) {
    const rest = meta.tickersTotal - attempted;
    meta.failed += rest;
    meta.failures.push({ ticker: '(rest)', reason: `${rest} ticker(s) not attempted (run stopped early)` });
  }
  await writeMeta();
  log(`SEC data: ${meta.succeeded} ok (${meta.unchanged} unchanged), ${meta.failed} failed of ${meta.tickersTotal}` +
      (meta.error ? ` — ${meta.error}` : ''));
  for (const f of meta.failures) log(`  failed ${f.ticker}: ${f.reason}`);
  return { meta, exitCode: meta.error || meta.succeeded === 0 ? 1 : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const email = process.env.SEC_CONTACT_EMAIL;
  if (!email) {
    console.error('SEC_CONTACT_EMAIL is not set (GitHub Actions secret). Refusing to call SEC without a contact in the User-Agent.');
    process.exit(2);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { exitCode } = await run({ root, email });
  process.exit(exitCode);
}
