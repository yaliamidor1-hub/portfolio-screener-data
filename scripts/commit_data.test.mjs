// Tests commit_data.sh against throw-away git repos (a bare "remote" and clones). Needs bash + git.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'commit_data.sh').replace(/\\/g, '/');
const hasBash = spawnSync('bash', ['-c', 'git --version']).status === 0;
const sh = (cwd, cmd, env = {}) => spawnSync('bash', ['-c', cmd], {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...env },
});
const w = (dir, rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'cd-')).replace(/\\/g, '/');
  const remote = `${root}/remote.git`;
  sh(root, `git init -q --bare -b main "${remote}"`);
  const seed = `${root}/seed`;
  mkdirSync(seed);
  sh(seed, `git init -q -b main && git config core.autocrlf false && git remote add origin "${remote}"`);
  w(seed, 'tickers.txt', 'NOC\nLMT\n'); w(seed, 'data/NOC.json', '{"v":0}'); w(seed, 'data/meta.json', '{"run":0}');
  sh(seed, 'git add -A && git commit -q -m seed && git push -q origin main');
  const clone = (name) => { sh(root, `git clone -q -c core.autocrlf=false "${remote}" ${name}`); return `${root}/${name}`; };
  return { root, remote, clone };
}
const show = (remote, file) => sh(remote, `git show main:${file}`).stdout;
const run = (dir) => sh(dir, `bash "${SCRIPT}"`, { RETRY_SLEEP: '0' });

test('a concurrent run pushed the same files (add/add conflict): this run\'s data wins, no force', { skip: !hasBash }, () => {
  const { root, remote, clone } = setup();
  const mine = clone('mine'), other = clone('other');
  w(other, 'data/meta.json', '{"run":"other"}'); w(other, 'data/filings/NEW.json', '{"o":1}'); w(other, 'data/NOC.json', '{"v":"other"}');
  sh(other, 'git add -A && git commit -q -m other && git push -q origin main');
  // this run started from the seed and wrote the same files differently
  w(mine, 'data/meta.json', '{"run":"mine"}'); w(mine, 'data/filings/NEW.json', '{"m":1}'); w(mine, 'data/NOC.json', '{"v":"mine"}');
  const r = run(mine);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(show(remote, 'data/meta.json'), '{"run":"mine"}');
  assert.equal(show(remote, 'data/filings/NEW.json'), '{"m":1}');
  assert.equal(show(remote, 'data/NOC.json'), '{"v":"mine"}');
  assert.equal(sh(root, `git -C "${remote}" log --oneline main | wc -l`).stdout.trim(), '3', 'seed + other + this run (history kept, nothing force-pushed)');
});

test('push keeps being rejected: reset to origin/main and this run\'s data is re-applied on top', { skip: !hasBash }, () => {
  const { root, remote, clone } = setup();
  const mine = clone('mine'), other = clone('other');
  w(other, 'data/OTHER.json', '{"o":1}'); w(other, 'data/meta.json', '{"run":"other"}');
  sh(other, 'git add -A && git commit -q -m other && git push -q origin main');
  // the remote rejects the first 3 pushes (a race), then accepts
  const hook = `${remote}/hooks/pre-receive`;
  writeFileSync(hook, `#!/bin/sh\nf="${root}/count"\nn=$(cat "$f" 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > "$f"\n[ $n -le 3 ] && { echo "simulated race" >&2; exit 1; }\nexit 0\n`);
  chmodSync(hook, 0o755);
  w(mine, 'data/meta.json', '{"run":"mine"}'); w(mine, 'data/NOC.json', '{"v":"mine"}');
  const r = run(mine);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /resetting to origin\/main/);
  assert.equal(show(remote, 'data/meta.json'), '{"run":"mine"}');
  assert.equal(show(remote, 'data/NOC.json'), '{"v":"mine"}');
  assert.equal(show(remote, 'data/OTHER.json'), '{"o":1}', 'the other run\'s file is kept');
});

test('tickers.txt: a stale copy never overwrites a newer one; a changed one is pushed', { skip: !hasBash }, () => {
  const { remote, clone } = setup();
  const mine = clone('mine'), other = clone('other');
  w(other, 'tickers.txt', 'NOC\nLMT\nS\nTENB\nMSFT\n');
  sh(other, 'git add -A && git commit -q -m tickers && git push -q origin main');
  w(mine, 'data/meta.json', '{"run":"mine"}');   // this run did not touch tickers.txt
  assert.equal(run(mine).status, 0);
  assert.equal(show(remote, 'tickers.txt'), 'NOC\nLMT\nS\nTENB\nMSFT\n', 'newer tickers.txt kept');
  // this run changed tickers.txt (synced from the Universe) while a different change landed meanwhile
  const mine2 = clone('mine2'), other2 = clone('other2');
  w(other2, 'data/meta.json', '{"run":"x"}');
  sh(other2, 'git add -A && git commit -q -m x && git push -q origin main');
  w(mine2, 'tickers.txt', 'NOC\nLMT\nS\nTENB\nMSFT\nNEW\n'); w(mine2, 'data/meta.json', '{"run":"mine2"}');
  assert.equal(run(mine2).status, 0);
  assert.equal(show(remote, 'tickers.txt'), 'NOC\nLMT\nS\nTENB\nMSFT\nNEW\n');
  assert.equal(show(remote, 'data/meta.json'), '{"run":"mine2"}');
});

test('nothing changed: no commit, exit 0', { skip: !hasBash }, () => {
  const { clone } = setup();
  const mine = clone('mine');
  const r = run(mine);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No changes to commit/);
  assert.ok(existsSync(path.join(mine, 'tickers.txt')));
  assert.equal(readFileSync(path.join(mine, 'tickers.txt'), 'utf8'), 'NOC\nLMT\n');
});
