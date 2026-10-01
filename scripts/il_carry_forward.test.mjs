import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nextMonth, monthsToCarry, run } from './il_carry_forward.mjs';

test('nextMonth / monthsToCarry: the next month is prepared from the 18th on', () => {
  assert.equal(nextMonth('2026-12'), '2027-01'); assert.equal(nextMonth('2026-10'), '2026-11');
  assert.deepEqual(monthsToCarry(Date.parse('2026-10-05T10:00:00Z')), ['2026-10']);
  assert.deepEqual(monthsToCarry(Date.parse('2026-10-20T10:00:00Z')), ['2026-10', '2026-11']);
});

const setup = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'carry-'));
  const il = path.join(root, 'data', 'il'); await mkdir(path.join(il, '2026-09'), { recursive: true }); await mkdir(path.join(il, '2026-10'), { recursive: true });
  await writeFile(path.join(il, 'watchlist.json'), JSON.stringify({ companies: [{ ticker: '1' }, { ticker: '2' }, { ticker: '3' }, { ticker: '4' }] }));
  await writeFile(path.join(il, '2026-09', '1.json'), JSON.stringify({ ticker: '1', month: '2026-09', reportDate: '2026-06-30', marketCap: 100 }));
  await writeFile(path.join(il, '2026-09', '2.json'), JSON.stringify({ ticker: '2', month: '2026-09', reportDate: '2026-03-31' }));
  await writeFile(path.join(il, '2026-10', '2.json'), JSON.stringify({ ticker: '2', month: '2026-10', reportDate: '2026-06-30', fresh: true }));
  await writeFile(path.join(il, '2026-09', '4.json'), JSON.stringify({ ticker: '4', reportDate: '2024-01-31' }));   // older than 15 months
  return { root, il };
};

test('run: copies the newest earlier file when the month has none; never overwrites; skips unknown and too-old companies', async () => {
  const { root, il } = await setup();
  const out = await run({ root, months: ['2026-10', '2026-11'], now: () => Date.parse('2026-10-20T00:00:00Z'), log: () => {} });
  assert.deepEqual(out.carried.sort(), ['2026-10/1', '2026-11/1', '2026-11/2']);
  assert.deepEqual(out.none.sort(), ['2026-10/3', '2026-11/3']); assert.deepEqual(out.stale.sort(), ['2026-10/4', '2026-11/4']);
  const c = JSON.parse(await readFile(path.join(il, '2026-10', '1.json'), 'utf8'));
  assert.deepEqual([c.month, c.carriedForward, c.carriedFrom, c.reportDate, c.marketCap], ['2026-10', true, '2026-09', '2026-06-30', 100]);
  assert.equal(JSON.parse(await readFile(path.join(il, '2026-10', '2.json'), 'utf8')).fresh, true, 'a real file of the month is kept');
  const n = JSON.parse(await readFile(path.join(il, '2026-11', '2.json'), 'utf8')); assert.equal(n.fresh, true, 'next month carries the NEWEST earlier file'); assert.equal(n.carriedFrom, '2026-10');
  const again = await run({ root, months: ['2026-10', '2026-11'], now: () => Date.parse('2026-10-20T00:00:00Z'), log: () => {} });
  assert.deepEqual(again.carried, [], 'idempotent');
});
