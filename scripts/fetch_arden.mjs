/**
 * fetch_arden.mjs — Shlomi Arden's yearly review of Israeli public companies (https://israeli-stocks-site.vercel.app), as data files.
 * The site is a Next.js app that serves its content as JSON: /data/cat-<n>.json (one file per sector: companies with a review per year) and
 * /data/interesting-<year>.json (the list of companies he rated "interesting"). Used privately (the owner has the right to cite it) as
 *   - a quality signal for the monthly ranking (rating: interesting / watch / no),
 *   - the source of candidate Israeli companies (MAYA issuer id is in every review's link) and context for Claude's reviews.
 * Writes data/il/arden/<year>.json (index) and data/il/arden/reviews/<issuerId>.json (full text, only for interesting + watch).
 * Never fails the workflow: on any problem the previous files stay.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BASE = 'https://israeli-stocks-site.vercel.app';
export const FINANCIAL_CATEGORIES = ['בנקים', 'חברות ביטוח', 'אשראי חוץ בנקאי', 'בתי השקעות ושירותים פיננסיים'];

export function htmlToText(html) {
  return String(html ?? '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/h\d>|<\/li>|<\/tr>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#8217;|&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
export const issuerIdOf = (html) => { const m = /maya\.tase\.co\.il\/(?:he\/)?company\/(\d+)/.exec(String(html ?? '')); return m ? m[1] : null; };
export const marketCapOf = (text) => { const m = /שווי שוק\s+([\d,.]+)\s*(מיליארד|מיליון|מ)/.exec(text); return m ? `${m[1]} ${m[2] === 'מיליארד' ? 'מיליארד' : 'מ׳'}` : null; };

/** The verdict sits in the closing sentences ("... החברה למעקב", "חברה מעניינת", "לפי הקריטריונים שלנו החברה ל א עוברת"). */
export function ratingOf(text) {
  const tail = String(text ?? '').slice(-500).replace(/\s+/g, ' ');
  const squeezed = tail.replace(/ /g, '');
  if (/לאעוברת/.test(squeezed)) return 'no';
  if (/למעקב/.test(tail)) return 'watch';
  if (/לאמעניינת/.test(squeezed)) return 'no';
  if (/מעניינת/.test(tail)) return 'interesting';
  return null;
}

/** The last "summary and analysis" part, max ~900 chars. */
export function summaryOf(text) {
  const i = text.lastIndexOf('סיכום וניתוח');
  const s = i >= 0 ? text.slice(i + 'סיכום וניתוח'.length) : text.slice(-900);
  return s.replace(/\s+/g, ' ').trim().slice(0, 900);
}

const getJson = async (url, fetchImpl) => {
  const r = await fetchImpl(url, { headers: { 'User-Agent': 'portfolio-screener (private use)' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function buildYear({ year, cats, interesting }) {
  const interestingIds = new Set(), interestingNames = new Set();
  for (const c of interesting?.companies ?? []) { const id = issuerIdOf(c.html); if (id) interestingIds.add(id); interestingNames.add(String(c.name).trim()); }
  const companies = [], reviews = {};
  for (const [catName, list] of cats) for (const co of list) {
    const html = co.reviews?.[year]; if (!html) continue;
    const text = htmlToText(html), issuerId = issuerIdOf(html);
    let rating = ratingOf(text);
    if (interestingIds.has(String(issuerId)) || interestingNames.has(String(co.name).trim())) rating = 'interesting';   // his own list wins
    companies.push({ issuerId, name: co.name, category: catName, rating, marketCapText: marketCapOf(text), financialCategory: FINANCIAL_CATEGORIES.includes(catName), summary: summaryOf(text) });
    if (issuerId && (rating === 'interesting' || rating === 'watch')) reviews[issuerId] = { name: co.name, category: catName, year, rating, text };
  }
  return { companies, reviews };
}

export async function run({ root, year = '2026', fetchImpl = fetch, log = console.log, now = () => Date.now(), delayMs = 400, maxAgeDays = 6, force = false } = {}) {
  // the review changes once a year: refresh at most weekly (the workflow runs daily)
  if (!force) {
    try {
      const prev = JSON.parse(await readFile(path.join(root, 'data', 'il', 'arden', 'ratings.json'), 'utf8'));
      if (prev.year === year && now() - Date.parse(prev.fetchedAt) < maxAgeDays * 86_400_000) { log(`arden ${year}: fetched ${prev.fetchedAt.slice(0, 10)}, still fresh - skipped`); return { skipped: true }; }
    } catch { /* none yet */ }
  }
  const search = await getJson(`${BASE}/data/search-index.json`, fetchImpl);
  const catIdx = new Map(); for (const s of search) catIdx.set(s.catPos, s.catName)   // cat-<n>.json is numbered by catPos (catIdx is another order);
  const cats = [];
  for (const [idx, name] of [...catIdx].sort((a, b) => a[0] - b[0])) { cats.push([name, await getJson(`${BASE}/data/cat-${idx}.json`, fetchImpl)]); await sleep(delayMs); }
  const interesting = await getJson(`${BASE}/data/interesting-${year}.json`, fetchImpl);
  const { companies, reviews } = buildYear({ year, cats, interesting });
  if (companies.length < 100) throw new Error(`only ${companies.length} companies parsed — layout changed? nothing written`);
  const dir = path.join(root, 'data', 'il', 'arden');
  await mkdir(path.join(dir, 'reviews'), { recursive: true });
  const counts = companies.reduce((a, c) => { a[c.rating ?? 'unrated'] = (a[c.rating ?? 'unrated'] || 0) + 1; return a; }, {});
  await writeFile(path.join(dir, `${year}.json`), JSON.stringify({ source: BASE, author: 'Shlomi Arden', year, fetchedAt: new Date(now()).toISOString(), counts, companies }, null, 1) + '\n');
  // the small file Apps Script reads for the monthly ranking: { issuerId: { name, rating, category } }
  const slim = {}; for (const c of companies) if (c.issuerId && c.rating) slim[c.issuerId] = { name: c.name, rating: c.rating, category: c.category, financialCategory: !!c.financialCategory };
  await writeFile(path.join(dir, 'ratings.json'), JSON.stringify({ source: BASE, year, fetchedAt: new Date(now()).toISOString(), companies: slim }) + '\n');
  for (const [id, r] of Object.entries(reviews)) await writeFile(path.join(dir, 'reviews', `${id}.json`), JSON.stringify(r, null, 1) + '\n');
  log(`arden ${year}: ${companies.length} companies, ${JSON.stringify(counts)}, ${Object.keys(reviews).length} review texts`);
  return { companies: companies.length, counts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  await run({ root, year: process.argv[2] || '2026', force: process.argv.includes('--force') }).catch((e) => console.log('::warning::arden fetch failed: ' + (e && e.message ? e.message : e)));
  process.exit(0);
}
