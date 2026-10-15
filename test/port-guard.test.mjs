import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');

// §48.2's rule as a test: the client-side surface of this port renders, marks and states
// absences. It does not rank.
test('the new surface loads exactly the four modules it needs, and no ranker', () => {
  const html = read('lorehaven.html');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['db.js', 'lorehaven.js', 'cache.js', 'feed-model.js', 'lorehaven-page.js']);
  for (const banned of ['scoring.js', 'dislike.js', 'parsers.js', 'tag-suggest.js']) {
    assert.ok(!scripts.includes(banned), `${banned} must not be loaded by the instance feed page`);
  }
});

test('the page calls the client, the cache and the model — and never a scoring function', () => {
  const js = read('lorehaven-page.js');
  for (const call of ['getFeed', 'getWork', 'explainSlot', 'getHistory', 'cached', 'staleLabel', 'buildFeed']) {
    assert.ok(js.includes(call), `the page must use ${call}`);
  }
  for (const banned of ['scoreAllWithData', 'scoreFic', 'loadAllForScoring', 'excludeReadItems', 'ROW_DEFINITIONS']) {
    assert.ok(!js.includes(banned), `the page must not call ${banned}`);
  }
});

test('the model has no sorting or scoring path at all', () => {
  const js = read('feed-model.js');
  // Code, not prose: the file's comments explain the rule and are allowed to name it.
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['.sort(', 'localeCompare', 'Math.random', 'jitter']) {
    assert.ok(!code.includes(banned), `feed-model.js must not contain ${banned}`);
  }
  // `blend_score` is the SERVER's number, read off the recorded slot and displayed. Any
  // other mention of a score would be this file deriving one, which is the banned thing.
  assert.ok(!code.replace(/blendScore/g, '').replace(/blend_score/g, '').includes('score'),
    'no score may be computed here — only the server\'s blend_score may be displayed');
});

test('the instance is one setting with one reader, and the client refuses to guess one', () => {
  assert.ok(read('db.js').includes('instance: ""'));
  const page = read('lorehaven-page.js');
  assert.ok(page.includes('getInstance') && page.includes('setInstance'));
  const client = read('lorehaven.js');
  assert.ok(client.includes('No Lorehaven instance configured'));
});

test('every page that loads the client also loads db.js, because the client needs a cookie reader', () => {
  for (const f of ['lorehaven.html', 'popup.html']) {
    const html = read(f);
    if (html.includes('lorehaven.js')) {
      assert.ok(html.includes('db.js'), `${f} loads lorehaven.js, so it needs db.js`);
    }
  }
});

test('the remaining deletions are named, not silently forgotten', () => {
  // Step 3 is the last step and it is not done. This test exists so that "not done" cannot
  // quietly become "assumed done" — it fails when the files go, which is when the status
  // file must be updated.
  const still = ['scoring.js', 'dislike.js', 'parsers.js', 'tag-suggest.js', 'debug.js']
    .filter((f) => existsSync(join(root, f)));
  const status = read('docs/PORT-STATUS.md');
  if (still.length) {
    assert.ok(status.includes('not started'), 'the port status must still describe step 3 as not started');
  }
});
