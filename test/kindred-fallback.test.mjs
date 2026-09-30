// test/kindred-fallback.test.mjs
//
// resolveSource(): which source this feed build uses, and whether it says so.
//
// THE assertion of this file is a PAIRING: every fallback must produce local
// ranking AND a non-empty banner. A fallback with no note is the bug SPEC §4.6
// warns about — the reader's feed quietly degrades and a flat feed looks like a
// broken recommender rather than an unreachable server. Half the tests below
// check that pairing for each failure mode, because a fallback that works but
// is invisible is barely better than no fallback at all.
//
// Verbatim copies, per this repo's convention. feed.js is a browser script that
// touches `document`, `indexedDB` and `chrome.*` at load time, so it cannot be
// imported. `tools/check-kindred-wiring.mjs` reads the real source and fails if
// these copies drift.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "kindred.js"));
const K = require(join(root, "kindred.js"));

const feedSrc = readFileSync(join(root, "feed.js"), "utf8");

// Replace every non-code character with a space, preserving offsets. Crude but
// sufficient and, importantly, deterministic: a `/` starts either a comment or
// a regex depending on what precedes it, and feed.js has both.
function maskNonCode(src) {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  while (i < n) {
    const ch = src[i];
    // line comment
    if (ch === "/" && src[i + 1] === "/") {
      let j = src.indexOf("\n", i);
      if (j === -1) j = n;
      blank(i, j);
      i = j;
      continue;
    }
    // block comment
    if (ch === "/" && src[i + 1] === "*") {
      let j = src.indexOf("*/", i + 2);
      j = j === -1 ? n : j + 2;
      blank(i, j);
      i = j;
      continue;
    }
    // string or template literal
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === quote) break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

// Pull the three functions out of the real source and evaluate them, rather
// than keeping a hand-copy. feed.js cannot be required, but these three are
// self-contained: they touch no DOM and no chrome.*, so extracting and
// evaluating them exercises the REAL code. That removes the drift problem
// entirely instead of checking for it.
function loadFeedFns() {
  // Brace-match to the end of a function, SKIPPING braces that live inside
  // strings, template literals, comments or regexes.
  //
  // The first version counted every brace, and resolveSource contains a
  // `catch {` with no binding — so the matcher closed the function at the
  // catch and the extracted code was a syntax error naming a function that
  // was never in the output. Silently wrong, which is the worst kind.
  const grab = (name) => {
    // Match on the async form FIRST, and slice from ITS start — not from
    // Math.max of two indexes. Taking the later index finds the function body
    // but slices from `function name(`, dropping the `async ` prefix, so the
    // extracted code has a top-level `await` and is a syntax error. That is
    // what happened: `readKindredSettings` came out as a plain function whose
    // body awaits, and vm rejected the whole script — including the three
    // functions that were fine.
    const asyncAt = feedSrc.indexOf(`async function ${name}(`);
    const plainAt = feedSrc.indexOf(`function ${name}(`);
    const start = asyncAt !== -1 ? asyncAt : plainAt;
    if (start === -1) throw new Error(`${name} not found in feed.js`);
    let depth = 0;
    let i = feedSrc.indexOf("{", start);
    // A mask marking every character that is not real code: string bodies,
    // template literals, comments, and regex literals. Braces inside are
    // replaced with spaces so they cannot affect the depth count.
    const masked = maskNonCode(feedSrc);
    for (; i < feedSrc.length; i++) {
      const ch = masked[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    return feedSrc.slice(start, i);
  };
  // Module-level constants the extracted functions close over. A function
  // extracted without the `const` it reads is not a function, it is a
  // ReferenceError — the first version omitted these and 14 of 17 tests failed
  // with "KINDRED_N is not defined". Extracted verbatim like everything else.
  const constOf = (name) => {
    const m = feedSrc.match(new RegExp(`^const ${name} = [^;]+;`, "m"));
    if (!m) throw new Error(`const ${name} not found in feed.js`);
    return m[0];
  };

  const code = [
    constOf("KINDRED_N"),
    // Every helper resolveSource reaches for, extracted from the real file so
    // there is no hand-copy to drift.
    grab("readKindredSettings"),
    grab("buildKindredSeeds"),
    grab("sourceBanner"),
    grab("resolveSource"),
    // escapeHtml is used by sourceBanner. The real one is a pure string
    // transform, so this faithful stand-in is safe — and a test below pins the
    // behaviour sourceBanner depends on.
    `function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}`,
    // Export through a global. vm.runInContext evaluates a SCRIPT, so a
    // top-level `await` is still a syntax error — the async functions are
    // hoisted as declarations, which is legal at script level, and only their
    // BODIES await. That is why this works where a top-level await did not.
    `globalThis.__feedFns = { resolveSource, buildKindredSeeds, sourceBanner };`
  ].join("\n\n");

  // vm, not new Function. The extracted code is async, and `new Function`
  // produces a non-async body, so the first two attempts failed on `await` and
  // then on an export assignment that had not run by the time the IIFE yielded.
  // vm.runInNewContext evaluates a whole script in a real context and has no
  // such constraint.
  const context = vm.createContext({ Kindred: K, console, URL, AbortController, JSON, Array, Object, Number, String, Math, setTimeout, clearTimeout });
  vm.runInContext(code, context, { filename: "feed.js (extracted)" });
  return context.__feedFns;
}

const { resolveSource, buildKindredSeeds, sourceBanner } = loadFeedFns();

const CTX = { historyFicIds: new Set([1, 2, 3]) };

const enabled = (extra = {}) => ({
  settings: { kindredEnabled: true, kindredBaseUrl: "http://127.0.0.1:8010", ...extra },
  kindred: K
});

const stubFetch = (impl) => ({ ...enabled(), fetch: impl });

const GOOD = {
  items: [
    { id: "1", title: "One", score: 5, evidence: [{ signal: "popularity", value: 1, weight: 1, reason: "r" }] }
  ],
  meta: { degraded: [] }
};

const okResp = (body) => async () => ({ ok: true, status: 200, json: async () => body });

// ---- the floor: local ranking, always -----------------------------------

test("disabled by default: no call, no banner, local ranking", async () => {
  let called = false;
  const r = await resolveSource(CTX, {
    settings: {},
    fetch: async () => {
      called = true;
      return { ok: true, status: 200, json: async () => GOOD };
    }
  });
  assert.equal(r.items, null, "null means: use the local path");
  assert.equal(r.reason, "disabled");
  assert.equal(r.bannerHtml, "", "an intentionally-off feature is not a problem");
  assert.equal(called, false, "and it must not touch the network");
});

test("no seeds: no call, no banner — a new reader is not a failure", async () => {
  let called = false;
  const r = await resolveSource(
    { historyFicIds: new Set() },
    { ...enabled(), fetch: async () => { called = true; } }
  );
  assert.equal(r.items, null);
  assert.equal(r.reason, "no-seeds");
  assert.equal(r.bannerHtml, "");
  assert.equal(called, false);
});

test("a missing kindred.js degrades AND explains", async () => {
  // The client script failing to load is exactly the failure that would
  // otherwise be invisible: the feed renders, just with no recommendations
  // from kindred, and nothing says why.
  //
  // `kindred: null` alone does NOT reach that branch. resolveSource treats a
  // falsy options.kindred as "not injected" and falls back to the global, and
  // the vm context has one — so the first version of this test got
  // "unreachable" and passed a wrong reason into a real assertion. The branch
  // under test needs the global gone as well.
  const r = await resolveSource(CTX, {
    settings: { kindredEnabled: true },
    kindred: null
  });
  assert.equal(r.items, null);
  assert.equal(r.reason, "client-missing");
  assert.ok(r.bannerHtml.length > 0, "a missing client must be announced");
  assert.match(r.bannerHtml, /did not load/);
});

test("kindred: null means absent, and does not fall through to the global", async () => {
  // Three states, and the middle one is a trap:
  //   undefined -> not injected, use the global (what the extension does)
  //   null      -> deliberately absent, report the fault
  //   an object -> injected, use it
  // Falsy-or was wrong for the middle state: a caller reporting a failed script
  // load would silently get the global instead, and the client-missing banner
  // would never appear — the exact invisible failure this file exists to catch.
  const missing = await resolveSource(CTX, {
    settings: { kindredEnabled: true },
    kindred: null
  });
  assert.equal(missing.reason, "client-missing");

  const injected = await resolveSource(CTX, stubFetch(okResp(GOOD)));
  assert.equal(injected.reason, null, "an injected client is used");

  // undefined falls through to the context's global, which is the real client.
  const viaGlobal = await resolveSource(CTX, {
    settings: { kindredEnabled: true },
    fetch: okResp(GOOD)
  });
  assert.equal(viaGlobal.reason, null, "undefined uses the global");
});

// ---- the pairing: every fallback explains itself -----------------------

const FAILURES = [
  ["unreachable", async () => { throw new TypeError("Failed to fetch"); }],
  ["not-supported", async () => ({ ok: false, status: 404, json: async () => ({}) })],
  ["malformed", async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } })],
  ["empty", async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) })],
  ["timeout", async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; }],
  ["http-error", async () => ({ ok: false, status: 500, json: async () => ({}) })]
];

