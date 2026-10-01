// Run: node --test scripts/   (Node 20+, no dependencies)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TAGS, trimConcept, parseTickers, normalizeTicker, canKeepBundle, cik10, getJson, run, KEEP_PERIODS } from './fetch_sec.mjs';

const E = 'tester@example.invalid';
const day = (n) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);

test('normalizeTicker / parseTickers', () => {
  assert.equal(normalizeTicker(' brk.b '), 'BRK-B');
  const t = parseTickers('# c\nNOC\n\nqlys # x\nBRK.B,1067983\nNOC\nbad ticker!\n');
  assert.deepEqual(t, [{ ticker: 'NOC', cik: null }, { ticker: 'QLYS', cik: null }, { ticker: 'BRK-B', cik: 1067983 }]);
});

test('trimConcept keeps the 12 latest period ends, slim entries, allowed forms only', () => {
  const entries = [];
  for (let i = 0; i < 20; i++) entries.push({ end: day(i * 91), val: i, form: '10-Q', filed: day(i * 91 + 30), accn: 'x', fy: 2020, fp: 'Q1', frame: 'CY' });
  entries.push({ end: day(2000), val: 1, form: '8-K', filed: day(2000) });            // wrong form
  entries.push({ end: day(2001), val: 'n/a', form: '10-K', filed: day(2001) });       // not numeric
  const out = trimConcept({ taxonomy: 'us-gaap', tag: 'X', label: 'long text', units: { USD: entries, EUR: [] } });
  assert.equal(out.units.USD.length, KEEP_PERIODS);
  assert.deepEqual(Object.keys(out.units), ['USD']);
  assert.deepEqual(Object.keys(out.units.USD[0]).sort(), ['end', 'filed', 'form', 'val']);
  assert.equal(out.units.USD[0].end, day(19 * 91));                                   // newest first
  assert.equal(out.label, undefined);
  assert.equal(trimConcept({ units: {} }), null);
  assert.equal(trimConcept(null), null);
});

test('trimConcept keeps duration facts (start) and every filing of a kept end', () => {
  const out = trimConcept({ taxonomy: 'us-gaap', tag: 'T', units: { USD: [
    { start: '2025-01-01', end: '2025-12-31', val: 10, form: '10-K', filed: '2026-02-01' },
    { start: '2025-01-01', end: '2025-12-31', val: 11, form: '10-K/A', filed: '2026-03-01' },
    { start: '2026-01-01', end: '2026-06-30', val: 5, form: '10-Q', filed: '2026-08-01' },
  ] } });
  assert.equal(out.units.USD.length, 3);
  assert.ok(out.units.USD.every((e) => e.start));
});

test('cik10 pads', () => assert.equal(cik10(1133421), '0001133421'));

test('canKeepBundle: only when unchanged AND recently generated', () => {
  const now = Date.parse('2026-10-10T00:00:00Z');
  const prev = { cik: 5, generatedAt: '2026-10-09T00:00:00Z', tags: { a: 1 } };
  assert.equal(canKeepBundle(prev, 5, { a: 1 }, now), true);
  assert.equal(canKeepBundle(prev, 5, { a: 2 }, now), false);                       // data changed
  assert.equal(canKeepBundle(prev, 6, { a: 1 }, now), false);                       // CIK changed
  assert.equal(canKeepBundle({ ...prev, generatedAt: '2026-10-05T00:00:00Z' }, 5, { a: 1 }, now), false); // refresh
  assert.equal(canKeepBundle(null, 5, {}, now), false);
});

const resp = (status, body, headers = {}) => ({ status, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });

test('getJson: 200, 404 (quiet), 403 not retried, 429 retried then ok, network error retried', async () => {
  let n = 0;
  assert.deepEqual(await getJson('u', 'ua', async () => resp(200, { a: 1 })), { status: 200, data: { a: 1 } });
  assert.deepEqual(await getJson('u', 'ua', async () => resp(404)), { status: 404 });
  n = 0; const r403 = await getJson('u', 'ua', async () => { n++; return resp(403); });
  assert.equal(r403.status, 403); assert.equal(n, 1);
  n = 0; const r = await getJson('u', 'ua', async () => (++n < 2 ? resp(429, null, { 'retry-after': '0' }) : resp(200, { ok: true })));
  assert.equal(r.status, 200); assert.equal(n, 2);
  n = 0; const rn = await getJson('u', 'ua', async () => { if (++n < 2) throw Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } }); return resp(200, { ok: 1 }); });
  assert.equal(rn.status, 200);
}, { timeout: 20000 });

// ---- end-to-end with a fake SEC
function fakeSec({ blockData = false, failTicker = null } = {}) {
  const seen = [];
  const impl = async (url, opts) => {
    seen.push({ url, ua: opts.headers['User-Agent'] });
    if (url.endsWith('company_tickers.json')) {
      return resp(200, { 0: { cik_str: 1133421, ticker: 'NOC' }, 1: { cik_str: 1316175, ticker: 'QLYS' }, 2: { cik_str: 999, ticker: 'EMPTY' }, 3: { cik_str: 936468, ticker: 'LMT' }, 4: { cik_str: 40533, ticker: 'GD' }, 5: { cik_str: 101829, ticker: 'RTX' } });
    }
    if (blockData) return resp(403);
    const m = /CIK(\d{10})\/([\w-]+)\/(\w+)\.json/.exec(url);
    const [, cik, tax, tag] = m;
    if (cik === cik10(999)) return resp(404);                                  // company with no data at all
    if (failTicker && cik === cik10(failTicker)) return resp(500);
    if (`${tax}/${tag}` === 'us-gaap/StockholdersEquity' || `${tax}/${tag}` === 'dei/EntityCommonStockSharesOutstanding') {
      return resp(200, { cik: Number(cik), taxonomy: tax, tag, label: 'x', units: { [tag.startsWith('Entity') ? 'shares' : 'USD']: [{ end: '2026-06-30', val: 100, form: '10-Q', filed: '2026-07-30', accn: 'a' }] } });
    }
    return resp(404);                                                           // tag unused
  };
  return { impl, seen };
}

