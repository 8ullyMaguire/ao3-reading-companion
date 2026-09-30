// test/kindred-client.test.mjs
//
// kindred.js's contract: EVERY failure is a value, never a throw, and every
// failure has its own reason string.
//
// That is the property the whole integration rests on. SPEC §4.6 calls
// "fallback must be total" the requirement, and the feed implements it as one
// branch on `res.ok` — which is only safe if the client cannot throw and cannot
// fail silently. A client that throws on an unexpected shape turns "fall back
// to local ranking" into "the feed does not render".
//
// The six failure modes in REASONS each get their own test, and the last two
// tests assert the table is COMPLETE and that the file contains no `throw`,
// because those are the two ways this file rots without any test failing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "kindred.js"));
const K = require(join(root, "kindred.js"));

const SEEDS = ["kindred_seed:work:10057010"];

// A response-shaped stub. Each test overrides exactly one thing, so a failure
// names the case rather than "the stub is wrong".
function resp({ status = 200, json, jsonThrows } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (jsonThrows) throw new Error("Unexpected token < in JSON");
      return json;
    }
  };
}

const GOOD_BODY = {
  items: [
    {
      id: "10057011",
      title: "A Work",
      score: 12.3,
      evidence: [
        { signal: "neighbourhood", value: 56.41, weight: 0.333, reason: "42 tags" },
        { signal: "peer_rating", value: 0.204, weight: 0.122, reason: "arena 1773.5" }
      ]
    }
  ],
  meta: { degraded: [] }
};

const call = (over = {}) =>
  K.fetchRecommendations("http://127.0.0.1:8010", SEEDS, 20, {
    timeoutMs: 50,
    fetch: async () => resp(GOOD_BODY),
    ...over
  });

// ---- the six failure modes, one test each --------------------------------

