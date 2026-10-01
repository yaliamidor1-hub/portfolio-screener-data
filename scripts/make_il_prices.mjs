/**
 * make_il_prices.mjs — builds data/il/<YYYY-MM>/prices.json from a small text table, so prices read on MAYA / TASE by a person (or by a
 * Claude session that has a browser) can be turned into the file ingestIlPrices() expects without typing JSON.
 *
 *   node scripts/make_il_prices.mjs 2026-10 prices.csv
 *
 * CSV lines:  securityNumber,price,unit,date      e.g.  731018,1234,agorot,2026-10-01      (unit: agorot | ILS; header line and # comments allowed)
 * The source of each price is that company's MAYA page, taken from data/il/watchlist.json (issuerId): only use this for prices you read there.
 * Refuses (and writes nothing) when a security number is not in the watchlist, a price is not a positive number, a date is not yyyy-MM-dd,
 * or a line is malformed. The Apps Script validator re-checks everything (age <= 45 days, not in the future, duplicates).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildPrices(csvText, watchlist) {
  const byId = new Map((watchlist?.companies ?? []).map((c) => [String(c.ticker), c]));
  const prices = [], errors = [];
  String(csvText).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line || /^securityNumber\b/i.test(line)) return;
    const [sn, price, unit, date] = line.split(',').map((s) => s.trim());
    const at = `line ${i + 1}`;
    const c = byId.get(sn);
    if (!c) return errors.push(`${at}: security number "${sn}" is not in data/il/watchlist.json`);
    const p = Number(price);
    if (!price || !Number.isFinite(p) || p <= 0) return errors.push(`${at}: price "${price}" is not a positive number`);
    const u = (unit || 'ILS').toLowerCase() === 'agorot' ? 'agorot' : (unit || 'ILS').toUpperCase() === 'ILS' ? 'ILS' : null;
    if (!u) return errors.push(`${at}: unit "${unit}" must be agorot or ILS`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || Number.isNaN(Date.parse(date))) return errors.push(`${at}: date "${date}" must be yyyy-MM-dd`);
    if (!c.issuerId) return errors.push(`${at}: the watchlist has no issuerId for ${sn} (needed for the MAYA source URL)`);
    prices.push({ securityNumber: sn, price: p, priceUnit: u, priceDate: date, source: `https://maya.tase.co.il/he/companies/${c.issuerId}` });
  });
  const seen = new Set();
  for (const p of prices) { if (seen.has(p.securityNumber)) errors.push(`security number ${p.securityNumber} appears more than once`); seen.add(p.securityNumber); }
  return { prices, errors };
}

export async function run({ root, month, csvFile, log = console.log } = {}) {
  const watchlist = JSON.parse(await readFile(path.join(root, 'data', 'il', 'watchlist.json'), 'utf8'));
  const { prices, errors } = buildPrices(await readFile(csvFile, 'utf8'), watchlist);
  if (errors.length) { errors.forEach((e) => log('ERROR ' + e)); return { ok: false, errors }; }
  if (!prices.length) { log('ERROR no prices in the file'); return { ok: false, errors: ['empty'] }; }
  const dir = path.join(root, 'data', 'il', month);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'prices.json'), JSON.stringify({ month, prices }, null, 2) + '\n');
  log(`wrote data/il/${month}/prices.json with ${prices.length} price(s)`);
  return { ok: true, count: prices.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [month, csvFile] = process.argv.slice(2);
  if (!/^\d{4}-\d{2}$/.test(month || '') || !csvFile) { console.log('usage: node scripts/make_il_prices.mjs YYYY-MM prices.csv'); process.exit(2); }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const r = await run({ root, month, csvFile });
  process.exit(r.ok ? 0 : 1);
}
