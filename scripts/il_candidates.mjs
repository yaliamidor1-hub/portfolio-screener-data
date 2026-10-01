/**
 * il_candidates.mjs — Israeli discovery (stage 4): the companies Shlomi Arden's review rates "interesting" or "watch" that are not yet in
 * data/il/watchlist.json, ranked, written to data/il/candidates.json. The monthly Claude task adds the top few to the watchlist (resolving the TASE
 * security number on MAYA / Bizportal and reading the financial data), so the Israeli universe grows gradually without anyone choosing themes.
 *
 * Filters (a candidate must be a company the screener can analyse and trade): has a MAYA issuer id; not a shell / R&D partnership / cannabis;
 * market cap >= IL_MIN_MARKET_CAP_M (default 250 M ILS, his own "liquidity" criterion); not already in the watchlist; not rejected before
 * (data/il/rejected.json: { "<issuerId>": "reason" }).
 * Order: rating (interesting before watch), then larger market cap first. Financial categories are kept but flagged (they use the financial rules).
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EXCLUDED_CATEGORIES = ['שלדים וחברות מעטפת', 'שותפויות מו”פ', 'שותפויות מו"פ', 'קנאביס'];
export const MIN_MARKET_CAP_M = 250;

/** "270 מ׳" -> 270, "4.8 מיליארד" -> 4800; null when unknown. */
export function marketCapM(text) {
  const m = /^([\d,.]+)\s*(מיליארד|מ׳)/.exec(String(text ?? '').trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? (m[2] === 'מיליארד' ? n * 1000 : n) : null;
}

export function pickCandidates({ arden, watchIssuerIds = new Set(), rejected = {}, minCapM = MIN_MARKET_CAP_M, limit = 60 }) {
  const rank = { interesting: 0, watch: 1 };
  return (arden.companies ?? [])
    .filter((c) => c.issuerId && c.rating in rank && !watchIssuerIds.has(String(c.issuerId)) && !rejected[String(c.issuerId)] && !EXCLUDED_CATEGORIES.includes(c.category))
    .map((c) => ({ ...c, capM: marketCapM(c.marketCapText) }))
    .filter((c) => c.capM === null || c.capM >= minCapM)   // an unknown cap is kept: the data file will show the real one
    .sort((a, b) => rank[a.rating] - rank[b.rating] || (b.capM ?? 0) - (a.capM ?? 0))
    .slice(0, limit)
    .map((c) => ({ issuerId: String(c.issuerId), name: c.name, category: c.category, rating: c.rating, marketCapText: c.marketCapText, financialCategory: !!c.financialCategory, mayaUrl: `https://maya.tase.co.il/he/companies/${c.issuerId}` }));
}

const readJson = async (p, fallback) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; } };

export async function run({ root, year = '2026', log = console.log, now = () => Date.now() } = {}) {
  const arden = await readJson(path.join(root, 'data', 'il', 'arden', `${year}.json`), null);
  if (!arden) { log('candidates: no arden file yet'); return { written: 0 }; }
  const watch = await readJson(path.join(root, 'data', 'il', 'watchlist.json'), { companies: [] });
  const rejected = await readJson(path.join(root, 'data', 'il', 'rejected.json'), {});
  const watchIds = new Set((watch.companies ?? []).map((c) => String(c.issuerId ?? '')).filter(Boolean));
  const candidates = pickCandidates({ arden, watchIssuerIds: watchIds, rejected });
  await writeFile(path.join(root, 'data', 'il', 'candidates.json'), JSON.stringify({ generatedAt: new Date(now()).toISOString(), source: `arden ${year}`, count: candidates.length, candidates }, null, 1) + '\n');
  log(`candidates: ${candidates.length} (interesting ${candidates.filter((c) => c.rating === 'interesting').length}, watch ${candidates.filter((c) => c.rating === 'watch').length})`);
  return { written: candidates.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  await run({ root, year: process.argv[2] || '2026' }).catch((e) => console.log('::warning::il candidates failed: ' + (e && e.message ? e.message : e)));
  process.exit(0);
}