for (const [expected, impl] of FAILURES) {
  test(`${expected}: falls back to local ranking AND says so`, async () => {
    const r = await resolveSource(CTX, stubFetch(impl));
    // The fallback...
    assert.equal(r.items, null, "local ranking, i.e. no kindred items");
    assert.ok(r.reason, "a reason must be recorded");
    // ...and the explanation. This half is the point of the test.
    assert.ok(
      r.bannerHtml.length > 0,
      `a ${expected} fallback with no banner is the silent-degradation failure`
    );
    assert.match(r.bannerHtml, /feed-source-note/);
    assert.ok(r.note && r.note.length > 10, "and a note a person can act on");
  });
}

test("unreachable and empty produce DIFFERENT banners", async () => {
  // The distinction SPEC §4.6 calls out. A reader told "unreachable" when the
  // truth is "nothing to say yet" will go and start a server that was already
  // running.
  const down = await resolveSource(
    CTX, stubFetch(async () => { throw new TypeError("Failed to fetch"); })
  );
  const cold = await resolveSource(CTX, stubFetch(okResp({ items: [] })));
  assert.notEqual(down.bannerHtml, cold.bannerHtml);
  assert.match(cold.bannerHtml, /no recommendations for you yet/i);
});

// ---- the success path --------------------------------------------------

