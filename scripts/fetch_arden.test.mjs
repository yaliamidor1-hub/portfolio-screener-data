import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { htmlToText, issuerIdOf, marketCapOf, ratingOf, summaryOf, buildYear, run } from './fetch_arden.mjs';

test('ratingOf: the verdict in the closing sentences, also with the odd spacing of the source', () => {
  assert.equal(ratingOf('... כרגע אאורה למעקב '), 'watch');
  assert.equal(ratingOf('... לפי הקריטריונים שלנו החברה ל א עוברת.'), 'no');
  assert.equal(ratingOf('... החברה לא עוברת'), 'no');
  assert.equal(ratingOf('... היא כנראה הזולה בענף. חברה מעניינת .'), 'interesting');
  assert.equal(ratingOf('... חברה לא מעניינת'), 'no');
  assert.equal(ratingOf('חישוב NAV'), null);
});

test('issuerIdOf, marketCapOf, htmlToText, summaryOf', () => {
  assert.equal(issuerIdOf('<a href="https://maya.tase.co.il/company/1829?view=details">x</a>'), '1829');
  assert.equal(issuerIdOf('<a href="https://maya.tase.co.il/he/company/373">x</a>'), '373');
  assert.equal(issuerIdOf('<p>none</p>'), null);
  assert.equal(marketCapOf('אב-גד – שווי שוק 270 מ’. יזמית'), '270 מ׳');
  assert.equal(htmlToText('<p>a&nbsp;b</p><p>c<br>d</p><script>x()</script>'), 'a b\nc\nd');
  assert.match(summaryOf('x\nסיכום וניתוח\nשני קשיים. למעקב'), /^שני קשיים/);
});

const co = (name, id, tail) => ({ name, reviews: { '2026': `<p><a href="https://maya.tase.co.il/company/${id}">${name}</a> – שווי שוק 500 מ’. עסק.</p><p>סיכום וניתוח</p><p>${tail}</p>` } });
test('buildYear: ratings, his interesting list wins, reviews only for interesting + watch', () => {
  const cats = [['תקשורת', [co('א', '1', 'החברה למעקב'), co('ב', '2', 'לא עוברת'), co('ג', '3', 'משהו אחר')]], ['בנקים', [co('בנק', '4', 'חברה מעניינת')]]];
  const interesting = { companies: [{ name: 'ג', html: '<a href="https://maya.tase.co.il/company/3">ג</a>' }] };
  const { companies, reviews } = buildYear({ year: '2026', cats, interesting });
  assert.deepEqual(companies.map((c) => [c.name, c.rating, c.financialCategory]), [['א', 'watch', false], ['ב', 'no', false], ['ג', 'interesting', false], ['בנק', 'interesting', true]]);
  assert.deepEqual(Object.keys(reviews).sort(), ['1', '3', '4']);
  assert.equal(companies[0].marketCapText, '500 מ׳'); assert.equal(companies[0].issuerId, '1');
});

test('run: fetches the sector files, writes the index and the review texts; refuses a layout change', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arden-'));
  const many = Array.from({ length: 120 }, (_, i) => co('חברה' + i, String(1000 + i), i % 3 ? 'החברה למעקב' : 'לא עוברת'));
  const files = { '/data/search-index.json': [{ name: 'x', catName: 'תקשורת', catPos: 15, catIdx: 99 }], '/data/cat-15.json': many, '/data/interesting-2026.json': { companies: [] } };
  const f = async (u) => { const k = new URL(u).pathname; return files[k] ? { ok: true, status: 200, json: async () => files[k] } : { ok: false, status: 404 }; };
  const out = await run({ root, fetchImpl: f, delayMs: 0, log: () => {} });
  assert.equal(out.companies, 120);
  const idx = JSON.parse(await readFile(path.join(root, 'data', 'il', 'arden', '2026.json'), 'utf8'));
  assert.equal(idx.companies.length, 120); assert.equal(idx.counts.watch, 80);
  assert.match(JSON.parse(await readFile(path.join(root, 'data', 'il', 'arden', 'reviews', '1001.json'), 'utf8')).text, /למעקב/);
  const again = await run({ root, fetchImpl: f, delayMs: 0, log: () => {} });
  assert.equal(again.skipped, true, 'a fresh file is not fetched again');
  files['/data/cat-15.json'] = many.slice(0, 5);
  await assert.rejects(run({ root, fetchImpl: f, delayMs: 0, log: () => {}, force: true }), /layout changed/);
});
