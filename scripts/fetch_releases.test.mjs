import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pickReleases, pickExhibit, run } from './fetch_releases.mjs';

const submissions = {
  filings: { recent: {
    form: ['8-K', '10-Q', '8-K', '8-K', '8-K'],
    items: ['5.02', '', '2.02,9.01', '2.02,9.01', '2.02'],
    accessionNumber: ['0001-26-9', '0001-26-8', '0001-26-7', '0001-26-5', '0001-26-3'],
    filingDate: ['2026-09-01', '2026-08-05', '2026-07-28', '2026-04-29', '2026-01-28'],
    reportDate: ['2026-09-01', '2026-06-30', '2026-07-28', '2026-04-29', '2026-01-28'],
    primaryDocument: ['a.htm', 'b.htm', 'c.htm', 'd.htm', 'e.htm'],
  } },
};

test('pickReleases: only 8-Ks with Item 2.02, newest first, at most 2', () => {
  assert.deepEqual(pickReleases(submissions).map((r) => r.accession), ['0001-26-7', '0001-26-5']);
  assert.deepEqual(pickReleases(submissions, 5).map((r) => r.accession), ['0001-26-7', '0001-26-5', '0001-26-3']);
  assert.deepEqual(pickReleases({}), []); assert.deepEqual(pickReleases(null), []);
});

test('pickExhibit: 99.1 preferred, then other 99, then a press-release name; never the 8-K body', () => {
  const idx = (names) => ({ directory: { item: names.map((name) => ({ name })) } });
  assert.equal(pickExhibit(idx(['abc-20260728.htm', 'abc-ex992.htm', 'abc-ex991.htm', 'abc.xsd'])), 'abc-ex991.htm');
  assert.equal(pickExhibit(idx(['x.htm', 'exhibit99_07282026.htm'])), 'exhibit99_07282026.htm');
  assert.equal(pickExhibit(idx(['x.htm', 'pressrelease.htm'])), 'pressrelease.htm');
  assert.equal(pickExhibit(idx(['x.htm', 'y.xml'])), null);
  assert.equal(pickExhibit(null), null);
});

const resp = (status, body) => ({ status, json: async () => body, text: async () => body, headers: { get: () => null } });

test('run: writes data/releases/<T>.json with the exhibit text, skips unchanged, keeps the old file on failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rel-'));
  await mkdir(path.join(root, 'data'));
  await writeFile(path.join(root, 'tickers.txt'), 'EXMP,1234\nNOCIK\n');
  await writeFile(path.join(root, 'data', 'meta.json'), '{}');
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes('submissions/CIK0000001234')) return resp(200, submissions);
    if (url.endsWith('/index.json')) return resp(200, { directory: { item: [{ name: 'main.htm' }, { name: 'ex991.htm' }] } });
    if (url.endsWith('ex991.htm')) return resp(200, '<html><body><p>Revenue was $2,725 million, up 6 percent.</p><script>x()</script></body></html>');
    return resp(404);
  };
  const logs = [];
  let r = await run({ root, email: 'x@example.invalid', fetchImpl, log: (m) => logs.push(m), now: () => Date.parse('2026-10-01T00:00:00Z') });
  const out = JSON.parse(await readFile(path.join(root, 'data', 'releases', 'EXMP.json'), 'utf8'));
  assert.equal(out.releases.length, 2); assert.equal(out.releases[0].accession, '0001-26-7');
  assert.ok(out.releases[0].url.endsWith('/ex991.htm') && out.releases[0].url.includes('/data/1234/'));
  assert.match(out.releases[0].text, /Revenue was \$2,725 million, up 6 percent\./); assert.ok(!out.releases[0].text.includes('x()'));
  assert.deepEqual([r.summary.fetched, r.summary.skipped], [1, 1]); assert.match(logs[0], /Releases: 1 fetched/);
  assert.ok(seen.every((u) => !u.includes('example.invalid')), 'the contact email only travels in the User-Agent');
  // unchanged on the next run (no document downloads)
  seen.length = 0; r = await run({ root, email: 'x@example.invalid', fetchImpl, log: () => {} });
  assert.equal(r.summary.unchanged, 1); assert.ok(!seen.some((u) => u.endsWith('ex991.htm')));
  // SEC failing keeps the previous file
  const before = await readFile(path.join(root, 'data', 'releases', 'EXMP.json'), 'utf8');
  const sub2 = JSON.parse(JSON.stringify(submissions)); sub2.filings.recent.accessionNumber[2] = '0001-26-NEW';
  r = await run({ root, email: 'x@example.invalid', log: () => {}, fetchImpl: async (url) => (url.includes('submissions') ? resp(200, sub2) : resp(500)) });
  assert.equal(r.summary.failed, 1); assert.equal(await readFile(path.join(root, 'data', 'releases', 'EXMP.json'), 'utf8'), before);
  const meta = JSON.parse(await readFile(path.join(root, 'data', 'meta.json'), 'utf8')); assert.ok(meta.releases);
});
