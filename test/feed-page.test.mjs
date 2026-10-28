import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

// The page, driven for real: the four classic scripts share one global scope in a browser,
// so they share one context here. What is stubbed is only the edges — `browser.storage`,
// `fetch`, the DOM, and the two settings accessors that live in db.js; everything the port
// actually reasons with (the client, the cache, the model, the page) is the shipped file.
//
// This is not a browser: it cannot prove the extension LOADS. It proves what the page does
// with an answer, including the answers that are absences, which is the part a reader would
// otherwise discover by seeing something invented.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeElement(id, registry) {
  const el = {
    id, hidden: true, textContent: '', value: '',
    classes: new Set(),
    classList: {
      toggle(name, on) { on ? this._el.classes.add(name) : this._el.classes.delete(name); },
      add(name) { this._el.classes.add(name); },
      contains(name) { return this._el.classes.has(name); },
      _el: null,
    },
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
  };
  // A real DOM creates the elements an innerHTML write contains, and a test that skipped
  // that would "pass" because the page's own wiring threw on a null. Discover them.
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set: (value) => {
      html = String(value);
      for (const m of html.matchAll(/id="([^"]+)"/g)) {
        if (!registry[m[1]]) { registry[m[1]] = makeElement(m[1], registry); registry[m[1]].hidden = false; }
      }
      for (const m of html.matchAll(/id="([^"]+)"[^>]*value="([^"]*)"/g)) {
        if (registry[m[1]]) registry[m[1]].value = m[2];
      }
    },
  });
  return el;
}

async function boot({ instance = '', routes, storage = {} } = {}) {
  const ids = ['instance-line', 'feed-meta', 'cards', 'error-text', 'refresh', 'change-instance',
    'state-setup', 'state-loading', 'state-error', 'feed-main'];
  const elements = {};
  for (const id of ids) { elements[id] = makeElement(id, elements); elements[id].classList._el = elements[id]; }

  const store = { ...storage };
  const requested = [];
  const docListeners = {};
  const document = {
    getElementById: (id) => elements[id] ?? null,
    addEventListener: (type, fn) => { (docListeners[type] ||= []).push(fn); },
  };
  const browser = {
    storage: {
      local: {
        get: async (key) => (key === null ? { ...store } : { [key]: store[key] }),
        set: async (obj) => { Object.assign(store, obj); },
        remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k]; },
      },
    },
    runtime: { getURL: (p) => `moz-extension://x/${p}` },
    tabs: { create: () => {} },
  };

  let base = instance;
  const context = vm.createContext({
    browser, document, console,
    getInstance: async () => base,
    setInstance: async (v) => { base = v; return v; },
    URL, Date, JSON, Object, Array, String, Number, Math, Promise, RegExp, Error, Set, Map,
    setTimeout, __requested: requested, __routes: routes,
    fetch: async (url, init) => {
      requested.push(String(url));
      const route = routes.find((r) => (r.match instanceof RegExp ? r.match.test(String(url)) : String(url).includes(r.match)));
      if (!route) return { ok: false, status: 404, json: async () => ({ error: 'no stub for ' + url }) };
      if (route.status && route.status !== 200) return { ok: false, status: route.status, json: async () => route.body };
      return { ok: true, status: 200, json: async () => route.body };
    },
  });

  for (const f of ['darkhold.js', 'cache.js', 'feed-model.js', 'feed-page.js']) {
    vm.runInContext(readFileSync(join(root, f), 'utf8'), context, { filename: f });
  }
  for (const fn of (docListeners.DOMContentLoaded || [])) await fn();
  return { elements, requested, store, context };
}

const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const work = (id, over = {}) => ({
  id, title: `Work ${id}`, summary: `summary ${id}`, language: 'en', rating: 'teen',
  visibility: 'public', completion: 'complete', published_at: '2026-01-01T00:00:00Z',
  show_public_ratings: true, discussion_mode: 'both', rating_summary: null,
  metrics: { views: 5, complete_reads: 1, reactions: 0, kudos: 3, bookmarks: 1, collection_adds: 0, reviews: 0 },
  authors: [{ handle: `author-${id}` }], chapters: [{ word_count: 900 }], rec_blurb: null, ...over,
});
const slot = (id, extra = {}) => ({ slot_id: id, work_id: id, position: 0, reasons: [{ kind: 'taste', text: 'because you read slow burns' }], blend_score: 900, served_at: '2026-10-15T21:00:00Z', ...extra });
const routesFor = (ids) => ([
  // Anchored, or the slot route below would also match the collection route.
  { match: /\/api\/v1\/discovery(\?|$)/, body: { items: ids.map((id) => ({ work_id: id, slot_id: `slot-${id}` })), sort: 'for_you', request_id: 'r1' } },
  ...ids.map((id) => ({ match: `/api/v1/works/${id}`, body: work(id) })),
  ...ids.map((id) => ({ match: `/api/v1/discovery/slots/slot-${id}/explanation`, body: slot(id) })),
  { match: '/api/v1/library/history', body: { items: [{ work_id: ids[0] }] } },
]);

