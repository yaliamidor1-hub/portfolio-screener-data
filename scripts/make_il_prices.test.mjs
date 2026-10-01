import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPrices, run } from './make_il_prices.mjs';

const wl = { companies: [{ ticker: '731018', issuerId: '731' }, { ticker: '175018', issuerId: '175' }, { ticker: '999', issuerId: '' }] };

test('buildPrices: lines -> entries with the MAYA company page as source', () => {
  const r = buildPrices('securityNumber,price,unit,date\n731018, 1234 ,agorot,2026-10-01\n# a comment\n175018,55.5,ILS,2026-10-02\n\n', wl);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.prices, [
    { securityNumber: '731018', price: 1234, priceUnit: 'agorot', priceDate: '2026-10-01', source: 'https://maya.tase.co.il/he/companies/731' },
    { securityNumber: '175018', price: 55.5, priceUnit: 'ILS', priceDate: '2026-10-02', source: 'https://maya.tase.co.il/he/companies/175' },
  ]);
  assert.equal(buildPrices('731018,10,,2026-10-01', wl).prices[0].priceUnit, 'ILS', 'unit defaults to ILS');
});

test('buildPrices: every bad line is reported, nothing is guessed', () => {
  const r = buildPrices('555,10,ILS,2026-10-01\n731018,abc,ILS,2026-10-01\n731018,-3,ILS,2026-10-01\n731018,10,USD,2026-10-01\n731018,10,ILS,01/10/2026\n999,10,ILS,2026-10-01\n731018,10,ILS,2026-10-01\n731018,11,ILS,2026-10-01', wl);
  assert.equal(r.errors.length, 7);
  assert.match(r.errors[0], /line 1: security number "555" is not in data\/il\/watchlist.json/);
  assert.match(r.errors[1], /not a positive number/); assert.match(r.errors[3], /must be agorot or ILS/); assert.match(r.errors[4], /must be yyyy-MM-dd/);
  assert.match(r.errors[5], /no issuerId/); assert.match(r.errors[6], /appears more than once/);
});

test('run: writes the file, or nothing on an error', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ilp-'));
  await mkdir(path.join(root, 'data', 'il'), { recursive: true });
  await writeFile(path.join(root, 'data', 'il', 'watchlist.json'), JSON.stringify(wl));
  await writeFile(path.join(root, 'ok.csv'), '731018,1234,agorot,2026-10-01\n'); await writeFile(path.join(root, 'bad.csv'), '731018,x,ILS,2026-10-01\n');
  const logs = [];
  assert.equal((await run({ root, month: '2026-10', csvFile: path.join(root, 'bad.csv'), log: (m) => logs.push(m) })).ok, false);
  await assert.rejects(readFile(path.join(root, 'data', 'il', '2026-10', 'prices.json'), 'utf8'));
  assert.equal((await run({ root, month: '2026-10', csvFile: path.join(root, 'ok.csv'), log: (m) => logs.push(m) })).ok, true);
  assert.equal(JSON.parse(await readFile(path.join(root, 'data', 'il', '2026-10', 'prices.json'), 'utf8')).prices[0].price, 1234);
});
