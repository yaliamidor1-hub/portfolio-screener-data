/**
 * sync_tickers.mjs — makes the Apps Script `Universe` tab the source of truth for tickers.txt.
 *
 * Calls the screener's web app (`?tickers=1&token=...`), which answers with the ACTIVE market=US tickers
 * of the Universe tab, one per line (market=IL rows are never included: the SEC has no data for them).
 * tickers.txt is rewritten with that list. Existing lines are kept for tickers that stay (so a
 * "TICKER,CIK" line keeps its CIK).
 *
 * Fallback: if the call fails, the answer is empty or it is not a plain ticker list (e.g. the web app was
 * not redeployed and answered with HTML), tickers.txt is left EXACTLY as it is and a clear warning is
 * logged — the rest of the workflow then runs on the existing list. This script always exits 0.
 *
 * Secrets (GitHub repository secrets, passed as env): TICKERS_URL (the web app's /exec URL) and
 * TICKERS_TOKEN. Neither is ever logged; error messages never include the URL.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeTicker, parseTickers } from './fetch_sec.mjs';

const TICKER_RE = /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/;

/** Web app answer -> unique normalized tickers, or null when it is not a plain ticker list. */
export function parseFeed(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  if (!lines.every((l) => TICKER_RE.test(l))) return null;   // HTML / JSON / an error page
  return [...new Set(lines.map(normalizeTicker))];
}

/** New tickers.txt text: feed order, keeping the existing line (with its CIK) of a ticker that stays. */
export function buildTickersText(existingText, feed) {
  const keep = new Map();
  for (const raw of String(existingText ?? '').split(/\r?\n/)) {
    const t = parseTickers(raw)[0];
    if (t) keep.set(t.ticker, raw.replace(/#.*$/, '').trim());
  }
  return feed.map((t) => keep.get(t) || t).join('\n') + '\n';
}

export async function run({ root, url, token, fetchImpl = fetch, log = console.log } = {}) {
  const file = path.join(root, 'tickers.txt');
  const keepExisting = (why) => {
    log(`::warning::tickers sync skipped — ${why}. tickers.txt is unchanged (using the existing list).`);
    return { changed: false, used: 'existing' };
  };
  if (!url || !token) return keepExisting('TICKERS_URL / TICKERS_TOKEN secrets are not set');
  let text;
  try {
    const u = new URL(url);
    u.searchParams.set('tickers', '1');
    u.searchParams.set('token', token);
    const res = await fetchImpl(u.toString(), { redirect: 'follow' });
    if (!res.ok) return keepExisting(`the web app answered HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    return keepExisting(`the request failed (${e && e.name ? e.name : 'error'})`);   // never print e.message: it may contain the URL
  }
  const feed = parseFeed(text);
  if (!feed) return keepExisting('the answer was empty or not a ticker list (wrong token? web app not redeployed?)');
  let existing = '';
  try { existing = await readFile(file, 'utf8'); } catch { existing = ''; }
  const next = buildTickersText(existing, feed);
  if (next === existing) {
    log(`tickers sync: ${feed.length} tickers, no change.`);
    return { changed: false, used: 'universe', count: feed.length };
  }
  const before = new Set(parseTickers(existing).map((t) => t.ticker));
  const added = feed.filter((t) => !before.has(t));
  const removed = [...before].filter((t) => !feed.includes(t));
  await writeFile(file, next);
  log(`tickers sync: ${feed.length} tickers from the Universe tab | added: ${added.join(', ') || '-'} | removed: ${removed.join(', ') || '-'}`);
  return { changed: true, used: 'universe', count: feed.length, added, removed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  run({ root, url: process.env.TICKERS_URL, token: process.env.TICKERS_TOKEN }).catch((e) => {
    console.log(`::warning::tickers sync failed unexpectedly (${e && e.name ? e.name : 'error'}); tickers.txt is unchanged.`);
  });
}
