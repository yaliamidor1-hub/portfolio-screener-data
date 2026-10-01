#!/usr/bin/env node
/**
 * fetch_filings.mjs — for every ticker in tickers.txt, downloads the latest annual report
 * (10-K; 20-F / 40-F for foreign filers) from SEC EDGAR and publishes the text of a few
 * sections for the Stage 2 (qualitative) analysis:
 *   data/filings/<TICKER>.json = { ticker, form, accession, filingDate, reportDate, sourceUrl,
 *     extractorVersion, sections: { business, riskFactors, mdna, legal }, generatedAt }
 * A section that cannot be located is null (never guessed). Capped lengths: business 6000,
 * riskFactors 10000, mdna 8000, legal 3000 characters.
 *
 * Calls per ticker: 1 (data.sec.gov submissions, to find the newest filing); the document
 * itself is downloaded only when the accession changed (or the extractor was improved).
 * Same rules as fetch_sec.mjs: <= ~4.5 requests/second, User-Agent from the
 * SEC_CONTACT_EMAIL secret only (never written to a file or printed).
 * Node 20+, no dependencies. Summary is merged into data/meta.json under "filings".
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getJson, getText, parseTickers, cik10 } from './fetch_sec.mjs';

export const EXTRACTOR_VERSION = 1; // bump when extraction improves: stored filings are re-extracted
export const LIMITS = { business: 6000, riskFactors: 10000, mdna: 8000, legal: 3000 };
export const ANNUAL_FORMS = ['10-K', '20-F', '40-F'];
const MIN_SECTION_CHARS = 25;

/* ---------- HTML -> text ---------- */

const NAMED = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…', trade: '™', reg: '®', copy: '©', bull: '•', middot: '·' };

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } })
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ' '; } })
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() === 'amp' ? m : NAMED[n.toLowerCase()] ?? m))
    .replace(/&amp;/gi, '&');
}

