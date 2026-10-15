// test/lorehaven-client.test.mjs
//
// The client is the only file that calls fetch, so it is the only thing standing between
// the extension and "a client with no tests is how an extension ends up POSTing someone's
// notes to a host it should not". These are behavioural tests against a fetch stub, not
// source-greps: the plan's sketch asserts `src.includes('assertConfiguredOrigin')`, which
// passes just as happily when the call is commented out.
//
//   node --test test/lorehaven-client.test.mjs

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const client = require('../lorehaven.js');

const BASE = 'https://reading.example.org';
let calls;

const realFetch = globalThis.fetch;

function stubFetch({ status = 200, payload = { ok: true } } = {}) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => payload };
  };
}

beforeEach(() => {
  client.setBaseUrl(BASE);
  client.setCookieReader(async () => 'TOKEN');
  stubFetch();
});

test('every request in the surface goes to the configured origin, and no other host is ever contacted (§48.5)', async () => {
  const surface = [
    ['getFeed', []], ['getTasteVector', []], ['getHistory', []], ['getNotes', []],
    ['addNote', ['w1', 'text']], ['deleteNote', ['n1']], ['clearHistory', []],
    ['toggleKudos', ['w1']], ['getDnf', []], ['getStreak', []],
  ];
  for (const [fn, args] of surface) {
    stubFetch();
    await client[fn](...args);
    assert.ok(calls.length >= 1, `${fn} made no request`);
    for (const { url, init } of calls) {
      assert.equal(new URL(url).origin, BASE, `${fn} contacted ${url}`);
      assert.equal(init.credentials, 'include', `${fn} did not send the session cookie`);
    }
  }
});

test('an off-instance TARGET is refused before anything is sent (§48.5)', async () => {
  await assert.rejects(() => client.api('https://evil.example/steal'), /off-instance/);
  await assert.rejects(() => client.api('//evil.example/steal'), /off-instance/);
  assert.equal(calls.length, 0, 'a refused call must not reach the network');
});

test('no instance configured means no request, not a request to somewhere', async () => {
  client.setBaseUrl(null);
  await assert.rejects(() => client.getFeed(), /No Lorehaven instance configured/);
  assert.equal(calls.length, 0);
});

test('writes carry the CSRF header, reads do not (§2)', async () => {
  await client.getHistory();
  assert.equal(calls[0].init.headers['x-csrf-token'], undefined, 'a GET must not carry the token');

  await client.addNote('w1', 'hello');
  assert.equal(calls[1].init.method, 'PUT');
  assert.equal(calls[1].init.headers['x-csrf-token'], 'TOKEN');

  await client.toggleKudos('w1');
  assert.equal(calls[2].init.method, 'POST');
  assert.equal(calls[2].init.headers['x-csrf-token'], 'TOKEN');
});

test('an absent token is omitted, not invented (an operator may have CSRF off)', async () => {
  client.setCookieReader(async () => null);
  await client.addNote('w1', 'hello');
  assert.equal(calls[0].init.headers['x-csrf-token'], undefined);
});

test('the note body is exactly the shape the handler reads (reading.rs:120)', async () => {
  await client.addNote('work-7', 'chapter 3 is the turn');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    subject_type: 'work',
    subject_id: 'work-7',
    body: 'chapter 3 is the turn',
  });
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
});

test('a 204 has no body to parse and must not throw', async () => {
  // The stub must behave like a real 204: `res.json()` on a bodyless response REJECTS.
  // A stub that returns null instead makes "parse it anyway" unobservable, and the
  // mutation that always calls res.json() survives (measured: it did).
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 204, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } };
  };
  const out = await client.deleteNote('n1');
  assert.equal(out, null);
});

test('a failed request says which call failed, not just a status code', async () => {
  stubFetch({ status: 403 });
  await assert.rejects(() => client.getDnf(), /GET \/api\/v1\/me\/dnf -> 403/);
});

test('the two things the server cannot do yet are ABSENT, not stubbed (§48.3, §47)', () => {
  const names = Object.keys(client);
  for (const banned of ['getReasons', 'explain', 'getExplanation', 'logImpression', 'reportImpression']) {
    assert.ok(!names.includes(banned),
      `${banned} exists, but nothing on the server can answer it — a plausible-looking ` +
      'reason or an invented impression is the lie §33.3 forbids');
  }
});
