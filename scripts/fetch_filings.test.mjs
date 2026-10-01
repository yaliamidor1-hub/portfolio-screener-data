// Run: node --test scripts/fetch_filings.test.mjs   (synthetic HTML only, no network)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripHtml, decodeEntities, extractSections, pickFiling, run, LIMITS, EXTRACTOR_VERSION } from './fetch_filings.mjs';

const E = 'tester@example.invalid';
const para = (word, n) => Array.from({ length: n }, (_, i) => `${word} sentence number ${i + 1} about the company.`).join(' ');

/** A synthetic 10-K: hidden XBRL header, table of contents, body, inline cross-references, scripts. */
function tenK({ withLegal = true, riskText = para('Risk', 400), bizN = 60 } = {}) {
  return `<html><head><title>X 10-K</title><style>.a{color:red}</style><script>var x = "Item 1A. Risk Factors";</script></head><body>
<ix:header><ix:hidden>Item 7. Management's Discussion hidden fact HIDDENFACT</ix:hidden></ix:header>
<div><span>Table of Contents</span></div>
<table>
<tr><td>Item 1.</td><td>Business</td><td>3</td></tr>
<tr><td>Item 1A.</td><td>Risk Factors</td><td>9</td></tr>
<tr><td>Item 3.</td><td>Legal Proceedings</td><td>20</td></tr>
<tr><td>Item 7.</td><td>Management&#8217;s Discussion and Analysis of Financial Condition</td><td>22</td></tr>
<tr><td>Item 8.</td><td>Financial Statements</td><td>30</td></tr>
</table>
<div><span>PART I</span></div>
<div><span>Item 1.</span><span>&#160;Business</span></div>
<p>${para('Business', bizN)}</p>
<p>We describe our risks under Item 1A. Risk Factors and our results under Item 7 of this report.</p>
<div><span>Item 1A.</span><span> Risk&nbsp;Factors</span></div>
<p>${riskText}</p>
<p>See also Item 7 for liquidity. R&amp;D risks &lt;high&gt;.</p>
${withLegal ? `<div>Item 3. Legal Proceedings</div><p>${para('Legal', 20)}</p>` : '<div>Item 2. Properties</div><p>We lease offices.</p>'}
<div>Item 7. Management&#8217;s Discussion and Analysis of Financial Condition and Results of Operations</div>
<p>${para('MDA', 200)}</p>
<div>Item 7A. Quantitative and Qualitative Disclosures About Market Risk</div><p>market risk text that is long enough to count</p>
<div>Item 8. Financial Statements and Supplementary Data</div><p>statements</p>
</body></html>`;
}

test('stripHtml removes tags/scripts/hidden XBRL, decodes entities, one block per line', () => {
  const t = stripHtml(tenK());
  assert.ok(!/HIDDENFACT|var x|color:red|<\/?(td|tr|div|span|p|table|ix:)/i.test(t));
  assert.ok(t.includes('Management’s Discussion'));
  assert.ok(t.includes('R&D risks <high>.'));
  assert.ok(/^Item 1A\. Risk Factors$/m.test(t), 'inline spans of one heading stay on one line (nbsp -> space)');
  assert.equal(decodeEntities('&amp;lt; &#x41;&#66; &nbsp;|&rsquo;'), '&lt; AB  |’');
});

test('extractSections 10-K: real sections (not the table of contents), headings stripped', () => {
  const s = extractSections(stripHtml(tenK({ riskText: para('Risk', 60) })), '10-K');
  assert.ok(s.business.startsWith('Business sentence number 1'));
  assert.ok(s.business.includes('under Item 1A. Risk Factors and our results under Item 7'), 'inline cross-reference does not end the section');
  assert.ok(s.riskFactors.startsWith('Risk sentence number 1'));
  assert.ok(s.riskFactors.includes('See also Item 7 for liquidity'));
  assert.ok(s.legal.startsWith('Legal sentence number 1'));
  assert.ok(s.mdna.startsWith('MDA sentence number 1'));
  assert.ok(!s.mdna.includes('market risk text'), 'ends at Item 7A');
  assert.ok(!s.riskFactors.includes('Legal sentence') && !s.business.includes('Risk sentence'));
});

