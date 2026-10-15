import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');
const htmlFiles = () => readdirSync(root).filter((f) => f.endsWith('.html'));

// The modules §48 deletes. If one comes back, it comes back with a reason — a test that only
// checked "the new page does not load it" would let the brain return on a different page.
const DELETED = ['scoring.js', 'dislike.js', 'parsers.js', 'tag-suggest.js', 'content.js',
  'debug.js', 'debug.html', 'feed.js', 'preferences.js', 'preferences.html',
  'myreading.js', 'myreading.html', 'onboarding.js', 'onboarding.html'];

test('the modules §48 deletes are gone, and nothing still references them', () => {
  for (const f of DELETED) {
    assert.ok(!existsSync(join(root, f)), `${f} should have been deleted`);
  }
  for (const file of [...htmlFiles(), 'manifest.json', 'background.js', 'db.js', 'popup.js',
    'feed-page.js', 'feed-model.js', 'lorehaven.js', 'cache.js']) {
    const body = read(file);
    for (const gone of DELETED) {
      assert.ok(!body.includes(gone), `${file} still references ${gone}`);
    }
  }
});

test('every script the manifest and the pages load exists — no dangling reference can ship', () => {
  const named = [];
  const manifest = JSON.parse(read('manifest.json'));
  named.push(...(manifest.background?.scripts || []));
  for (const f of htmlFiles()) {
    named.push(...[...read(f).matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]));
    named.push(...[...read(f).matchAll(/href="([^"]+\.css)"/g)].map((m) => m[1]));
  }
  assert.ok(named.length > 5, 'the scan found the wiring');
  for (const n of named) assert.ok(existsSync(join(root, n)), `${n} is referenced but not on disk`);
});

test('the feed page loads exactly the modules the port needs, and no ranker', () => {
  const scripts = [...read('feed.html').matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['db.js', 'lorehaven.js', 'cache.js', 'feed-model.js', 'feed-page.js']);
});

test('the page asks the client, the cache and the model — and never a scoring function', () => {
  const js = read('feed-page.js');
  for (const call of ['getFeed', 'getWork', 'explainSlot', 'getHistory', 'cached', 'staleLabel', 'buildFeed']) {
    assert.ok(js.includes(call), `the page must use ${call}`);
  }
  for (const banned of ['scoreAllWithData', 'scoreFic', 'loadAllForScoring', 'excludeReadItems', 'ROW_DEFINITIONS']) {
    assert.ok(!js.includes(banned), `the page must not call ${banned}`);
  }
});

test('the model has no sorting or scoring path at all', () => {
  const js = read('feed-model.js');
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['.sort(', 'localeCompare', 'Math.random', 'jitter']) {
    assert.ok(!code.includes(banned), `feed-model.js must not contain ${banned}`);
  }
  // `blend_score` is the SERVER's number, read off the recorded slot and displayed. Any other
  // mention of a score would be this file deriving one, which is the banned thing.
  assert.ok(!code.replace(/blendScore/g, '').replace(/blend_score/g, '').includes('score'),
    "no score may be computed here — only the server's blend_score may be displayed");
});

test('the instance is one setting with one reader, and the client refuses to guess one', () => {
  assert.ok(read('db.js').includes('instance: ""'));
  const page = read('feed-page.js');
  assert.ok(page.includes('getInstance') && page.includes('setInstance'));
  assert.ok(read('lorehaven.js').includes('No Lorehaven instance configured'));
  // Old stores are left alone rather than deleted, and settings is the only store declared.
  assert.ok(read('db.js').includes('SETTINGS: "settings"'));
  assert.ok(!read('db.js').includes('DISLIKE_HISTORY'));
});

test('the popup shows the instance at all times, never behind a settings page (§48.5)', () => {
  assert.ok(read('popup.html').includes('id="instance-value"'));
  assert.ok(read('popup.js').includes('instanceValue'));
  assert.ok(read('popup.js').includes('instance || \'not configured\''));
});

test('the port status says the port is finished, so "not done" cannot quietly become "done"', () => {
  const status = read('docs/PORT-STATUS.md');
  assert.ok(status.includes('complete'), 'the status file must record the port as complete');
  assert.ok(!status.includes('not started'), 'no step may still be described as not started');
});

test('the background context carries no scraping, and needs no network of its own', () => {
  // Code only: this file's comments explain what was removed and are allowed to name it.
  const bg = read('background.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['archiveofourown', 'fetch(', 'alarms', 'parsers', 'scoring']) {
    assert.ok(!bg.includes(banned), `background.js must not contain ${banned}`);
  }
  assert.ok(bg.includes('ensureDefaultSettings'));
});
