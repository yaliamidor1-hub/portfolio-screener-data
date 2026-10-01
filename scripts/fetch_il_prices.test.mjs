import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseQuote, namesMatch, stripHtml, run, PRICE_URL } from './fetch_il_prices.mjs';

const page = (name, price, change, date) => `<html><head><title>מניית ${name} | ביזפורטל</title><script>var x = "מניית fake 1 1% נכון ל: 01/01/2000";</script></head><body><nav>מדד ת"א</nav><h1>מניית ${name} <span>${price}</span> <span>${change}%</span> <span>נכון ל: ${date}</span></h1><div>שיוך למדדים: מדד ת"א</div></body></html>`;

test('parseQuote: name, price in agorot, change and date (the title and scripts are ignored)', () => {
  assert.deepEqual(parseQuote(page('מלם-תים אחזקות', '18,050', '1.8', '01/10/2026')), { name: 'מלם-תים אחזקות', price: 18050, change: 1.8, date: '2026-10-01', marketCap: null });
  assert.deepEqual(parseQuote(page('אב-גד', '1,134', '-1.31', '01/10/2026')), { name: 'אב-גד', price: 1134, change: -1.31, date: '2026-10-01', marketCap: null });
  assert.equal(parseQuote(page('אקסל', '183.2', '0', '30/09/2026')).price, 183.2);
  assert.match(parseQuote('<html>nothing here</html>').error, /quote line not found/);
  assert.match(parseQuote(page('x', '0', '1', '01/10/2026')).error, /positive/);
  assert.match(parseQuote(page('x', '5', '1', '31/02/2026')).error, /date/);
});

test('parseQuote: the market cap shown on the page (thousands of ILS) is read when present', () => {
  const html = page('גילת', '203', '0', '01/10/2026').replace('</body>', '<div>שווי שוק (אלפי &#8362) : 248,277 מכפיל רווח: 7.47</div></body>');
  assert.equal(parseQuote(html).marketCap, 248277);
});

test('namesMatch: a shared word, or one name contained in the other; a different company does not match', () => {
  assert.equal(namesMatch('מלם-תים אחזקות', 'מלם-תים אחזקות'), true);
  assert.equal(namesMatch('אב-גד', 'אב-גד החזקות'), true);
  assert.equal(namesMatch('מר', 'ח.מר תעשיות'), true);
  assert.equal(namesMatch('סופוויב מדיקל', 'סופווייב מדיקל'), true, 'one shared word: "מדיקל"');
  assert.equal(namesMatch('טלסיס', 'פוקס-ויזל'), false);
  assert.equal(stripHtml('<b>a&nbsp;b</b> &#8362;'), 'a b ₪');
});

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });

test('run: writes prices.json; skips a wrong page, a failing request and a future date; keeps a newer earlier price', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ilpx-'));
  await mkdir(path.join(root, 'data', 'il', '2026-10'), { recursive: true });
  await writeFile(path.join(root, 'data', 'il', 'watchlist.json'), JSON.stringify({ companies: [
    { ticker: '731018', name: 'מלם-תים אחזקות', issuerId: '731' }, { ticker: '175018', name: 'איביאי בית השקעות' }, { ticker: '1', name: 'חברה א' }, { ticker: '2', name: 'חברה ב' }, { ticker: '3', name: 'חברה ג' }, { ticker: '4', name: 'חברה ד' }] }));
  await writeFile(path.join(root, 'data', 'il', '2026-10', 'prices.json'), JSON.stringify({ prices: [{ securityNumber: '4', price: 999, priceUnit: 'agorot', priceDate: '2026-10-05', source: 'x' }] }));
  const pages = {
    [PRICE_URL('731018')]: res(200, page('מלם-תים אחזקות', '18,050', '1.8', '01/10/2026')),
    [PRICE_URL('175018')]: res(200, page('מניה אחרת לגמרי', '100', '0', '01/10/2026')),   // a different company
    [PRICE_URL('1')]: res(500, ''),
    [PRICE_URL('2')]: res(200, page('חברה ב', '50', '0', '01/01/2030')),                    // in the future
    [PRICE_URL('3')]: res(200, page('חברה ג', '70', '0', '01/10/2026')),
    [PRICE_URL('4')]: res(200, page('חברה ד', '80', '0', '01/10/2026')),                    // older than the price already in the file
  };
  const logs = [], urls = [];
  const out = await run({ root, month: '2026-10', delayMs: 0, now: () => Date.parse('2026-10-03T00:00:00Z'), log: (m) => logs.push(m), fetchImpl: async (u) => { urls.push(u); return pages[u] ?? res(404, ''); } });
  assert.equal(out.written, 3);
  const f = JSON.parse(await readFile(path.join(root, 'data', 'il', '2026-10', 'prices.json'), 'utf8'));
  assert.deepEqual(f.prices.map((p) => [p.securityNumber, p.price, p.priceUnit, p.priceDate]), [['731018', 18050, 'agorot', '2026-10-01'], ['3', 70, 'agorot', '2026-10-01'], ['4', 999, 'agorot', '2026-10-05']]);
  assert.equal(f.prices[0].source, 'https://www.bizportal.co.il/capitalmarket/quote/generalpage/731018', 'the real source is recorded');
  assert.deepEqual(out.skipped.map((s) => s[0]).sort(), ['1', '175018', '2']); assert.ok(out.skipped.some(([s, w]) => s === '175018' && /not "איביאי/.test(w)) && out.skipped.some(([s, w]) => s === '1' && /HTTP 500/.test(w)) && out.skipped.some(([s, w]) => s === '2' && /future/.test(w)));
  assert.ok(urls.every((u) => u.startsWith('https://www.bizportal.co.il/')), 'one request per company, nothing else');
  assert.match(logs[0], /prices: 3 written to data\/il\/2026-10\/prices.json, 3 skipped/);
});

test('run: nothing readable => no file is written', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ilpx-'));
  await mkdir(path.join(root, 'data', 'il'), { recursive: true });
  await writeFile(path.join(root, 'data', 'il', 'watchlist.json'), JSON.stringify({ companies: [{ ticker: '1', name: 'חברה א' }] }));
  const out = await run({ root, month: '2026-10', delayMs: 0, log: () => {}, fetchImpl: async () => { throw Object.assign(new Error('x'), { name: 'TypeError' }); } });
  assert.equal(out.written, 0); assert.match(out.skipped[0][1], /request failed \(TypeError\)/);
  await assert.rejects(readFile(path.join(root, 'data', 'il', '2026-10', 'prices.json'), 'utf8'));
});