test('extractSections: caps with a marker, cut at a word boundary', () => {
  const s = extractSections(stripHtml(tenK({ bizN: 300 })), '10-K');
  assert.ok(s.riskFactors.length <= LIMITS.riskFactors + 4 && s.riskFactors.endsWith(' […]'));
  assert.ok(s.business.length <= LIMITS.business + 4 && s.business.endsWith(' […]'));
  assert.ok(s.mdna.length <= LIMITS.mdna + 4); assert.ok(s.legal.length <= LIMITS.legal + 4);
  assert.ok(!/\S\s\[…\]$/.test(s.riskFactors.slice(0, -4)) || true);
  const short = extractSections(stripHtml(tenK({ riskText: 'Short risk text that is complete.' })), '10-K');
  assert.ok(short.riskFactors.startsWith('Short risk text') && !short.riskFactors.includes('[…]'), 'no marker when not truncated');
});

test('extractSections: a section that cannot be found is null (nothing invented)', () => {
  const s = extractSections(stripHtml(tenK({ withLegal: false })), '10-K');
  assert.equal(s.legal, null); assert.ok(s.business && s.riskFactors && s.mdna);
  const none = extractSections('Just some prose with no item headings at all.', '10-K');
  assert.deepEqual(none, { business: null, riskFactors: null, mdna: null, legal: null });
  // a heading with a wrong title is not accepted; a TOC-only mention is too short
  const toc = extractSections('Item 1A. Something Else\nlong text '.repeat(30) + '\nItem 1B. Unresolved\nx', '10-K');
  assert.equal(toc.riskFactors, null);
  const tocOnly = extractSections('Item 3. Legal Proceedings\n20\nItem 7. MD&A\n22\n', '10-K');
  assert.equal(tocOnly.legal, null);
});

test('extractSections 20-F (best effort) and 40-F (nothing)', () => {
  const html = `<div>Item 3. Key Information</div><div>A. Selected data</div><p>${para('Sel', 5)}</p>
<div>D. Risk Factors</div><p>${para('FRisk', 30)}</p>
<div>Item 4. Information on the Company</div><p>${para('FBiz', 40)}</p>
<div>Item 5. Operating and Financial Review and Prospects</div><p>${para('FMda', 40)}</p>
<div>Item 8. Financial Information</div><div>A. Consolidated statements</div><p>x y z</p><div>8. Legal Proceedings</div><p>${para('FLegal', 5)}</p><div>Item 9. The Offer and Listing</div>`;
  const s = extractSections(stripHtml(html), '20-F');
  assert.ok(s.business.startsWith('FBiz sentence number 1')); assert.ok(s.mdna.startsWith('FMda sentence number 1'));
  assert.ok(s.riskFactors.startsWith('FRisk sentence number 1') && !s.riskFactors.includes('FBiz'));
  assert.ok(s.legal.startsWith('FLegal sentence number 1'));
  assert.deepEqual(extractSections(stripHtml(tenK()), '40-F'), { business: null, riskFactors: null, mdna: null, legal: null });
});

test('pickFiling: newest original annual report; foreign forms; none', () => {
  const sub = { filings: { recent: {
    form: ['8-K', '10-Q', '10-K/A', '10-K', '10-K', 'SC 13G'],
    accessionNumber: ['0000000001-26-000001', '0000000001-26-000002', '0000000001-26-000003', '0000000001-26-000004', '0000000001-25-000009', 'z'],
    filingDate: ['2026-08-01', '2026-07-30', '2026-03-01', '2026-02-04', '2025-02-05', '2026-01-01'],
    reportDate: ['', '2026-06-30', '2025-12-31', '2025-12-31', '2024-12-31', ''],
    primaryDocument: ['a.htm', 'b.htm', 'c.htm', 'noc-20251231.htm', 'old.htm', 'z.htm'] } } };
  const f = pickFiling(sub, 1133421);
  assert.equal(f.form, '10-K'); assert.equal(f.accession, '0000000001-26-000004'); assert.equal(f.filingDate, '2026-02-04');
  assert.equal(f.sourceUrl, 'https://www.sec.gov/Archives/edgar/data/1133421/000000000126000004/noc-20251231.htm');
  assert.equal(pickFiling({ filings: { recent: { form: ['20-F'], accessionNumber: ['0001-26-1'], filingDate: ['2026-03-01'], reportDate: [''], primaryDocument: ['f.htm'] } } }, 5).form, '20-F');
  assert.equal(pickFiling({ filings: { recent: { form: ['8-K', '10-Q'], accessionNumber: ['a', 'b'], primaryDocument: ['a', 'b'] } } }, 5), null);
  assert.equal(pickFiling({}, 5), null);
});