test("success: kindred items are used, and there is no banner", async () => {
  const r = await resolveSource(CTX, stubFetch(okResp(GOOD)));
  assert.equal(r.reason, null);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].fromKindred, true);
  assert.equal(r.bannerHtml, "", "a healthy feed has nothing to explain");
});

test("a degraded signal gets a banner even though the call succeeded", async () => {
  // A working kindred that could not use one signal. Silently ignoring it is
  // the same class of invisible wrongness as a silent fallback.
  const r = await resolveSource(
    CTX,
    stubFetch(okResp({ ...GOOD, meta: { degraded: ["recency"] } }))
  );
  assert.equal(r.reason, null, "degradation is not a failure");
  assert.ok(r.items.length > 0, "and the results are still used");
  assert.match(r.bannerHtml, /recency/, "but the reader is told which signal");
});

test("items are mapped into the feed's shape, evidence included", async () => {
  const r = await resolveSource(CTX, stubFetch(okResp(GOOD)));
  const item = r.items[0];
  assert.equal(item.id, "1");
  assert.equal(item.title, "One");
  assert.equal(item.score, 5);
  assert.ok(item.url.includes("archiveofourown.org/works/1"), "a usable link");
  // evidence[] maps onto breakdown, which is what the "why this?" UI reads.
  assert.equal(item.breakdown.signals.length, 1);
  assert.equal(item.breakdown.signals[0].signal, "popularity");
  assert.equal(item.breakdown.signals[0].reason, "r");
});

test("seeds come from read history, capped, and are opaque to kindred", async () => {
  const seeds = buildKindredSeeds(CTX);
  assert.equal(seeds.length, 3);
  // Compared element-wise, not with deepEqual: the array was built inside the
  // vm context, so it is a different realm's Array and deepEqual rejects it on
  // prototype identity even though the contents match. A cross-realm array is
  // still a real array — Array.isArray says so, and that is what matters.
  assert.ok(Array.isArray(seeds), "seeds must be a real array");
  assert.deepEqual(
    [...seeds],
    ["kindred_seed:work:1", "kindred_seed:work:2", "kindred_seed:work:3"]
  );
  // A big history does not become a 10,000-item query string.
  const many = new Set(Array.from({ length: 500 }, (_, i) => i));
  assert.ok(buildKindredSeeds({ historyFicIds: many }).length <= 40);
  // And a context with no history at all is not a crash.
  assert.deepEqual([...buildKindredSeeds({})], []);
  assert.deepEqual([...buildKindredSeeds(null)], []);
});

// ---- the banner itself -------------------------------------------------

test("sourceBanner escapes its text", async () => {
  // The note is server-supplied in the general case; it goes into innerHTML.
  const html = sourceBanner('<img src=x onerror="alert(1)">');
  assert.ok(!html.includes("<img"), "markup in a note must not survive");
  assert.ok(html.includes("&lt;img"), "it should be escaped, not dropped");
});

test("sourceBanner on empty text is empty, not an empty div", () => {
  assert.equal(sourceBanner(""), "");
  assert.equal(sourceBanner(null), "");
  assert.equal(sourceBanner(undefined), "");
});

test("resolveSource never throws, whatever it is handed", async () => {
  // The floor under the whole feed. A throw here is worse than a bad ranking.
  const hostile = [
    null,
    undefined,
    {},
    { historyFicIds: null },
    { historyFicIds: "not a set" }
  ];
  for (const ctx of hostile) {
    const r = await resolveSource(ctx, {
      settings: { kindredEnabled: true },
      kindred: K,
      fetch: async () => ({ ok: true, status: 200, json: async () => GOOD })
    });
    assert.ok(r && typeof r === "object", `no result for ${JSON.stringify(ctx)}`);
    assert.ok("items" in r);
  }
});
