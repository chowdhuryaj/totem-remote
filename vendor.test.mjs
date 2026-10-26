import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

// Every vendored file must equal `git show <sha>:<file>` after the specifier rewrite (drop ?v=NN).
const src = Object.fromEntries(readFileSync(new URL('./vendor/flask/SOURCE', import.meta.url), 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
const rewrite = (s) => s.replace(/(["'])(\.\/[^"'?]+)\?v=\d+(["'])/g, '$1$2$3');
const show = (f) => { try { return execFileSync('git', ['-C', src.repo, 'show', `${src.sha}:${f}`], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };

for (const f of src.files.split(' ')) {
  test(`vendored ${f} matches ${src.sha.slice(0, 7)}`, (t) => {
    const orig = show(f);
    if (orig === null) return t.skip('source repo/commit not available here');
    assert.equal(readFileSync(new URL(`./vendor/flask/${f}`, import.meta.url), 'utf8'), rewrite(orig));
  });
}
test('no vendored file outside SOURCE, no cache stamps left', () => {
  const listed = new Set([...src.files.split(' '), 'SOURCE']);
  for (const f of readdirSync(new URL('./vendor/flask/', import.meta.url))) assert.ok(listed.has(f), f);
  for (const f of src.files.split(' ')) assert.ok(!/\?v=\d+/.test(readFileSync(new URL(`./vendor/flask/${f}`, import.meta.url), 'utf8').split('\n').filter((l) => /from '|import\(/.test(l)).join('\n')), f);
});
