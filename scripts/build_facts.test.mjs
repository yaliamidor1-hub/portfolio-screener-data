import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildFacts, annualValues, instantValues, run } from './build_facts.mjs';

const flow = (start, end, val, form = '10-K', filed = '2026-02-01') => ({ start, end, val, form, filed });
const inst = (end, val, form = '10-K', filed = '2026-02-01') => ({ end, val, form, filed });
const concept = (tag, list) => ({ taxonomy: tag.split('/')[0], tag: tag.split('/')[1], units: { USD: list } });
const years = [2023, 2024, 2025];
const bundle = () => ({
  ticker: 'EXMP', cik: 1, generatedAt: '2026-10-01T00:00:00Z',
  tags: {
    'us-gaap/Revenues': concept('us-gaap/Revenues', [
      ...years.map((y, i) => flow(`${y}-01-01`, `${y}-12-31`, 1000 + i * 100, '10-K', `${y + 1}-02-01`)),
      flow('2026-01-01', '2026-06-30', 700, '10-Q', '2026-08-01'),                    // a half year: never a fiscal year
      flow('2025-01-01', '2025-12-31', 1250, '10-K/A', '2026-03-01'),                 // restated: the latest filing of the year wins
    ]),
    'us-gaap/NetIncomeLoss': concept('us-gaap/NetIncomeLoss', years.map((y, i) => flow(`${y}-01-01`, `${y}-12-31`, 100 + i * 20, '10-K', `${y + 1}-02-01`))),
    'us-gaap/NetCashProvidedByUsedInOperatingActivities': concept('x/y', years.map((y, i) => flow(`${y}-01-01`, `${y}-12-31`, 150 + i * 10, '10-K', `${y + 1}-02-01`))),
    'us-gaap/PaymentsToAcquirePropertyPlantAndEquipment': concept('x/y', [flow('2024-01-01', '2024-12-31', 40), flow('2025-01-01', '2025-12-31', 50)]),   // 2023 missing
    'us-gaap/LongTermDebtNoncurrent': concept('x/y', [inst('2025-12-31', 500), inst('2024-12-31', 450), inst('2025-09-30', 999, '10-Q')]),
    'us-gaap/StockholdersEquity': concept('x/y', [inst('2025-12-31', 800)]),
    'us-gaap/CashAndCashEquivalentsAtCarryingValue': concept('x/y', [inst('2025-12-31', 120)]),
  },
});

test('annualValues: full years of annual filings only, the latest filing of a year wins', () => {
  assert.deepEqual(annualValues(bundle(), 'us-gaap/Revenues'), { '2023-12-31': 1000, '2024-12-31': 1100, '2025-12-31': 1250 });
  assert.deepEqual(annualValues(bundle(), 'us-gaap/Nope'), {});
  assert.deepEqual(instantValues(bundle(), 'us-gaap/LongTermDebtNoncurrent', ['2025-12-31', '2024-12-31']), { '2025-12-31': 500, '2024-12-31': 450 });
});

test('buildFacts: multi-year values, growth, margins; a missing value is null, never 0', () => {
  const f = buildFacts(bundle());
  assert.equal(f.ticker, 'EXMP'); assert.equal(f.currency, 'USD');
  assert.deepEqual(f.years.map((y) => y.end), ['2025-12-31', '2024-12-31', '2023-12-31'], 'newest first');
  const [y25, y24, y23] = f.years;
  assert.equal(y25.revenue, 1250); assert.equal(y25.netIncome, 140); assert.equal(y25.operatingCashFlow, 170);
  assert.equal(y25.freeCashFlow, 120, 'operating cash flow - capex'); assert.equal(y24.freeCashFlow, 120);
  assert.equal(y23.capex, null); assert.equal(y23.freeCashFlow, null, 'no capex that year: no free cash flow, not the operating cash flow');
  assert.equal(y25.revenueGrowth, round(1250 / 1100 - 1)); assert.equal(y24.revenueGrowth, round(1100 / 1000 - 1)); assert.equal(y23.revenueGrowth, null, 'oldest year: no previous year');
  assert.equal(y25.netMargin, round(140 / 1250)); assert.equal(y25.grossMargin, null, 'no gross profit tag: null'); assert.equal(y25.cashConversion, round(120 / 140));
  assert.equal(y25.longTermDebt, 500); assert.equal(y25.shortTermDebt, null); assert.equal(y25.equity, 800); assert.equal(y25.cash, 120); assert.equal(y24.equity, null, 'balance-sheet value of another date is never borrowed');
  assert.ok(!JSON.stringify(f).includes('999'), 'a quarterly balance is not a year-end value');
});

test('buildFacts: no annual data / another currency => null', () => {
  assert.equal(buildFacts(null), null);
  assert.equal(buildFacts({ ticker: 'X', tags: {} }), null);
  assert.equal(buildFacts({ ticker: 'X', tags: { 'us-gaap/Revenues': { units: { ILS: [flow('2025-01-01', '2025-12-31', 5)] } } } }), null);
});

test('buildFacts: only the 6 latest fiscal years, and only consecutive years get growth', () => {
  const list = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2024].map((y) => flow(`${y}-01-01`, `${y}-12-31`, y, '10-K', `${y + 1}-02-01`));
  const f = buildFacts({ ticker: 'X', cik: 1, generatedAt: 'g', tags: { 'us-gaap/Revenues': concept('us-gaap/Revenues', list) } });
  assert.equal(f.years.length, 6); assert.equal(f.years[0].end, '2024-12-31');
  assert.equal(f.years[0].revenueGrowth, null, '2023 is missing: 2024 vs 2022 is not a year-over-year growth');
  assert.equal(f.years[1].revenueGrowth, round(2022 / 2021 - 1));
});

function round(x) { return Math.round(x * 10000) / 10000; }

test('run: writes data/facts/<T>.json, idempotent, skips meta.json and bundles without annual data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'facts-'));
  await mkdir(path.join(root, 'data'));
  await writeFile(path.join(root, 'data', 'EXMP.json'), JSON.stringify(bundle()));
  await writeFile(path.join(root, 'data', 'EMPTY.json'), JSON.stringify({ ticker: 'EMPTY', tags: {} }));
  await writeFile(path.join(root, 'data', 'meta.json'), JSON.stringify({ generatedAt: 'x' }));
  await writeFile(path.join(root, 'data', 'BAD.json'), '{not json');
  const logs = [];
  const r1 = await run({ root, log: (m) => logs.push(m) });
  assert.deepEqual([r1.written, r1.unchanged, r1.none.sort()], [1, 0, ['BAD(unreadable)', 'EMPTY']]);
  assert.deepEqual(await readdir(path.join(root, 'data', 'facts')), ['EXMP.json']);
  assert.equal(JSON.parse(await readFile(path.join(root, 'data', 'facts', 'EXMP.json'), 'utf8')).years[0].revenue, 1250);
  const r2 = await run({ root, log: () => {} });
  assert.deepEqual([r2.written, r2.unchanged], [0, 1], 'a second run changes nothing');
  assert.match(logs[0], /facts: 1 written, 0 unchanged, 2 without annual data/);
});