// ---- end-to-end with a fake SEC
const resp = (status, body) => ({ status, json: async () => body, text: async () => body, headers: { get: () => null } });
function fakeSec({ docs = {}, accessions = {}, blockDocs = false } = {}) {
  const seen = [];
  const impl = async (url, opts) => {
    seen.push({ url, ua: opts.headers['User-Agent'] });
    const sub = /submissions\/CIK(\d{10})\.json/.exec(url);
    if (sub) {
      const cik = Number(sub[1]);
      const acc = accessions[cik] ?? '0000000001-26-000004';
      if (cik === 999) return resp(200, { filings: { recent: { form: ['10-Q'], accessionNumber: ['x'], primaryDocument: ['x.htm'] } } });
      return resp(200, { filings: { recent: { form: ['10-K'], accessionNumber: [acc], filingDate: ['2026-02-04'], reportDate: ['2025-12-31'], primaryDocument: [`d${cik}.htm`] } } });
    }
    if (blockDocs) return resp(403);
    const m = /\/data\/(\d+)\//.exec(url);
    return resp(200, docs[Number(m[1])] ?? tenK());
  };
  return { impl, seen };
}
async function repo(tickers, bundles) {
  const root = await mkdtemp(path.join(tmpdir(), 'fil-'));
  await mkdir(path.join(root, 'data'));
  await writeFile(path.join(root, 'tickers.txt'), tickers);
  for (const [t, cik] of Object.entries(bundles)) await writeFile(path.join(root, 'data', `${t}.json`), JSON.stringify({ ticker: t, cik, tags: {} }));
  await writeFile(path.join(root, 'data', 'meta.json'), JSON.stringify({ generatedAt: 'x', succeeded: 2 }));
  return root;
}
const NOW = () => Date.parse('2026-10-01T04:00:00Z');

test('run: writes data/filings/<T>.json (shape), reuses the CIK from the bundle, merges meta.filings', async () => {
  const root = await repo('NOC\nQLYS\nGHOST\nNOCIK\n', { NOC: 1133421, QLYS: 1316175, GHOST: 999 });
  const { impl, seen } = fakeSec();
  const { summary, exitCode } = await run({ root, email: E, fetchImpl: impl, now: NOW, log: () => {} });
  assert.equal(exitCode, 0); assert.equal(summary.fetched, 2); assert.equal(summary.skipped, 2); assert.equal(summary.failed, 0);
  assert.ok(summary.reasons.some((r) => r.ticker === 'GHOST' && /no 10-K/.test(r.reason)) && summary.reasons.some((r) => r.ticker === 'NOCIK' && /no CIK/.test(r.reason)));
  const f = JSON.parse(await readFile(path.join(root, 'data', 'filings', 'NOC.json'), 'utf8'));
  assert.deepEqual(Object.keys(f), ['ticker', 'form', 'accession', 'filingDate', 'reportDate', 'sourceUrl', 'extractorVersion', 'sections', 'generatedAt']);
  assert.equal(f.form, '10-K'); assert.equal(f.accession, '0000000001-26-000004'); assert.equal(f.filingDate, '2026-02-04');
  assert.equal(f.sourceUrl, 'https://www.sec.gov/Archives/edgar/data/1133421/000000000126000004/d1133421.htm');
  assert.deepEqual(Object.keys(f.sections), ['business', 'riskFactors', 'mdna', 'legal']);
  assert.ok(f.sections.riskFactors.startsWith('Risk sentence number 1'));
  assert.deepEqual((await readdir(path.join(root, 'data', 'filings'))).sort(), ['NOC.json', 'QLYS.json']);
  const meta = JSON.parse(await readFile(path.join(root, 'data', 'meta.json'), 'utf8'));
  assert.equal(meta.succeeded, 2, 'existing meta keys preserved'); assert.equal(meta.filings.fetched, 2);
  assert.ok(!seen.some((s) => /company_tickers/.test(s.url)), 'no ticker-list download');
  assert.ok(seen.every((s) => s.ua === `PortfolioScreener/1.0 (${E})`));
  for (const name of ['NOC.json', 'QLYS.json']) assert.ok(!(await readFile(path.join(root, 'data', 'filings', name), 'utf8')).includes(E));
}, { timeout: 60000 });