test('with no instance the page asks for one and sends nothing anywhere (§48.5)', async () => {
  const { elements, requested } = await boot({ instance: '' });
  await settle();
  assert.equal(elements['state-setup'].hidden, false);
  assert.match(elements['state-setup'].innerHTML, /Darkhold instance/);
  assert.equal(elements['feed-main'].hidden, true);
  assert.deepEqual(requested, [], 'an unconfigured client must not guess a host');
  assert.match(elements['instance-line'].textContent, /no instance configured/);
});

test('a configured instance renders the server order, never a local one', async () => {
  const { elements } = await boot({ instance: 'https://lh.example', routes: routesFor(['a', 'b']) });
  await settle();
  assert.equal(elements['feed-main'].hidden, false);
  const html = elements['cards'].innerHTML;
  assert.ok(html.indexOf('Work a') < html.indexOf('Work b'), 'the server order stands');
  assert.match(html, /because you read slow burns/, 'the recorded reason is shown');
  assert.match(html, /blend score 900/);
  assert.match(elements['feed-meta'].textContent, /sort: for_you/);
  assert.match(elements['feed-meta'].textContent, /2 recommendations/);
});

test('the work the server says was read is marked read, and the other is not', async () => {
  const { elements } = await boot({ instance: 'https://lh.example', routes: routesFor(['a', 'b']) });
  await settle();
  const cards = elements['cards'].innerHTML.split('</article>');
  assert.match(cards[0], /badge">read</, 'the first work is in the history');
  assert.ok(!cards[1].includes('badge">read<'), 'the second is not');
});
test('a work whose details fail keeps its place and says so', async () => {
  const routes = routesFor(['a', 'b']).filter((r) => !String(r.match).includes('works/b'));
  const { elements } = await boot({ instance: 'https://lh.example', routes });
  await settle();
  const html = elements['cards'].innerHTML;
  assert.match(html, /Details unavailable/);
  // b is second in the server's order and its details failed: it stays second, and its
  // absence is stated. A client that dropped it, or moved it to the end, would be re-ranking.
  assert.ok(html.indexOf('Work a') < html.indexOf('Details unavailable'), 'the failed card keeps its position');
  assert.match(elements['feed-meta'].textContent, /2 recommendations/);
});

test('a slot whose explanation cannot be read is an absence, not a plausible story', async () => {
  const routes = routesFor(['a']).filter((r) => !String(r.match).includes('explanation'));
  const { elements } = await boot({ instance: 'https://lh.example', routes });
  await settle();
  assert.match(elements['cards'].innerHTML, /Not available/);
  assert.ok(!/because/i.test(elements['cards'].innerHTML), 'no reason text is invented');
});

test('a failed feed is an error state with the message, and no cards', async () => {
  const { elements } = await boot({ instance: 'https://lh.example', routes: [{ match: /\/api\/v1\/discovery(\?|$)/, status: 500, body: { error: 'boom' } }] });
  await settle();
  assert.equal(elements['state-error'].hidden, false);
  assert.match(elements['error-text'].textContent, /boom|500/);
  assert.equal(elements['feed-main'].hidden, true);
});

test('a stale copy is served labelled with the age it was fetched (§48.5)', async () => {
  const routes = routesFor(['a']);
  const first = await boot({ instance: 'https://lh.example', routes });
  await settle();
  assert.ok(first.store['lh:feed'], 'the feed was cached');
  // Now the instance fails: the previous copy is served, labelled.
  const { elements } = await boot({
    instance: 'https://lh.example',
    routes: [{ match: /\/api\/v1\/discovery(\?|$)/, status: 503, body: { error: 'down' } }],
    storage: { 'lh:feed': { data: routesFor(['a'])[0].body, at: Date.now() - 61 * 60 * 1000 } },
  });
  await settle();
  assert.equal(elements['feed-main'].hidden, false, 'the previous copy is still shown');
  assert.match(elements['feed-meta'].textContent, /cached 1 h ago/, 'the age it was fetched is stated');
  assert.ok(elements['feed-meta'].classes.has('stale'));
});

test('every request goes to the configured origin, and only to it', async () => {
  const { requested } = await boot({ instance: 'https://lh.example', routes: routesFor(['a']) });
  await settle();
  assert.ok(requested.length >= 3, `expected the feed, the work and the slot (got ${requested.length})`);
  for (const url of requested) assert.ok(url.startsWith('https://lh.example/'), url);
});

test("changing the instance offers the form again, whatever is cached", async () => {
  const { elements, store } = await boot({
    instance: 'https://lh.example', routes: routesFor(['a']),
    storage: { 'lh:feed': { data: { items: [{ work_id: 'old' }] }, at: Date.now() - 61 * 60 * 1000 } },
  });
  await settle();
  elements['change-instance'].listeners.click[0]();
  await settle();
  assert.match(elements['state-setup'].innerHTML, /Darkhold instance/);
  assert.equal(elements['state-setup'].hidden, false);
});
