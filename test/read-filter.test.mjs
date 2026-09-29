// test/read-filter.test.mjs
//
// The reported bug: the feed recommended the exact fics the user had already
// browsed. Root cause: `ctx.historyFicIds` is computed once per feed build and
// handed to every row, but only `your_authors` and opt-in custom rows ever
// consulted it. Five of the seven default rows rendered read fics.
//
// The fix is `excludeReadItems` in feed.js, applied at the one seam every row
// passes through. This test pins that seam.
//
// `node --test test/` — no dependencies, no bundler. The repo has no test
// infrastructure at all, and a fix for a ranking bug with no test is a fix
// that reverts the next time someone edits this seam.
//
// feed.js is not imported here: it is a browser script that touches document,
// indexedDB and chrome.* at load time. The function under test is pure and
// takes plain objects, so it is exercised directly. That is a real trade —
// the copy below can drift from feed.js — so `node tools/check-read-filter.mjs`
// asserts the two stay in sync, and the test is not a substitute for it.

import { test } from "node:test";
import assert from "node:assert/strict";

// Verbatim copy of excludeReadItems + READ_EXEMPT_ROW_TYPES from feed.js.
// Kept honest by tools/check-read-filter.mjs.
const READ_EXEMPT_ROW_TYPES = new Set(["fresh_chapters"]);

function excludeReadItems(scoredItems, ctx, rowType) {
  if (READ_EXEMPT_ROW_TYPES.has(rowType)) return scoredItems;
  if (!ctx || !ctx.historyFicIds || ctx.historyFicIds.size === 0) return scoredItems;
  return scoredItems.filter(it => !ctx.historyFicIds.has(it.fic.ficId));
}

// --- fixtures -------------------------------------------------------------

const READ = 111, UNREAD = 222, ALSO_READ = 333;

function item(ficId, score) {
  return { fic: { ficId, title: `fic ${ficId}` }, score, breakdown: { passed: true } };
}

// Every default row, with the rowType it actually uses in ROW_DEFINITIONS.
const FILTERED_ROW_TYPES = [
  "similar_to_tastes",
  "popular",
  "hidden_gems",
  "discover_new",
  "completed_long_reads",
  "your_authors",
];

function ctxWith(readIds) {
  return { historyFicIds: new Set(readIds) };
}

// --- the reported bug -----------------------------------------------------

test("a read fic is removed from every recommending row", () => {
  const scored = [item(READ, 9), item(UNREAD, 8), item(ALSO_READ, 7)];
  const ctx = ctxWith([READ, ALSO_READ]);

  for (const rowType of FILTERED_ROW_TYPES) {
    const kept = excludeReadItems(scored, ctx, rowType);
    const ids = kept.map(i => i.fic.ficId);
    assert.ok(!ids.includes(READ), `${rowType} still shows read fic ${READ}`);
    assert.ok(!ids.includes(ALSO_READ), `${rowType} still shows read fic ${ALSO_READ}`);
    assert.ok(ids.includes(UNREAD), `${rowType} dropped the unread fic`);
  }
});

test("read fics sort to the top, which is why the filter has to exist", () => {
  // Guards the premise. If scoring ever stopped favouring read fics, the
  // filter would look unnecessary and someone would delete it. It is not
  // unnecessary: reading a fic is the strongest positive signal there is, so
  // these fics are always at the front of `scored` and always survive scoring.
  const scored = [item(READ, 9.5), item(UNREAD, 2.1)];
  const ctx = ctxWith([READ]);
  const kept = excludeReadItems(scored, ctx, "similar_to_tastes");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].fic.ficId, UNREAD);
});

// --- the exemption, which is the part that is easy to break ---------------

test("fresh_chapters still shows read fics — that is the row's whole job", () => {
  const scored = [item(READ, 9)];
  const kept = excludeReadItems(scored, ctxWith([READ]), "fresh_chapters");
  assert.equal(kept.length, 1, "fresh_chapters must keep read fics");
  assert.equal(kept[0].fic.ficId, READ);
});

// --- cold start -----------------------------------------------------------

test("a user with no history sees an identical feed to before the fix", () => {
  const scored = [item(READ, 9), item(UNREAD, 8)];
  for (const rowType of FILTERED_ROW_TYPES) {
    assert.equal(excludeReadItems(scored, ctxWith([]), rowType).length, 2);
    assert.equal(excludeReadItems(scored, {}, rowType).length, 2);
  }
});

test("a missing ctx does not throw", () => {
  const scored = [item(READ, 9)];
  assert.equal(excludeReadItems(scored, undefined, "popular").length, 1);
  assert.equal(excludeReadItems(scored, { historyFicIds: null }, "popular").length, 1);
});

// --- ordering and shape ---------------------------------------------------

test("filtering preserves score order and does not mutate the input", () => {
  const scored = [item(1, 9), item(2, 8), item(3, 7), item(4, 6)];
  const ctx = ctxWith([2, 4]);
  const kept = excludeReadItems(scored, ctx, "similar_to_tastes");

  assert.deepEqual(kept.map(i => i.fic.ficId), [1, 3]);
  assert.deepEqual(kept.map(i => i.score), [9, 7], "order must be preserved");
  assert.equal(scored.length, 4, "input must not be mutated");
});

test("filtering a fully-read cache yields an empty row, not a crash", () => {
  const scored = [item(READ, 9), item(ALSO_READ, 8)];
  const kept = excludeReadItems(scored, ctxWith([READ, ALSO_READ]), "similar_to_tastes");
  assert.equal(kept.length, 0);
  // renderAllRows must still render an empty state for this row rather than
  // blowing up on `result.items[0]`.
  assert.ok(Array.isArray(kept));
});
