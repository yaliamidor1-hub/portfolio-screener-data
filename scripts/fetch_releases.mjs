/**
 * fetch_releases.mjs — the text of the latest earnings releases (8-K, Item 2.02, exhibit 99.x) per ticker:
 *   data/releases/<TICKER>.json = { ticker, generatedAt, releases: [{ accession, filingDate, reportDate, url, text }] }   (newest first, up to 2)
 * SEC blocks Google Apps Script, so the Stage 2 verification (Apps Script) cannot read sec.gov exhibits itself; this public
 * copy lets it check the numbers a review quotes from an earnings release. Same rules as fetch_filings.mjs: secret-only
 * User-Agent, <= 4.5 requests/second, a ticker is only re-downloaded when its newest earnings-release accession changed.
 * The text is plain text after stripping HTML, capped at RELEASE_CHARS. Failures keep the previous file.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getJson, getText, cik10, parseTickers } from './fetch_sec.mjs';
import { stripHtml } from './fetch_filings.mjs';

export const RELEASE_CHARS = 80_000;
export const MAX_RELEASES = 2;

/** Newest 8-Ks that report results (Item 2.02) from a submissions JSON: [{ accession, filingDate, reportDate, primaryDocument }]. */
export function pickReleases(submissions, max = MAX_RELEASES) {
  const r = submissions?.filings?.recent;
  if (!r || !Array.isArray(r.form)) return [];
  const out = [];
  for (let i = 0; i < r.form.length && out.length < max; i++) {
    if (r.form[i] !== '8-K') continue;
    const items = String(r.items?.[i] ?? '').split(',').map((s) => s.trim());
    if (!items.includes('2.02')) continue;
    const accession = r.accessionNumber?.[i];
    if (!accession) continue;
    out.push({ accession, filingDate: r.filingDate?.[i] ?? null, reportDate: r.reportDate?.[i] || null, primaryDocument: r.primaryDocument?.[i] ?? null });
  }
  if (out.length) return out;
  // foreign filers (20-F / 40-F companies) report results on Form 6-K, which has no Item 2.02: take the newest few as CANDIDATES,
  // the caller keeps only those whose text reads like a results release (isResultsText)
  for (let i = 0; i < r.form.length && out.length < MAX_6K_CANDIDATES; i++) {
    if (r.form[i] !== '6-K') continue;
    const accession = r.accessionNumber?.[i];
    if (!accession) continue;
    out.push({ accession, filingDate: r.filingDate?.[i] ?? null, reportDate: r.reportDate?.[i] || null, primaryDocument: r.primaryDocument?.[i] ?? null, candidate: true });
  }
  return out;
}

export const MAX_6K_CANDIDATES = 8;

/** Does a document read like a quarterly / annual results release? (used for 6-K candidates only) */
export function isResultsText(text) {
  const head = String(text ?? '').slice(0, 4000);
  return /(financial results|results for the|quarter|full year|fiscal year)/i.test(head) && /(revenue|net income|earnings|profit)/i.test(head) && /\d/.test(head);
}

/** The press-release exhibit (99.1 preferred) among a filing's files (index.json "directory.item"), or null. */
export function pickExhibit(index, primaryDocument = null) {
  const items = index?.directory?.item;
  if (!Array.isArray(items)) return null;
  const htm = items.map((x) => ({ name: String(x?.name ?? ''), size: Number(x?.size) || 0 })).filter((x) => /\.html?$/i.test(x.name));
  const rank = (n) => (/(ex|exhibit)[-_]?99[-_.]?1/i.test(n) ? 0 : /(ex|exhibit)[-_]?99/i.test(n) ? 1 : /(press|release|earnings)/i.test(n) ? 2 : 9);
  const named = htm.filter((x) => rank(x.name) < 9).sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))[0];
  if (named) return named.name;
  // exhibits named after the company ("noc-12312025xearningsrelea.htm"): the largest document that is neither the 8-K body nor an index / XBRL viewer file
  const other = htm.filter((x) => x.name !== primaryDocument && !/^R\d+\.htm$/i.test(x.name) && !/(index|FilingSummary)/i.test(x.name)).sort((a, b) => b.size - a.size)[0];
  return other && other.size > 3000 ? other.name : null;
}

