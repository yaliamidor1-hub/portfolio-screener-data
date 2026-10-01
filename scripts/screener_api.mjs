/**
 * screener_api.mjs — the monthly Claude task's door to the Apps Script web app (token-protected feeds), without the token ever being typed in a chat.
 *
 *   node scripts/screener_api.mjs queue            > .work/queue.json        the stocks that need a review this month (with their input packages)
 *   node scripts/screener_api.mjs status                                      which reviews the code accepted so far
 *   node scripts/screener_api.mjs finalize                                    validate the pushed report files (+ send the e-mail if everything is ready)
 *   node scripts/screener_api.mjs ilcheck 2026-11                             dry-run validation of the Israeli data files of that month
 *   node scripts/screener_api.mjs themes           > .work/themes.json        active themes + Universe (US theme discovery)
 *
 * Settings: a file `.env` in the repo root (git-ignored; created once by the owner):
 *   WEBAPP_URL=https://script.google.com/macros/s/<id>/exec
 *   TICKERS_TOKEN=<the same value as the Script Property TICKERS_TOKEN>
 * (or the same names as environment variables). The token is never printed.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const COMMANDS = { queue: 'queue', status: 'status', finalize: 'finalize', ilcheck: 'ilcheck', themes: 'themes' };

export function parseEnv(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export function buildUrl(env, command, arg) {
  const base = env.WEBAPP_URL, token = env.TICKERS_TOKEN;
  if (!base || !/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(base)) throw new Error('WEBAPP_URL is missing or is not a https://script.google.com/macros/s/<id>/exec address (see the header of scripts/screener_api.mjs)');
  if (!token || token.length < 16) throw new Error('TICKERS_TOKEN is missing or too short');
  if (!COMMANDS[command]) throw new Error(`unknown command "${command}" (${Object.keys(COMMANDS).join(', ')})`);
  const u = new URL(base);
  u.searchParams.set(COMMANDS[command], '1');
  if (command === 'ilcheck' && arg) u.searchParams.set('month', arg);
  u.searchParams.set('token', token);
  return u.toString();
}

/** One call; the answer must be JSON (an empty answer means a wrong token or no deployed web app). Retries a busy / transient failure. */
export async function call({ env, command, arg, fetchImpl = fetch, retries = 2, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const url = buildUrl(env, command, arg);
  let last = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, { redirect: 'follow' });
      const text = await res.text();
      if (res.ok && text.trim()) {
        try { const data = JSON.parse(text); if (data && data.busy && attempt < retries) { last = 'busy'; await sleep(30_000); continue; } return data; }
        catch { throw new Error('the web app did not answer with JSON (is the deployment current? run clasp push + redeploy)'); }
      }
      last = res.ok ? 'empty answer (wrong token, or the web app is not deployed with the current version)' : `HTTP ${res.status}`;
    } catch (e) { last = String(e && e.message ? e.message : e).replaceAll(env.TICKERS_TOKEN ?? '\u0000', '***'); if (/JSON/.test(last)) throw new Error(last); }
    if (attempt < retries) await sleep(5_000 * (attempt + 1));
  }
  throw new Error(last);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let env = { ...process.env };
  try { env = { ...parseEnv(await readFile(path.join(root, '.env'), 'utf8')), ...(process.env.WEBAPP_URL ? { WEBAPP_URL: process.env.WEBAPP_URL } : {}), ...(process.env.TICKERS_TOKEN ? { TICKERS_TOKEN: process.env.TICKERS_TOKEN } : {}) }; } catch { /* env vars only */ }
  try {
    const data = await call({ env, command: process.argv[2], arg: process.argv[3] });
    process.stdout.write(JSON.stringify(data, null, 1) + '\n');
  } catch (e) { console.error('ERROR: ' + (e && e.message ? e.message : e)); process.exit(1); }
}
