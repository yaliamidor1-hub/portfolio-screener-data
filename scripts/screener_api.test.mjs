import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, buildUrl, call } from './screener_api.mjs';

const ENV = { WEBAPP_URL: 'https://script.google.com/macros/s/AKfycbxyz/exec', TICKERS_TOKEN: 'abcdefghijklmnop1234' };

test('parseEnv: KEY=value lines, comments and quotes', () => {
  assert.deepEqual(parseEnv('# c\nWEBAPP_URL=https://x/exec\nTICKERS_TOKEN="abc"\n\nBAD LINE\n'), { WEBAPP_URL: 'https://x/exec', TICKERS_TOKEN: 'abc' });
});

test('buildUrl: the right feed parameter, the month for ilcheck, and refuses a bad setup', () => {
  assert.equal(buildUrl(ENV, 'queue'), 'https://script.google.com/macros/s/AKfycbxyz/exec?queue=1&token=abcdefghijklmnop1234');
  assert.match(buildUrl(ENV, 'ilcheck', '2026-11'), /ilcheck=1&month=2026-11&token=/);
  assert.throws(() => buildUrl({ ...ENV, WEBAPP_URL: 'http://evil.example/exec' }, 'queue'), /WEBAPP_URL/);
  assert.throws(() => buildUrl({ ...ENV, TICKERS_TOKEN: 'short' }, 'queue'), /TICKERS_TOKEN/);
  assert.throws(() => buildUrl(ENV, 'drop'), /unknown command/);
});

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
test('call: JSON answers, a busy answer is retried, an empty answer is explained, the token never appears in an error', async () => {
  assert.deepEqual(await call({ env: ENV, command: 'status', fetchImpl: async () => res(200, '{"total":2}') }), { total: 2 });
  let n = 0;
  const seq = async () => (++n === 1 ? res(200, '{"ok":false,"busy":true}') : res(200, '{"ok":true,"done":3}'));
  assert.deepEqual(await call({ env: ENV, command: 'finalize', fetchImpl: seq, sleep: async () => {} }), { ok: true, done: 3 });
  await assert.rejects(call({ env: ENV, command: 'queue', fetchImpl: async () => res(200, ''), retries: 0, sleep: async () => {} }), /empty answer/);
  await assert.rejects(call({ env: ENV, command: 'queue', fetchImpl: async () => res(200, '<html>login</html>'), retries: 0 }), /did not answer with JSON/);
  await assert.rejects(call({ env: ENV, command: 'queue', fetchImpl: async (u) => { throw new Error('fail ' + u); }, retries: 0 }), (e) => !e.message.includes(ENV.TICKERS_TOKEN) && /fail/.test(e.message));
});