async function readJsonIfExists(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

export async function run({ root, email, now = () => Date.now(), fetchImpl = fetch, log = console.log } = {}) {
  const userAgent = `PortfolioScreener/1.0 (${email})`;
  const dataDir = path.join(root, 'data'), outDir = path.join(dataDir, 'releases');
  await mkdir(outDir, { recursive: true });
  const tickers = parseTickers(await readFile(path.join(root, 'tickers.txt'), 'utf8'));
  const generatedAt = new Date(now()).toISOString();
  const summary = { generatedAt, tickersTotal: tickers.length, fetched: 0, unchanged: 0, skipped: 0, failed: 0, reasons: [] };
  const reason = (ticker, why, kind) => { summary[kind]++; summary.reasons.push({ ticker, reason: why }); };

  let blocked = 0;
  for (const { ticker, cik: given } of tickers) {
    const bundle = given ? null : await readJsonIfExists(path.join(dataDir, `${ticker}.json`));
    const cik = given ?? bundle?.cik ?? null;
    if (!cik) { reason(ticker, 'no CIK', 'skipped'); continue; }
    const sub = await getJson(`https://data.sec.gov/submissions/CIK${cik10(cik)}.json`, userAgent, fetchImpl);
    if (sub.status !== 200 || !sub.data) {
      reason(ticker, `submissions: ${sub.error ?? 'HTTP ' + sub.status}`, 'failed');
      blocked = sub.status === 403 ? blocked + 1 : 0;
      if (blocked >= 3) { summary.error = 'SEC answered HTTP 403 three times in a row — stopping (blocked?)'; break; }
      continue;
    }
    blocked = 0;
    const picks = pickReleases(sub.data);
    if (!picks.length) { reason(ticker, 'no earnings-release 8-K (Item 2.02) among the recent filings', 'skipped'); continue; }
    const file = path.join(outDir, `${ticker}.json`);
    const prev = await readJsonIfExists(file);
    if (prev && Array.isArray(prev.releases) && prev.releases[0]?.accession === picks[0].accession && prev.releases.length === picks.length) { summary.unchanged++; continue; }

    const releases = [];
    for (const p of picks) {
      if (releases.length >= MAX_RELEASES) break;
      const folder = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${p.accession.replace(/-/g, '')}`;
      const idx = await getJson(`${folder}/index.json`, userAgent, fetchImpl);
      const name = idx.status === 200 ? pickExhibit(idx.data, p.primaryDocument) : null;
      if (!name) { summary.reasons.push({ ticker, reason: `${p.accession}: no exhibit 99 found` }); continue; }
      const doc = await getText(`${folder}/${name}`, userAgent, fetchImpl);
      if (doc.status !== 200 || typeof doc.data !== 'string') { summary.reasons.push({ ticker, reason: `${p.accession}: ${doc.error ?? 'HTTP ' + doc.status}` }); continue; }
      if (p.candidate && !isResultsText(stripHtml(doc.data))) continue;   // a 6-K that is not a results release
      releases.push({ accession: p.accession, filingDate: p.filingDate, reportDate: p.reportDate, url: `${folder}/${name}`, text: stripHtml(doc.data).slice(0, RELEASE_CHARS) });
    }
    if (!releases.length) { reason(ticker, 'no release text could be read (previous file kept)', 'failed'); continue; }
    await writeFile(file, JSON.stringify({ ticker, generatedAt, releases }) + '\n');
    summary.fetched++;
  }
  const metaFile = path.join(dataDir, 'meta.json');
  const meta = (await readJsonIfExists(metaFile)) ?? {};
  meta.releases = summary;
  await writeFile(metaFile, JSON.stringify(meta, null, 2) + '\n');
  log(`Releases: ${summary.fetched} fetched, ${summary.unchanged} unchanged, ${summary.skipped} skipped, ${summary.failed} failed of ${summary.tickersTotal}` + (summary.error ? ` — ${summary.error}` : ''));
  return { summary, exitCode: summary.error ? 1 : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const email = process.env.SEC_CONTACT_EMAIL;
  if (!email) { console.error('SEC_CONTACT_EMAIL is not set (GitHub Actions secret). Refusing to call SEC without a contact in the User-Agent.'); process.exit(2); }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { exitCode } = await run({ root, email });
  process.exit(exitCode);
}
