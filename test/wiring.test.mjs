// test/wiring.test.mjs
//
// Static checks that the issue #1/#2 wiring is actually connected.
//
// The three features are DOM and IndexedDB code, so unit-testing their
// behaviour needs a browser. What CAN be checked here, and what would
// otherwise fail silently, is whether the pieces are hooked to each other at
// all: a handler that exists but is never dispatched, a script tag that loads
// after its consumer, a message type with no handler.
//
// A missing wire produces no error. The button just does nothing, which is
// exactly how a feature ships broken and gets reported as "doesn't work".
//
//   node --test 'test/*.test.mjs'

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = f => readFile(join(root, f), "utf8");

const [feed, content, background, db, feedHtml, feedCss] = await Promise.all([
  read("feed.js"), read("content.js"), read("background.js"),
  read("db.js"), read("feed.html"), read("feed.css")
]);

// --- issue #1: mark as read ----------------------------------------------

test("MARK_READ has a handler in the dispatcher", () => {
  assert.match(background, /MARK_READ:\s*handleMarkRead/,
    "the message type is sent but nothing handles it — the button does nothing");
  assert.match(background, /async function handleMarkRead\(/,
    "handleMarkRead must exist");
});

test("the in-page button actually sends MARK_READ", () => {
  assert.match(content, /type:\s*"MARK_READ"/,
    "the page button is rendered but never sends the message");
});

test("the feed card button exists and is wired to a handler", () => {
  assert.match(feed, /data-action="mark-read"/, "no mark-read button on the card");
  assert.match(feed, /action === "mark-read"/, "mark-read is not dispatched");
  assert.match(feed, /async function handleCardMarkRead\(/, "handler missing");
});

test("GET_HISTORY_STATE exists, so the button starts in the right state", () => {
  assert.match(background, /GET_HISTORY_STATE:\s*handleGetHistoryState/);
  assert.match(content, /type:\s*"GET_HISTORY_STATE"/);
});

test("the click listener is async, or the awaited handlers throw", () => {
  // `await` inside a non-async listener is a SyntaxError at parse time, and
  // `node --check` would catch it — but only for this file, and only if it is
  // checked. Assert the shape so the intent survives.
  assert.match(feed, /addEventListener\("click",\s*async\s*\(ev\)/,
    "the click handler awaits IndexedDB writes; it must be async");
});

// --- issue #2: prefer/block from a tag chip ------------------------------

test("the contextmenu handler is attached and prefers over the native menu", () => {
  assert.match(feed, /addEventListener\("contextmenu"/,
    "no contextmenu listener, so right-click does nothing");
  assert.match(feed, /data-action='filter'\]\[data-tag\]/,
    "the contextmenu selector must target chips that carry a tag");
  assert.match(feed, /ev\.preventDefault\(\)/,
    "the native menu must be suppressed or the reader gets two menus");
});

test("tag chips carry data-tag for the menu to act on", () => {
  assert.match(feed, /data-tag="\$\{escapeHtml\(c\.text\)\}"/,
    "chips have no data-tag, so there is nothing for the menu to prefer");
});

test("handleTagPreference is dispatched for both choices", () => {
  assert.match(feed, /async function handleTagPreference\(/);
  assert.match(feed, /action === "tag-prefer"/);
  assert.match(feed, /handleTagPreference\(chip\.dataset\.tag, true\)/);
  assert.match(feed, /handleTagPreference\(chip\.dataset\.tag, false\)/);
});

test("prefer and block are checked for existence before writing", () => {
  // setPreferredTag is a blind put on type:value, so re-adding would reset a
  // weight the reader had tuned in preferences.
  assert.match(feed, /getPreferredTagWeight\(value\)/,
    "prefer must check whether the tag is already preferred");
  assert.match(feed, /blocked_tag:\$\{value\}/,
    "block must check whether the tag is already blocked");
});

test("the helpers handleTagPreference calls exist in db.js", () => {
  for (const fn of ["setPreferredTag", "setBlockedTag", "getPreferredTagWeight", "dbGet"]) {
    assert.match(db, new RegExp(`(async )?function ${fn}\\b`),
      `${fn} is called from feed.js but not defined in db.js`);
  }
});

// --- issue #1 (third ask): mined tags ------------------------------------

test("tag-suggest.js loads BEFORE feed.js, which calls it", () => {
  const suggestAt = feedHtml.indexOf('src="tag-suggest.js"');
  const feedAt = feedHtml.indexOf('src="feed.js"');
  assert.ok(suggestAt > -1, "tag-suggest.js is not loaded by feed.html at all");
  assert.ok(suggestAt < feedAt,
    "tag-suggest.js loads after feed.js, so mineTagSuggestions is undefined at render time");
});

test("the suggestion row is rendered and wired to the miner", () => {
  assert.match(feed, /async function buildSuggestionRow\(/);
  assert.match(feed, /mineTagSuggestions\(browsed, existing\)/,
    "the row is built but never mines anything");
});

test("the mined row is actually APPENDED, not just built", () => {
  // The check above passes if buildSuggestionRow is merely defined and called.
  // Calling a builder and throwing the result away is the specific way this
  // feature ships invisible: no error, no row, nothing to report. Assert the
  // append, and that it is inside the container.
  assert.match(feed, /const suggest = await buildSuggestionRow\(ctx\)/,
    "the row is never built during a render");
  assert.match(feed, /if \(suggest && !suggest\.hidden\) container\.appendChild\(suggest\)/,
    "the built row is never appended to the feed container");
});

test("the render hook sits before the rows, not after them", () => {
  const at = feed.indexOf("await buildSuggestionRow(ctx)");
  const rowsAt = feed.indexOf("for (const { id } of visibleRows)");
  assert.ok(at > -1 && rowsAt > -1);
  assert.ok(at < rowsAt,
    "appended after the row loop it would land at the bottom of the feed, " +
    "which is where nobody looks");
});

test("the suggestion row cannot take the feed down with it", () => {
  // It is an extra, not the feature. An unhandled throw here would blank the
  // whole feed.
  assert.match(feed, /catch \(e\) \{\s*\n\s*\/\/ A failure here must not take the whole feed down/,
    "the suggestion row has no error boundary");
});

// --- styles ---------------------------------------------------------------

test("the new UI has styles", () => {
  for (const sel of [".card-actions .mark-read", ".maa-tag-menu", ".suggest-chip"]) {
    assert.ok(feedCss.includes(sel), `no CSS for ${sel} — the feature renders unstyled`);
  }
  assert.match(content, /\.maa-read-btn/, "the in-page read button has no styles");
});

// --- the pre-existing read filter must still be intact -------------------

test("the read-history filter from the earlier fix is still in place", () => {
  assert.match(feed, /def\.buildResult\(excludeReadItems\(scored, ctx, def\.rowType\), ctx\)/,
    "the already-read filter was lost — the reported bug would return");
});