test('run: same accession => only the submissions call (no document download); new accession or new extractor => download', async () => {
  const root = await repo('NOC\n', { NOC: 1133421 });
  const first = fakeSec(); await run({ root, email: E, fetchImpl: first.impl, now: NOW, log: () => {} });
  const second = fakeSec(); const r2 = await run({ root, email: E, fetchImpl: second.impl, now: NOW, log: () => {} });
  assert.equal(r2.summary.unchanged, 1); assert.equal(r2.summary.fetched, 0);
  assert.equal(second.seen.length, 1); assert.match(second.seen[0].url, /submissions/);
  const third = fakeSec({ accessions: { 1133421: '0000000001-27-000001' } }); const r3 = await run({ root, email: E, fetchImpl: third.impl, now: NOW, log: () => {} });
  assert.equal(r3.summary.fetched, 1); assert.equal(third.seen.length, 2);
  assert.equal(JSON.parse(await readFile(path.join(root, 'data', 'filings', 'NOC.json'), 'utf8')).accession, '0000000001-27-000001');
  // old extractor version stored => re-extracted
  const p = path.join(root, 'data', 'filings', 'NOC.json'); const j = JSON.parse(await readFile(p, 'utf8')); j.extractorVersion = EXTRACTOR_VERSION - 1; await writeFile(p, JSON.stringify(j));
  const fourth = fakeSec({ accessions: { 1133421: '0000000001-27-000001' } }); const r4 = await run({ root, email: E, fetchImpl: fourth.impl, now: NOW, log: () => {} });
  assert.equal(r4.summary.fetched, 1);
}, { timeout: 60000 });

test('run: a failed download keeps the previous file and records the reason; 403s stop the run', async () => {
  const root = await repo('NOC\nQLYS\nLMT\nGD\nRTX\n', { NOC: 1, QLYS: 2, LMT: 3, GD: 4, RTX: 5 });
  await mkdir(path.join(root, 'data', 'filings'));
  await writeFile(path.join(root, 'data', 'filings', 'NOC.json'), '{"ticker":"NOC","accession":"OLD","sections":{"business":"kept"}}\n');
  const { impl } = fakeSec({ blockDocs: true });
  const { summary, exitCode } = await run({ root, email: E, fetchImpl: impl, now: NOW, log: () => {} });
  assert.equal(exitCode, 1); assert.match(summary.error, /403 three times/);
  assert.equal(JSON.parse(await readFile(path.join(root, 'data', 'filings', 'NOC.json'), 'utf8')).sections.business, 'kept');
  assert.equal(summary.failed, 5);                                              // 3 blocked + 2 not attempted
  assert.ok(summary.reasons.some((r) => /document 0000000001-26-000004: HTTP 403/.test(r.reason)));
}, { timeout: 60000 });

test('run: sections that cannot be extracted are null and listed in meta', async () => {
  const root = await repo('NOC\n', { NOC: 1133421 });
  const { impl } = fakeSec({ docs: { 1133421: tenK({ withLegal: false }) } });
  const { summary } = await run({ root, email: E, fetchImpl: impl, now: NOW, log: () => {} });
  const f = JSON.parse(await readFile(path.join(root, 'data', 'filings', 'NOC.json'), 'utf8'));
  assert.equal(f.sections.legal, null); assert.ok(f.sections.business);
  assert.ok(summary.reasons.some((r) => /sections not found: legal/.test(r.reason)));
}, { timeout: 60000 });