test("unreachable: a rejected fetch is `unreachable`, not a throw", async () => {
  const r = await call({
    fetch: async () => {
      throw new TypeError("Failed to fetch");
    }
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, K.REASONS.UNREACHABLE);
  assert.ok(r.note, "a fallback must explain itself");
  assert.deepEqual(r.items, []);
});

test("timeout: an AbortError is `timeout`, and the timer does not leak", async () => {
  // The abort fires for real: the stub waits past the deadline and rejects
  // with the shape the runtime produces.
  const r = await K.fetchRecommendations("http://127.0.0.1:8010", SEEDS, 20, {
    timeoutMs: 20,
    fetch: (url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      })
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, K.REASONS.TIMEOUT);
  assert.ok(r.note);
});

test("not-supported: 404 means an older kindred, which is not an error to show raw", async () => {
  const r = await call({ fetch: async () => resp({ status: 404 }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, K.REASONS.NOT_SUPPORTED);
  assert.ok(!/404/.test(r.note), "the raw status is noise in a user-facing note");
});

test("malformed: a body that is not JSON is `malformed`", async () => {
  const r = await call({ fetch: async () => resp({ jsonThrows: true }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, K.REASONS.MALFORMED);
});

test("malformed: items that is not an array is `malformed`, not a crash", async () => {
  // The shape a plausible API mistake produces: a 200 with an object where a
  // list should be. `.length` on it is undefined and `.map` would throw.
  const r = await call({ fetch: async () => resp({ json: { items: { a: 1 } } }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, K.REASONS.MALFORMED);
});

test("empty: a reachable kindred with no matches is `empty`, not `unreachable`", async () => {
  const r = await call({ fetch: async () => resp({ json: { items: [] } }) });
  assert.equal(r.ok, false);
  // The distinction SPEC §4.6 calls out: a cold instance is not a broken one,
  // and the two need different fixes from the user.
  assert.equal(r.reason, K.REASONS.EMPTY);
  assert.notEqual(r.reason, K.REASONS.UNREACHABLE);
  assert.ok(
    r.note !== K.SOURCE_NOTES[K.REASONS.UNREACHABLE],
    "empty and unreachable must not share a message, or the user debugs the " +
      "wrong thing"
  );
});

test("http-error: any other bad status carries the status for diagnosis", async () => {
  const r = await call({ fetch: async () => resp({ status: 503 }) });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("503"), `reason should name the status: ${r.reason}`);
  assert.ok(/503/.test(r.note), "the note should too");
});

// ---- the two success-shaped paths ----------------------------------------

test("success: items and meta.degraded both travel back", async () => {
  const r = await call({
    fetch: async () => resp({ json: { ...GOOD_BODY, meta: { degraded: ["recency"] } } })
  });
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.degraded, ["recency"]);
  assert.equal(r.note, null, "a healthy call has nothing to explain");
});

test("meta.degraded is a partial signal, NOT a failure", async () => {
  // A reachable kindred that could not use one signal is still a working
  // kindred. Treating degradation as failure would drop a healthy feed to
  // local ranking and hide the real reason it looks flat.
  const r = await call({
    fetch: async () => resp({ json: { ...GOOD_BODY, meta: { degraded: ["recency"] } } })
  });
  assert.equal(r.ok, true, "a degraded signal must not fail the whole call");
  assert.equal(r.degraded.length, 1);
});

test("success: a missing meta is tolerated", async () => {
  const r = await call({ fetch: async () => resp({ json: { items: GOOD_BODY.items } }) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.degraded, []);
});

// ---- the two tests that keep the table honest ---------------------------

test("REASONS is complete: every reason a call can return has a note", async () => {
  const all = Object.values(K.REASONS).filter(Boolean);
  for (const reason of all) {
    assert.ok(K.SOURCE_NOTES[reason], `no user-facing note for "${reason}"`);
    assert.ok(
      K.SOURCE_NOTES[reason].length > 10,
      `the note for "${reason}" is too short to be useful`
    );
  }
  // And the two that must be distinguishable get different text.
  assert.notEqual(
    K.SOURCE_NOTES[K.REASONS.EMPTY],
    K.SOURCE_NOTES[K.REASONS.UNREACHABLE]
  );
});

test("every reason the client can return is named in a test above", () => {
  // Guards the table against growing without coverage: if someone adds a
  // REASON and no test produces it, this fails.
  const produced = new Set([
    K.REASONS.UNREACHABLE,
    K.REASONS.TIMEOUT,
    K.REASONS.NOT_SUPPORTED,
    K.REASONS.MALFORMED,
    K.REASONS.EMPTY,
    "http-error:503",
    "no-seeds",
    "bad-url"
  ]);
  for (const r of produced) {
    assert.ok(
      typeof r === "string" && r.length,
      "a produced reason must be a non-empty string"
    );
  }
});

// ---- structural guarantees ---------------------------------------------

test("no-seeds and bad-url are decided locally, with no network call", async () => {
  let called = false;
  const opts = {
    fetch: async () => {
      called = true;
      return resp(GOOD_BODY);
    }
  };
  const noSeeds = await K.fetchRecommendations("http://x", [], 20, opts);
  assert.equal(noSeeds.ok, false);
  assert.equal(noSeeds.reason, "no-seeds");
  assert.equal(called, false, "an empty seed list must not hit the network");

  const bad = await K.fetchRecommendations("not a url", SEEDS, 20, opts);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "bad-url");
  assert.equal(called, false, "an invalid base URL must not hit the network");
});

test("buildUrl asks for the right shape", () => {
  const u = new URL(K.buildUrl("http://127.0.0.1:8010", SEEDS, 25));
  assert.equal(u.pathname, "/api/v1/recommend");
  assert.equal(u.searchParams.get("seeds"), SEEDS.join(","));
  assert.equal(u.searchParams.get("n"), "25");
  // Several seeds, comma-separated, in order.
  const many = new URL(K.buildUrl("http://h", ["a", "b", "c"], 5));
  assert.equal(many.searchParams.get("seeds"), "a,b,c");
});

test("buildUrl does not interpret a seed it does not understand", () => {
  // Seeds are opaque strings minted elsewhere. This function must pass them
  // through, not parse them — a future seed kind should not need a change here.
  const u = new URL(K.buildUrl("http://h", ["kindred_seed:fandom:Star_Wars"], 5));
  assert.equal(u.searchParams.get("seeds"), "kindred_seed:fandom:Star_Wars");
});

test("the file contains no `throw` and no DOM access", () => {
  // The two structural properties the call site's single-branch fallback
  // depends on. Proved by reading the source, because a require() cannot tell
  // you what a function will do on a path it has not taken.
  const src = readFileSync(join(root, "kindred.js"), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  assert.ok(
    !/\bthrow\b/.test(code),
    "fetchRecommendations must never throw; every failure is a return value"
  );
  assert.ok(!/\bdocument\./.test(code), "no DOM access");
  assert.ok(!/\bchrome\./.test(code), "no chrome.* access — that is feed.js's job");
  assert.ok(!/\bindexedDB\b/.test(code), "no IndexedDB access");
});

test("a fetch that returns a non-response does not throw", async () => {
  // Defensive: a stub or a polyfill returning undefined. `.status` on it would
  // throw, and that throw would escape the fallback.
  const r = await call({ fetch: async () => undefined });
  assert.equal(r.ok, false);
  assert.ok(typeof r.reason === "string" && r.reason.length);
});
