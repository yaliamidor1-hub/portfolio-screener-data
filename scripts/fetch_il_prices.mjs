/**
 * fetch_il_prices.mjs — the last TASE share price of every company in data/il/watchlist.json, written to data/il/<YYYY-MM>/prices.json
 * (the file ingestIlPrices() in Apps Script validates and loads).
 *
 * MAYA / TASE sit behind a bot wall and render in JavaScript, so they cannot be read by a script. Bizportal publishes the same TASE quote as plain HTML,
 * addressed by the TASE security number:  https://www.bizportal.co.il/capitalmarket/quote/generalpage/<securityNumber>
 * The page shows  "מניית <company name>  <price in agorot>  <change>%  נכון ל: dd/MM/yyyy". The recorded source is that Bizportal URL — it is NOT
 * presented as MAYA. Checks before a price is written: the company name on the page must share a word with the watchlist name (a wrong security number
 * is skipped), the price is a positive number, the date is real and not in the future; a company that fails is skipped and reported, never guessed.
 * An earlier price of the same stock that is newer than the fetched one is kept. One request per company, >= 1.2 s apart.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PRICE_URL = (sn) => `https://www.bizportal.co.il/capitalmarket/quote/generalpage/${encodeURIComponent(sn)}`;
const UA = 'Mozilla/5.0 (compatible; portfolio-screener price check)';

export function stripHtml(html) {
  return String(html ?? '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#8362;/g, '₪').replace(/\s+/g, ' ').trim();
}

const norm = (s) => String(s ?? '').replace(/["'״׳\-־.,]/g, ' ').replace(/\s+/g, ' ').trim();

/** Page HTML -> { name, price (agorot), change, date 'yyyy-MM-dd' } or { error }. */
export function parseQuote(html) {
  const text = stripHtml(html);
  const m = /מניית\s+([^|]{1,60}?)\s+(-?\d[\d,]*(?:\.\d+)?)\s+(-?[\d.,]+)%\s+נכון ל:\s*(\d{2})\/(\d{2})\/(\d{4})/.exec(text);
  if (!m) return { error: 'quote line not found on the page (layout changed, or the security has no share quote)' };
  const price = Number(m[2].replace(/,/g, ''));
  const date = `${m[6]}-${m[5]}-${m[4]}`;
  if (!Number.isFinite(price) || price <= 0) return { error: 'price on the page is not a positive number' };
  const d = new Date(Date.UTC(Number(m[6]), Number(m[5]) - 1, Number(m[4])));
  if (d.getUTCFullYear() !== Number(m[6]) || d.getUTCMonth() !== Number(m[5]) - 1 || d.getUTCDate() !== Number(m[4])) return { error: 'date on the page is not valid' };
  const cap = /שווי שוק\s*\(אלפי[^)]*\)\s*:?\s*([\d,]+)/.exec(text);   // thousands of ILS, as the page shows it
  const marketCap = cap ? Number(cap[1].replace(/,/g, '')) : null;
  return { name: m[1].trim(), price, change: Number(m[3].replace(/,/g, '')), date, marketCap: Number.isFinite(marketCap) && marketCap > 0 ? marketCap : null };
}

/** Does the page's company name share a word (>= 3 letters) with the watchlist name? */
export function namesMatch(pageName, watchName) {
  const words = (s) => norm(s).split(' ').filter((w) => w.length >= 3);
  const a = new Set(words(pageName));
  if (words(watchName).some((w) => a.has(w))) return true;
  // short names ("אב-גד", "מר") against the fuller one ("אב-גד החזקות", "ח.מר תעשיות"): one contains the other
  const p = norm(pageName).replace(/ /g, ''), w = norm(watchName).replace(/ /g, '');
  return p.length >= 2 && w.length >= 2 && (w.includes(p) || p.includes(w));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run({ root, month, now = () => Date.now(), fetchImpl = fetch, log = console.log, delayMs = 1200 } = {}) {
  const watch = JSON.parse(await readFile(path.join(root, 'data', 'il', 'watchlist.json'), 'utf8'));
  const dir = path.join(root, 'data', 'il', month), file = path.join(dir, 'prices.json');
  let prev = { prices: [] };
  try { prev = JSON.parse(await readFile(file, 'utf8')); } catch { /* none yet */ }
  const prevBy = new Map((prev.prices ?? []).map((p) => [String(p.securityNumber), p]));
  const prices = [], skipped = [];
  for (const c of watch.companies ?? []) {
    const sn = String(c.ticker);
    try {
      const res = await fetchImpl(PRICE_URL(sn), { headers: { 'User-Agent': UA, 'Accept-Language': 'he' }, redirect: 'follow' });
      if (!res.ok) { skipped.push([sn, `HTTP ${res.status}`]); }
      else {
        const q = parseQuote(await res.text());
        if (q.error) skipped.push([sn, q.error]);
        else if (!namesMatch(q.name, c.name)) skipped.push([sn, `the page is for "${q.name}", not "${c.name}"`]);
        else if (Date.parse(q.date) > now() + 86_400_000) skipped.push([sn, `date ${q.date} is in the future`]);
        else {
          const old = prevBy.get(sn);
          prices.push(old && old.priceDate > q.date ? old : { securityNumber: sn, price: q.price, priceUnit: 'agorot', priceDate: q.date, source: PRICE_URL(sn), ...(q.marketCap ? { marketCap: q.marketCap } : {}) });
        }
      }
    } catch (e) { skipped.push([sn, `request failed (${e && e.name ? e.name : 'error'})`]); }
    await sleep(delayMs);
  }
  if (!prices.length) { log(`prices: nothing written (${skipped.length} skipped)`); skipped.forEach(([s, w]) => log(`  ${s}: ${w}`)); return { written: 0, skipped }; }
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ month, generatedAt: new Date(now()).toISOString(), note: 'TASE last price as published by Bizportal (source URL per price); price in agorot', prices }, null, 2) + '\n');
  log(`prices: ${prices.length} written to data/il/${month}/prices.json, ${skipped.length} skipped`);
  skipped.forEach(([s, w]) => log(`  ${s}: ${w}`));
  return { written: prices.length, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const month = process.argv[2] || new Date().toISOString().slice(0, 7);
  const r = await run({ root, month }).catch((e) => { console.log('::warning::il prices failed: ' + (e && e.message ? e.message : e)); return { written: 0 }; });
  process.exit(0);   // never fails the workflow: prices are optional
}
