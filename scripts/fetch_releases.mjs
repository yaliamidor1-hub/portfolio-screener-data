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
  return out;
}

/** The press-release exhibit (99.1 preferred) among a filing's files (index.json "directory.item"), or null. */
export function pickExhibit(index) {
  const items = index?.directory?.item;
  if (!Array.isArray(items)) return null;
  const htm = items.map((x) => String(x?.name ?? '')).filter((n) => /\.html?$/i.test(n));
  const rank = (n) => (/(ex|exhibit)[-_]?99[-_.]?1/i.test(n) ? 0 : /(ex|exhibit)[-_]?99/i.test(n) ? 1 : /(press|release)/i.test(n) ? 2 : 9);
  const best = htm.filter((n) => rank(n) < 9).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
  return best ?? null;
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
      const folder = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${p.accession.replace(/-/g, '')}`;
      const idx = await getJson(`${folder}/index.json`, userAgent, fetchImpl);
      const name = idx.status === 200 ? pickExhibit(idx.data) : null;
      if (!name) { summary.reasons.push({ ticker, reason: `${p.accession}: no exhibit 99 found` }); continue; }
      const doc = await getText(`${folder}/${name}`, userAgent, fetchImpl);
      if (doc.status !== 200 || typeof doc.data !== 'string') { summary.reasons.push({ ticker, reason: `${p.accession}: ${doc.error ?? 'HTTP ' + doc.status}` }); continue; }
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
