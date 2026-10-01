import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseFeed, buildTickersText, run } from './sync_tickers.mjs';

const URL_ = 'https://script.google.com/macros/s/ABC/exec';
const mk = async (txt) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sync-'));
  await writeFile(path.join(root, 'tickers.txt'), txt);
  return root;
};
const resp = (body, status = 200) => async () => ({ ok: status < 400, status, text: async () => body });

test('parseFeed accepts plain ticker lists only', () => {
  assert.deepEqual(parseFeed('NOC\r\nlmt\nBRK.B\nNOC\n'), ['NOC', 'LMT', 'BRK-B']);
  assert.equal(parseFeed(''), null);
  assert.equal(parseFeed('  \n'), null);
  assert.equal(parseFeed('<!DOCTYPE html><html>'), null);
  assert.equal(parseFeed('NOC\n{"error":1}'), null);
  assert.equal(parseFeed('NOC\nbad ticker'), null);
});

test('buildTickersText follows the feed and keeps CIK lines of tickers that stay', () => {
  const out = buildTickersText('NOC\nBRK.B,1067983\nOLD\n# note\n', ['BRK-B', 'NOC', 'CYBR']);
  assert.equal(out, 'BRK.B,1067983\nNOC\nCYBR\n');
});

test('run: rewrites tickers.txt from the Universe feed and sends the token without logging it', async () => {
  const root = await mk('NOC\nOLD\n');
  const logs = [];
  let called = '';
  const r = await run({
    root, url: URL_, token: 'sekret-token', log: (m) => logs.push(m),
    fetchImpl: async (u) => { called = u; return resp('NOC\nCYBR\nS\nTENB\nMSFT\n')(); },
  });
  assert.equal(r.changed, true);
  assert.equal(await readFile(path.join(root, 'tickers.txt'), 'utf8'), 'NOC\nCYBR\nS\nTENB\nMSFT\n');
  assert.ok(called.includes('tickers=1') && called.includes('token=sekret-token'));
  const all = logs.join('\n');
  assert.ok(all.includes('added: CYBR, S, TENB, MSFT') && all.includes('removed: OLD'));
  assert.ok(!all.includes('sekret-token') && !all.includes('script.google.com'));
});

test('run: every failure mode keeps tickers.txt as is, warns, never throws', async () => {
  const boom = async () => { throw Object.assign(new TypeError('fetch failed ' + URL_ + '?token=sekret-token'), { name: 'TypeError' }); };
  const cases = [
    ['no secrets', { url: '', token: '' }, resp('NOC\n')],
    ['http error', {}, resp('x', 500)],
    ['empty answer (bad token)', {}, resp('')],
    ['html answer', {}, resp('<!DOCTYPE html><html><body>report</body></html>')],
    ['network error', {}, boom],
  ];
  for (const [name, o, fetchImpl] of cases) {
    const root = await mk('NOC\nLMT\n');
    const logs = [];
    const r = await run({ root, url: URL_, token: 'sekret-token', ...o, fetchImpl, log: (m) => logs.push(m) });
    assert.equal(r.changed, false, name);
    assert.equal(await readFile(path.join(root, 'tickers.txt'), 'utf8'), 'NOC\nLMT\n', name);
    const all = logs.join('\n');
    assert.ok(/::warning::tickers sync skipped/.test(all), name);
    assert.ok(!all.includes('sekret-token') && !all.includes('script.google.com'), name + ': no secret in the log');
  }
});

test('run: an unchanged list reports no change', async () => {
  const root = await mk('NOC\nLMT\n');
  const r = await run({ root, url: URL_, token: 't', fetchImpl: resp('NOC\nLMT\n'), log: () => {} });
  assert.equal(r.changed, false);
  assert.equal(r.used, 'universe');
});
