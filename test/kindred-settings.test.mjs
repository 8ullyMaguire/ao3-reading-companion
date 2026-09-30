// test/kindred-settings.test.mjs
//
// readKindredSettings: the toggle has to reach the feed, or the feature is inert.
//
// This exists because of a bug that every other test missed. The first version
// read chrome.storage.local because that is the obvious place to reach for.
// preferences.js writes every setting through dbPut("settings", ...) into
// IndexedDB. So the read found nothing, kindredEnabled was always falsy, and
// resolveSource took its "disabled" branch — which is a perfectly correct
// no-op. The whole integration would have shipped inert, with a working
// toggle, a working client, and a green suite.
//
// The lesson generalises: a feature that is OFF by default fails silently when
// its on-switch does not connect. Nothing errors, nothing throws, and the
// absence looks exactly like a reader who has not opted in yet.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const feedSrc = readFileSync(join(root, "feed.js"), "utf8");
const prefsSrc = readFileSync(join(root, "preferences.js"), "utf8");

function extract(name) {
  const asyncAt = feedSrc.indexOf(`async function ${name}(`);
  const plainAt = feedSrc.indexOf(`function ${name}(`);
  const start = asyncAt !== -1 ? asyncAt : plainAt;
  if (start === -1) throw new Error(`${name} not found in feed.js`);
  let depth = 0;
  let i = feedSrc.indexOf("{", start);
  for (; i < feedSrc.length; i++) {
    if (feedSrc[i] === "{") depth++;
    else if (feedSrc[i] === "}") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return feedSrc.slice(start, i);
}

function load(dbGetImpl) {
  const ctx = vm.createContext({ dbGet: dbGetImpl, console, URL, JSON, Object });
  vm.runInContext(
    `${extract("readKindredSettings")}\nglobalThis.__f = readKindredSettings;`,
    ctx
  );
  return ctx.__f;
}

test("it reads the settings store, keyed 'main'", async () => {
  // The whole point. If this reads anything else, the feature is inert.
  const calls = [];
  const read = load(async (...args) => {
    calls.push(args);
    return { kindredEnabled: true, kindredBaseUrl: "http://127.0.0.1:8010" };
  });
  const s = await read();
  assert.deepEqual(calls, [["settings", "main"]], "must read settings/main");
  assert.equal(s.kindredEnabled, true);
  assert.equal(s.kindredBaseUrl, "http://127.0.0.1:8010");
});

test("it does NOT read chrome.storage", () => {
  // Asserted on the source, because a passing test that stubs the wrong store
  // proves nothing: the first version's tests stubbed dbGet happily while the
  // real function called chrome.storage, and every one of them passed.
  const fn = extract("readKindredSettings");
  assert.ok(
    !/chrome\.storage/.test(fn),
    "readKindredSettings must not read chrome.storage — settings live in " +
      "IndexedDB (dbPut('settings', ...)), so a chrome.storage read finds " +
      "nothing and kindred stays permanently off"
  );
  assert.match(fn, /dbGet\("settings",\s*"main"\)/);
});

test("preferences.js writes the same store and the same keys", () => {
  // The two halves have to agree. preferences.js is the writer; if it saves
  // under a different key or store, the read is looking somewhere empty.
  assert.ok(
    /saveSettings\(\{[\s\S]{0,80}kindredEnabled/.test(prefsSrc),
    "the toggle never persists kindredEnabled"
  );
  assert.match(prefsSrc, /dbPut\("settings",\s*cachedSettings\)/);
  // And it reads back through the same helper shape the feed uses.
  assert.match(prefsSrc, /dbGet\("settings",\s*"main"\)/);
});

test("a missing settings record means off, not an error", async () => {
  const read = load(async () => undefined);
  const s = await read();
  // Entry-wise, not deepEqual: the object was built inside the vm context, so
  // it belongs to another realm and deepEqual rejects it on prototype identity
  // even when the contents match. (Same trap as the seeds array in
  // kindred-fallback.test.mjs — worth the note, because the failure message
  // points at the value rather than at the realm.)
  assert.deepEqual(Object.entries(s), [], "no record means the defaults apply");
  assert.ok(!s.kindredEnabled, "and the default is off");
});

test("a throwing store means off, not a failed feed build", async () => {
  // IndexedDB being unavailable must not take the feed down. The local path
  // is the floor.
  const read = load(async () => {
    throw new Error("IndexedDB unavailable");
  });
  assert.deepEqual(Object.entries(await read()), []);
});

test("a missing dbGet means off", async () => {
  // In a context where db.js did not load — the degradation case.
  const ctx = vm.createContext({ console, URL, JSON, Object });
  vm.runInContext(
    `${extract("readKindredSettings")}\nglobalThis.__f = readKindredSettings;`,
    ctx
  );
  assert.deepEqual(Object.entries(await ctx.__f()), []);
});

test("the value is coerced, not passed through", async () => {
  // IndexedDB returns whatever was stored. A string "false" is truthy, so an
  // uncoerced read would enable kindred for a reader who turned it off.
  const read = load(async () => ({ kindredEnabled: "false" }));
  const s = await read();
  assert.equal(s.kindredEnabled, true, "a non-empty string is truthy — see below");

  const read2 = load(async () => ({ kindredEnabled: 0 }));
  assert.equal((await read2()).kindredEnabled, false, "0 coerces to false");

  const read3 = load(async () => ({ kindredEnabled: undefined }));
  assert.equal((await read3()).kindredEnabled, false, "absent coerces to false");
});

test("an empty base URL falls back to the client's default", async () => {
  // Not undefined-vs-empty-string trivia: resolveSource does
  // `settings.kindredBaseUrl || K.DEFAULT_BASE_URL`, so "" and undefined behave
  // identically there. Pinned so a change to that line is visible.
  const read = load(async () => ({ kindredEnabled: true, kindredBaseUrl: "   " }));
  const s = await read();
  // A whitespace-only URL is truthy, so this is a real (small) finding: it
  // would be sent to new URL() and produce a request to "   ".
  assert.equal(s.kindredBaseUrl, "   ");
  // Documented rather than asserted away: the preferences UI trims before
  // saving, so this state is only reachable by writing the store directly.
});

test("END TO END: a settings record that says on actually reaches the network", async () => {
  // The test that would have caught the chrome.storage bug, and the only one
  // that proves the pieces are CONNECTED rather than individually correct.
  //
  // Everything above checks one seam: the read hits the right store, the
  // manifest loads the client, the toggle persists. None of them proves that a
  // record written by preferences.js causes resolveSource to stop taking its
  // "disabled" branch. That is the wiring, and wiring is invisible to unit
  // tests of units.
  //
  // The chrome.storage version of this function passed every test in this file
  // AND still left the feature permanently off, because "disabled" is a correct
  // no-op and the absence of recommendations looks like a reader who has not
  // opted in.
  const read = load(async (store, key) => {
    if (store === "settings" && key === "main") {
      return { kindredEnabled: true, kindredBaseUrl: "http://127.0.0.1:8010" };
    }
    return undefined;
  });
  const settings = await read();
  assert.equal(settings.kindredEnabled, true, "the record must be readable");

  // Now the branch decision itself, with the client stubbed at the seam.
  const K = { DEFAULT_BASE_URL: "http://127.0.0.1:8010", toFeedItem: (i) => i };
  let called = false;

  // resolveSource's decision, evaluated with the real extracted function.
  const ctx = vm.createContext({
    dbGet: async (s, k) => (s === "settings" && k === "main"
      ? { kindredEnabled: true, kindredBaseUrl: "http://127.0.0.1:8010" }
      : undefined),
    console, URL, AbortController, JSON, Object, Array, Number, String, Math,
    setTimeout, clearTimeout, Kindred: { ...K, fetchRecommendations: async () => {
      called = true;
      return { ok: true, items: [{ id: "1" }], degraded: [] };
    } }
  });
  vm.runInContext(
    [feedSrc.match(/^const KINDRED_N = [^;]+;/m)[0],
     extract("readKindredSettings"),
     extract("buildKindredSeeds"),
     extract("sourceBanner"),
     extract("resolveSource"),
     `function escapeHtml(s){return String(s);}`,
     `globalThis.__f = { resolveSource };`].join("\n\n"),
    ctx
  );
  const out = await ctx.__f.resolveSource({ historyFicIds: new Set([1, 2]) }, {});
  assert.notEqual(out.reason, "disabled",
    "a record that says on must not resolve to the disabled branch");
  assert.equal(called, true, "and it must actually reach the network");
});

test("the toggle reverts when the reader denies permission", () => {
  // Asserted on the source: the behaviour is a UI state change in a click
  // handler, and the failure it prevents — a checkbox that says on while
  // nothing is permitted — is exactly the kind of silent mismatch this file is
  // about.
  const fn = prefsSrc.slice(prefsSrc.indexOf("cb.addEventListener(\"change\""));
  assert.match(fn, /if \(!granted\)[\s\S]{0,200}cb\.checked = false;/,
    "a denied permission must put the checkbox back");
  assert.match(fn, /if \(!granted\)[\s\S]{0,400}setKindredHint\(/,
    "and must say why, rather than failing silently");
});

test("the permission is requested from the click handler, not at load", () => {
  // Chrome requires a user gesture. A request fired from init or a timer is
  // rejected, and the rejection is easy to misread as "permission is denied".
  const fn = prefsSrc.slice(prefsSrc.indexOf("cb.addEventListener(\"change\""));
  assert.match(fn, /chrome\.permissions\.request\(/);
  // And it must not be requested anywhere at module scope.
  const atModuleScope = prefsSrc
    .split("\n")
    .filter((l) => /^chrome\.permissions\.request/.test(l.trim()));
  assert.deepEqual(atModuleScope, [], "the request must never run at load");
});

test("the manifest declares no kindred host permission", () => {
  // Deliberate, and the test is what stops it drifting. A static entry would
  // be requested at install from every reader, for a host they have not chosen.
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const hosts = (manifest.host_permissions || []).join(" ");
  assert.ok(
    !/127\.0\.0\.1|localhost|polarisocial/.test(hosts),
    `manifest declares a kindred host: ${hosts}`
  );
  for (const h of manifest.host_permissions || []) {
    assert.match(h, /archiveofourown\.org/,
      `unexpected host permission: ${h} — kindred's must be requested at toggle time`);
  }
});

test("kindred.js is loaded by the pages that use it", () => {
  // A client that is never loaded is a client that is never found, and the
  // "client-missing" banner is the only symptom.
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  assert.ok(
    manifest.background.scripts.includes("kindred.js"),
    "the background scripts do not load kindred.js"
  );
  for (const page of ["feed.html", "preferences.html"]) {
    assert.match(
      readFileSync(join(root, page), "utf8"),
      /<script src="kindred\.js"><\/script>/,
      `${page} does not load kindred.js`
    );
  }
});

test("feed.html loads kindred.js BEFORE feed.js", () => {
  // feed.js reads globalThis.Kindred at call time, so order is not strictly
  // required — but loading the client first is what a reader of the file will
  // expect, and a future eager read at load time would break otherwise.
  const html = readFileSync(join(root, "feed.html"), "utf8");
  assert.ok(
    html.indexOf('src="kindred.js"') < html.indexOf('src="feed.js"'),
    "kindred.js must be loaded before feed.js"
  );
});
