import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { marketCapM, pickCandidates, run } from './il_candidates.mjs';

test('marketCapM', () => {
  assert.equal(marketCapM('270 מ׳'), 270); assert.equal(marketCapM('4,800 מ׳'), 4800); assert.equal(marketCapM('4.8 מיליארד'), 4800);
  assert.equal(marketCapM(null), null); assert.equal(marketCapM('x'), null);
});

const c = (issuerId, rating, cap, category = 'תקשורת') => ({ issuerId, name: 'ח' + issuerId, category, rating, marketCapText: cap, financialCategory: false });
test('pickCandidates: rating order, then size; skips watchlist, rejected, shells, small and unrated', () => {
  const arden = { companies: [c('1', 'watch', '900 מ׳'), c('2', 'interesting', '300 מ׳'), c('3', 'watch', '2,000 מ׳'), c('4', 'no', '5,000 מ׳'), c('5', 'watch', '100 מ׳'), c('6', 'watch', '800 מ׳', 'שלדים וחברות מעטפת'),
    c('7', 'watch', '700 מ׳'), c('8', 'watch', '650 מ׳'), c('9', 'watch', null), c(null, 'watch', '900 מ׳')] };
  const out = pickCandidates({ arden, watchIssuerIds: new Set(['7']), rejected: { 8: 'illiquid' } });
  assert.deepEqual(out.map((x) => x.issuerId), ['2', '3', '1', '9']);
  assert.equal(out[0].mayaUrl, 'https://maya.tase.co.il/he/companies/2');
});

test('run: writes candidates.json from the arden file, the watchlist and rejected.json', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cand-'));
  await mkdir(path.join(root, 'data', 'il', 'arden'), { recursive: true });
  await writeFile(path.join(root, 'data', 'il', 'arden', '2026.json'), JSON.stringify({ companies: [c('1', 'interesting', '500 מ׳'), c('2', 'watch', '600 מ׳')] }));
  await writeFile(path.join(root, 'data', 'il', 'watchlist.json'), JSON.stringify({ companies: [{ ticker: '5', issuerId: '1' }] }));
  const out = await run({ root, log: () => {} });
  assert.equal(out.written, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'data', 'il', 'candidates.json'), 'utf8')).candidates.map((x) => x.issuerId), ['2']);
});
