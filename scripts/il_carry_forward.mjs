/**
 * il_carry_forward.mjs — keeps the Israeli data files of the watchlist alive from month to month.
 *
 * The Apps Script reads data/il/<month>/<security number>.json for the current month and only falls back one month. Financial statements change
 * quarterly, so most months nothing new is published on MAYA. This step copies the newest earlier file of each watchlist company into the target month
 * (marked carriedForward / carriedFrom, same reportDate — so it is never mistaken for fresh data, and the 15-month freshness check still applies);
 * the monthly Claude task replaces a carried file when MAYA has a newer report. Market cap and price are refreshed separately from the quote page
 * (fetch_il_prices.mjs -> prices.json). A company without any earlier file is left alone (the owner is told by the missing-file report).
 *
 *   node scripts/il_carry_forward.mjs [month ...]     default: this month, and next month from the 18th on
 */
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const MAX_REPORT_AGE_MONTHS = 15;

export function nextMonth(m) { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; }
export function monthsToCarry(now) { const d = new Date(now), m = d.toISOString().slice(0, 7); return d.getUTCDate() >= 18 ? [m, nextMonth(m)] : [m]; }

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

export async function run({ root, months, now = () => Date.now(), log = console.log } = {}) {
  const ilDir = path.join(root, 'data', 'il');
  const watch = JSON.parse(await readFile(path.join(ilDir, 'watchlist.json'), 'utf8'));
  const dirs = (await readdir(ilDir, { withFileTypes: true })).filter((d) => d.isDirectory() && MONTH_RE.test(d.name)).map((d) => d.name).sort();
  const targets = (months && months.length ? months : monthsToCarry(now())).filter((m) => MONTH_RE.test(m));
  const carried = [], none = [], stale = [];
  for (const target of targets) {
    await mkdir(path.join(ilDir, target), { recursive: true });
    for (const c of watch.companies ?? []) {
      const t = String(c.ticker), dest = path.join(ilDir, target, `${t}.json`);
      if (await exists(dest)) continue;
      const earlier = dirs.filter((d) => d < target).reverse();
      let src = null;
      for (const d of earlier) { const p = path.join(ilDir, d, `${t}.json`); if (await exists(p)) { src = { dir: d, file: JSON.parse(await readFile(p, 'utf8')) }; break; } }
      if (!src) { none.push(`${target}/${t}`); continue; }
      const rd = Date.parse(src.file.reportDate), limit = new Date(now()); limit.setUTCMonth(limit.getUTCMonth() - MAX_REPORT_AGE_MONTHS);
      if (!Number.isFinite(rd) || rd < limit.getTime()) { stale.push(`${target}/${t}`); continue; }
      await writeFile(dest, JSON.stringify({ ...src.file, month: target, carriedForward: true, carriedFrom: src.file.carriedFrom ?? src.dir }, null, 2) + '\n');
      carried.push(`${target}/${t}`);
    }
  }
  log(`il carry-forward: ${carried.length} carried (${targets.join(', ')}), ${none.length} without an earlier file, ${stale.length} too old`);
  return { carried, none, stale };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  await run({ root, months: process.argv.slice(2) }).catch((e) => console.log('::warning::il carry-forward failed: ' + (e && e.message ? e.message : e)));
  process.exit(0);
}