/** HTML (incl. inline-XBRL) -> plain text, one block element per line. */
export function stripHtml(html) {
  let t = String(html);
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<ix:header[\s\S]*?<\/ix:header>/gi, ' ');                 // hidden XBRL facts
  t = t.replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  t = t.replace(/<(?:br|hr)\b[^>]*>/gi, '\n');
  t = t.replace(/<\/(?:p|div|tr|li|h[1-6]|table|section|title|ul|ol|center|blockquote)\s*>/gi, '\n');
  t = t.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');                                // any other tag
  t = decodeEntities(t);
  t = t.replace(/[ \t\f\v   ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n');
  return t.trim();
}

/* ---------- section extraction ---------- */

function truncateWords(s, limit) {
  if (s.length <= limit) return s;
  const cut = s.slice(0, limit);
  const sp = cut.lastIndexOf(' ');
  return (sp > limit * 0.8 ? cut.slice(0, sp) : cut).trimEnd() + ' […]';
}

/** All line-start "Item N" headings of the text: [{ item: '1a', pos }]. */
function itemHeadings(text) {
  const out = [];
  const re = /^[ \t]*item[ \t ]*(\d{1,2}[abc]?)\b/gim;
  let m;
  while ((m = re.exec(text))) out.push({ item: m[1].toLowerCase(), pos: m.index });
  return out;
}

/**
 * The span of the real section for `item`: among the line-start "Item <item>" headings whose
 * following 160 chars match `title`, take the one that runs longest until the next heading of
 * a different item (the table of contents repeats the headings but its spans are tiny).
 */
function longestSpan(text, heads, item, title) {
  let best = null;
  for (const h of heads) {
    if (h.item !== item || !title.test(text.slice(h.pos, h.pos + 160))) continue;
    const next = heads.find((x) => x.pos > h.pos && x.item !== item);
    const end = next ? next.pos : text.length;
    if (!best || end - h.pos > best.end - best.start) best = { start: h.pos, end };
  }
  return best;
}

const stripHeading = (span, item, titleWords) =>
  span.replace(new RegExp(`^\\s*item\\s*${item}\\s*[.:\\-–—]*\\s*(?:${titleWords})?\\s*[.:\\-–—]*\\s*`, 'i'), '').trim();

function finish(body, limit) {
  const b = String(body ?? '').trim();
  return b.length >= MIN_SECTION_CHARS ? truncateWords(b, limit) : null;
}

const SECTIONS_10K = {
  business:    { item: '1',  title: /business/i,                       words: 'business' },
  riskFactors: { item: '1a', title: /risk\s+factors/i,                 words: 'risk\\s+factors' },
  mdna:        { item: '7',  title: /management[’'`]?s?\s+discussion/i, words: 'management[’\'`]?s?\\s+discussion\\s+and\\s+analysis[^\\n]*' },
  legal:       { item: '3',  title: /legal\s+proceedings/i,            words: 'legal\\s+proceedings' },
};

/**
 * Extract the four sections from filing text. Returns { business, riskFactors, mdna, legal },
 * each a string or null (not found / too short). 10-K: Items 1, 1A, 7, 3. 20-F (best effort):
 * Item 4 (business), the "Risk Factors" part of Item 3, Item 5 (operating & financial review),
 * "Legal Proceedings" within Item 8. 40-F: all null (the content is in exhibits).
 */
export function extractSections(text, form) {
  const out = { business: null, riskFactors: null, mdna: null, legal: null };
  const t = String(text);
  const heads = itemHeadings(t);

  if (form === '10-K') {
    for (const [key, s] of Object.entries(SECTIONS_10K)) {
      const span = longestSpan(t, heads, s.item, s.title);
      if (span) out[key] = finish(stripHeading(t.slice(span.start, span.end), s.item, s.words), LIMITS[key]);
    }
    return out;
  }

  if (form === '20-F') {
    const biz = longestSpan(t, heads, '4', /information\s+on\s+the\s+company/i);
    if (biz) out.business = finish(stripHeading(t.slice(biz.start, biz.end), '4', 'information\\s+on\\s+the\\s+company'), LIMITS.business);
    const mdna = longestSpan(t, heads, '5', /operating\s+and\s+financial\s+review/i);
    if (mdna) out.mdna = finish(stripHeading(t.slice(mdna.start, mdna.end), '5', 'operating\\s+and\\s+financial\\s+review[^\\n]*'), LIMITS.mdna);
    const key = longestSpan(t, heads, '3', /key\s+information/i);
    if (key) {
      const seg = t.slice(key.start, key.end);
      const m = /^[ \t]*(?:d\.?[ \t]*)?risk\s+factors[ \t]*$/im.exec(seg);
      if (m) out.riskFactors = finish(seg.slice(m.index + m[0].length), LIMITS.riskFactors);
    }
    const fin = longestSpan(t, heads, '8', /financial\s+information/i);
    if (fin) {
      const seg = t.slice(fin.start, fin.end);
      const m = /^[ \t]*(?:\d\.[ \t]*)?legal\s+proceedings[ \t]*$/im.exec(seg);
      if (m) out.legal = finish(seg.slice(m.index + m[0].length), LIMITS.legal);
    }
    return out;
  }
  return out; // 40-F and anything else: nothing is guessed
}

/* ---------- submissions -> newest annual filing ---------- */

/**
 * From a data.sec.gov submissions JSON: the newest original 10-K / 20-F / 40-F in the
 * "recent" list, or null. (Amendments such as 10-K/A are not used: they are often partial.)
 */
export function pickFiling(submissions, cik) {
  const r = submissions?.filings?.recent;
  if (!r || !Array.isArray(r.form)) return null;
  for (let i = 0; i < r.form.length; i++) {
    if (!ANNUAL_FORMS.includes(r.form[i])) continue;
    const accession = r.accessionNumber?.[i], doc = r.primaryDocument?.[i];
    if (!accession || !doc) continue;
    return {
      form: r.form[i],
      accession,
      filingDate: r.filingDate?.[i] ?? null,
      reportDate: r.reportDate?.[i] || null,
      sourceUrl: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/${doc}`,
    };
  }
  return null;
}

/* ---------- main ---------- */

async function readJsonIfExists(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

export async function run({ root, email, now = () => Date.now(), fetchImpl = fetch, log = console.log } = {}) {
  const userAgent = `PortfolioScreener/1.0 (${email})`;
  const dataDir = path.join(root, 'data');
  const outDir = path.join(dataDir, 'filings');
  await mkdir(outDir, { recursive: true });
  const tickers = parseTickers(await readFile(path.join(root, 'tickers.txt'), 'utf8'));
  const generatedAt = new Date(now()).toISOString();
  const summary = { generatedAt, tickersTotal: tickers.length, fetched: 0, unchanged: 0, skipped: 0, failed: 0, reasons: [] };
  const reason = (ticker, why, kind) => { summary[kind]++; summary.reasons.push({ ticker, reason: why }); };

  let blocked = 0;
  for (const { ticker, cik: given } of tickers) {
    const bundle = given ? null : await readJsonIfExists(path.join(dataDir, `${ticker}.json`));
    const cik = given ?? bundle?.cik ?? null;
    if (!cik) { reason(ticker, 'no CIK (no SEC data bundle for this ticker)', 'skipped'); continue; }

    const sub = await getJson(`https://data.sec.gov/submissions/CIK${cik10(cik)}.json`, userAgent, fetchImpl);
    if (sub.status !== 200 || !sub.data) {
      reason(ticker, `submissions: ${sub.error ?? 'HTTP ' + sub.status}`, 'failed');
      blocked = sub.status === 403 ? blocked + 1 : 0;
      if (blocked >= 3) { summary.error = 'SEC answered HTTP 403 three times in a row — stopping (blocked?)'; break; }
      continue;
    }
    const filing = pickFiling(sub.data, cik);
    if (!filing) { reason(ticker, 'no 10-K / 20-F / 40-F among the recent filings', 'skipped'); blocked = 0; continue; }

    const file = path.join(outDir, `${ticker}.json`);
    const prev = await readJsonIfExists(file);
    if (prev && prev.accession === filing.accession && prev.extractorVersion === EXTRACTOR_VERSION) { summary.unchanged++; blocked = 0; continue; }

    const doc = await getText(filing.sourceUrl, userAgent, fetchImpl);
    if (doc.status !== 200 || typeof doc.data !== 'string') {
      reason(ticker, `document ${filing.accession}: ${doc.error ?? 'HTTP ' + doc.status}`, 'failed'); // previous file stays
      blocked = doc.status === 403 ? blocked + 1 : 0;
      if (blocked >= 3) { summary.error = 'SEC answered HTTP 403 three times in a row — stopping (blocked?)'; break; }
      continue;
    }
    blocked = 0; // a document came through: SEC is not blocking us
    const sections = extractSections(stripHtml(doc.data), filing.form);
    const missing = Object.entries(sections).filter(([, v]) => v === null).map(([k]) => k);
    if (missing.length) summary.reasons.push({ ticker, reason: `${filing.form} ${filing.accession}: sections not found: ${missing.join(', ')}` });
    await writeFile(file, JSON.stringify({ ticker, form: filing.form, accession: filing.accession, filingDate: filing.filingDate,
      reportDate: filing.reportDate, sourceUrl: filing.sourceUrl, extractorVersion: EXTRACTOR_VERSION, sections, generatedAt }) + '\n');
    summary.fetched++;
  }

  const attempted = summary.fetched + summary.unchanged + summary.skipped + summary.failed;
  if (attempted < summary.tickersTotal) {
    const rest = summary.tickersTotal - attempted;
    summary.failed += rest;
    summary.reasons.push({ ticker: '(rest)', reason: `${rest} ticker(s) not attempted (run stopped early)` });
  }
  const metaFile = path.join(dataDir, 'meta.json');
  const meta = (await readJsonIfExists(metaFile)) ?? {};
  meta.filings = summary;
  await writeFile(metaFile, JSON.stringify(meta, null, 2) + '\n');
  log(`Filings: ${summary.fetched} fetched, ${summary.unchanged} unchanged, ${summary.skipped} skipped, ${summary.failed} failed of ${summary.tickersTotal}` +
      (summary.error ? ` — ${summary.error}` : ''));
  for (const r of summary.reasons) log(`  ${r.ticker}: ${r.reason}`);
  return { summary, exitCode: summary.error ? 1 : 0 };
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