async function tmpRepo(tickers) {
  const root = await mkdtemp(path.join(tmpdir(), 'sec-'));
  await writeFile(path.join(root, 'tickers.txt'), tickers);
  return root;
}

test('run: writes one bundle per ticker + meta, no email in any file, UA only in requests', async () => {
  const root = await tmpRepo('NOC\nQLYS\nEMPTY\nGHOST\n');
  const { impl, seen } = fakeSec();
  const { meta, exitCode } = await run({ root, email: E, fetchImpl: impl, now: () => Date.parse('2026-10-01T04:00:00Z'), log: () => {} });
  assert.equal(exitCode, 0);
  assert.equal(meta.succeeded, 2); assert.equal(meta.failed, 2);
  assert.deepEqual(meta.failures.map((f) => f.ticker).sort(), ['EMPTY', 'GHOST']);
  const files = (await readdir(path.join(root, 'data'))).sort();
  assert.deepEqual(files, ['NOC.json', 'QLYS.json', 'meta.json']);
  const noc = JSON.parse(await readFile(path.join(root, 'data', 'NOC.json'), 'utf8'));
  assert.equal(noc.ticker, 'NOC'); assert.equal(noc.cik, 1133421); assert.equal(noc.generatedAt, '2026-10-01T04:00:00.000Z');
  assert.deepEqual(Object.keys(noc.tags), ['us-gaap/StockholdersEquity', 'dei/EntityCommonStockSharesOutstanding']);
  assert.equal(noc.tags['us-gaap/StockholdersEquity'].label, undefined);
  for (const f of files) assert.ok(!(await readFile(path.join(root, 'data', f), 'utf8')).includes(E), 'email must not be written to files');
  assert.ok(seen.every((s) => s.ua === `PortfolioScreener/1.0 (${E})`));
  assert.equal(seen.filter((s) => s.url.includes('companyconcept') && s.url.includes('CIK0001133421')).length, TAGS.length, 'one request per tag');
}, { timeout: 60000 });

test('run: a failing ticker keeps its previous file; others still update', async () => {
  const root = await tmpRepo('NOC\nQLYS\n');
  await mkdir(path.join(root, 'data'));
  await writeFile(path.join(root, 'data', 'QLYS.json'), '{"ticker":"QLYS","cik":1316175,"generatedAt":"2026-09-20T00:00:00.000Z","tags":{"old":1}}\n');
  const { impl } = fakeSec({ failTicker: 1316175 });
  const { meta, exitCode } = await run({ root, email: E, fetchImpl: impl, now: () => Date.parse('2026-10-01T04:00:00Z'), log: () => {} });
  assert.equal(exitCode, 0); assert.equal(meta.succeeded, 1); assert.equal(meta.failed, 1);
  assert.match(meta.failures[0].reason, /HTTP 500/);
  const q = JSON.parse(await readFile(path.join(root, 'data', 'QLYS.json'), 'utf8'));
  assert.deepEqual(q.tags, { old: 1 });                                      // untouched
}, { timeout: 60000 });

test('run: unchanged recent bundle is not rewritten (no daily commit noise); old one is refreshed', async () => {
  const root = await tmpRepo('NOC\n');
  const { impl } = fakeSec();
  const t0 = Date.parse('2026-10-01T04:00:00Z');
  await run({ root, email: E, fetchImpl: impl, now: () => t0, log: () => {} });
  const first = await readFile(path.join(root, 'data', 'NOC.json'), 'utf8');
  const r2 = await run({ root, email: E, fetchImpl: impl, now: () => t0 + 86_400_000, log: () => {} });
  assert.equal(r2.meta.unchanged, 1);
  assert.equal(await readFile(path.join(root, 'data', 'NOC.json'), 'utf8'), first);
  await run({ root, email: E, fetchImpl: impl, now: () => t0 + 4 * 86_400_000, log: () => {} });
  assert.notEqual(await readFile(path.join(root, 'data', 'NOC.json'), 'utf8'), first, 'refreshed after 3+ days');
}, { timeout: 60000 });

test('run: SEC blocking (403) stops early, keeps old data, exit code 1', async () => {
  const root = await tmpRepo('NOC\nQLYS\nLMT\nGD\nRTX\n');
  const { impl } = fakeSec({ blockData: true });
  const { meta, exitCode } = await run({ root, email: E, fetchImpl: impl, now: () => 0, log: () => {} });
  assert.equal(exitCode, 1); assert.match(meta.error, /403 three times/); assert.equal(meta.succeeded, 0);
  assert.equal(meta.failed, 5);                                                // 3 blocked + 2 not attempted
}, { timeout: 60000 });

test('run: ticker list download failure -> meta only, exit 1', async () => {
  const root = await tmpRepo('NOC\n');
  const { meta, exitCode } = await run({ root, email: E, fetchImpl: async () => resp(403), now: () => 0, log: () => {} });
  assert.equal(exitCode, 1); assert.match(meta.error, /company_tickers/);
  assert.deepEqual(await readdir(path.join(root, 'data')), ['meta.json']);
}, { timeout: 60000 });
