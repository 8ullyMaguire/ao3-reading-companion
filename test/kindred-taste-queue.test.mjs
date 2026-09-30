// test/kindred-taste-queue.test.mjs
//
// The taste queue's privacy boundary and its retry discipline.
//
// This queue is the only thing that flows from the extension to kindred, and
// what flows through it is the whole privacy story of the integration. The
// extension holds a complete record of what someone reads — the most
// sensitive data in the system — and what kindred needs is a small aggregate
// of what they liked. The server learns what the population likes, never who.
//
// So: tag and fandom WEIGHTS and verdict deltas go out. Fic URLs, titles,
// author names, and anything identifying the reader never do, and the field
// set is enforced by check rather than by trusting the caller.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "kindred.js"));
const K = require(join(root, "kindred.js"));

const q = (opts) => new K.TasteQueue({ post: async () => {}, ...opts });

test("a taste delta is accepted and normalised to the allowed field set", () => {
  const t = q();
  assert.equal(t.push({ kind: "taste", tag: "enemies to lovers", delta: 0.4 }), true);
  assert.equal(t.size, 1);
  assert.deepEqual(t.pending[0], {
    v: 1,
    kind: "taste",
    tag: "enemies to lovers",
    delta: 0.4
  });
  // And nothing extra rode along.
  for (const k of Object.keys(t.pending[0])) {
    assert.ok(K.TASTE_FIELDS.includes(k), `unexpected field "${k}" in the payload`);
  }
});

test("anything that is not a tag weight is refused", () => {
  const t = q();
  // Four shapes that would each be a privacy leak if accepted. The first three
  // have no `tag`, so they fail the field-shape validation before reaching the
  // allow-list; only the last one is an otherwise-valid event carrying a
  // forbidden field, and that is the one `dropped` counts.
  assert.equal(t.push({ kind: "taste", fic: "https://archiveofourown.org/works/1", delta: 1 }), false);
  assert.equal(t.push({ kind: "taste", title: "A Specific Fic", delta: 1 }), false);
  assert.equal(t.push({ kind: "taste", author: "SomeAuthor", delta: 1 }), false);
  assert.equal(t.push({ kind: "taste", tag: "x", delta: 1, reader: "me" }), false);
  assert.equal(t.size, 0, "nothing may be queued");
  assert.equal(t.dropped, 1, "the allow-list violation is counted, so it is visible");

  // And the count is not a silent pass: it only increments when an otherwise
  // well-formed event is rejected for carrying a forbidden field.
  const ok = q();
  ok.push({ kind: "taste", tag: "fine", delta: 1 });
  assert.equal(ok.dropped, 0);
});

test("a refusal drops the WHOLE event, not just the bad field", () => {
  // Stripping the offending field and keeping the rest would be worse: it
  // would ship a payload the caller believed was rejected, and the count in
  // `dropped` would understate what happened.
  const t = q();
  const before = t.size;
  t.push({ kind: "taste", tag: "slow burn", delta: 0.2, title: "Leaked Title" });
  assert.equal(t.size, before, "no partial event may be queued");
});

test("malformed deltas are refused", () => {
  const t = q();
  assert.equal(t.push({ kind: "taste", tag: "x", delta: "0.4" }), false);
  assert.equal(t.push({ kind: "taste", tag: "x", delta: NaN }), false);
  assert.equal(t.push({ kind: "taste", tag: "x", delta: Infinity }), false);
  assert.equal(t.push({ kind: "taste", tag: "", delta: 1 }), false);
  assert.equal(t.push({ kind: "taste", tag: 42, delta: 1 }), false);
  assert.equal(t.push(null), false);
  assert.equal(t.push("nope"), false);
  assert.equal(t.size, 0);
});

test("a non-taste kind is refused", () => {
  // The kind field is what makes this a taste event rather than, say, a
  // read-history ping. A future kind must be added deliberately.
  const t = q();
  assert.equal(t.push({ kind: "read", tag: "x", delta: 1 }), false);
  assert.equal(t.push({ kind: "history", tag: "x", delta: 1 }), false);
  assert.equal(t.size, 0);
});

test("a successful flush sends the batch and empties it", async () => {
  let sent = null;
  const t = new K.TasteQueue({ post: async (b) => { sent = b; } });
  t.push({ kind: "taste", tag: "a", delta: 1 });
  t.push({ kind: "taste", tag: "b", delta: -1 });
  const r = await t.flush();
  assert.equal(r.sent, 2);
  assert.equal(r.kept, 0);
  assert.equal(sent.length, 2);
  assert.equal(t.size, 0);
});

test("a FAILED flush keeps the batch", async () => {
  // A taste weight the reader set by hand is not something to lose because the
  // server was down for thirty seconds. Dropping the batch on failure is the
  // single most annoying possible bug in this queue: it is silent, it is
  // permanent, and it only shows up as "my preferences stopped being learned".
  const t = new K.TasteQueue({
    post: async () => { throw new TypeError("Failed to fetch"); }
  });
  t.push({ kind: "taste", tag: "slow burn", delta: 0.4 });
  const r = await t.flush();
  assert.equal(r.sent, 0);
  assert.equal(r.kept, 1, "the delta must survive a failed flush");
  assert.equal(t.size, 1);
  assert.deepEqual(t.pending[0], { v: 1, kind: "taste", tag: "slow burn", delta: 0.4 });
});

test("a retry after a failure sends the retained delta", async () => {
  let attempt = 0;
  const sent = [];
  const t = new K.TasteQueue({
    post: async (b) => {
      attempt++;
      if (attempt === 1) throw new TypeError("Failed to fetch");
      sent.push(...b);
    }
  });
  t.push({ kind: "taste", tag: "a", delta: 1 });
  await t.flush();
  assert.equal(sent.length, 0);
  await t.flush();
  assert.equal(sent.length, 1, "the second attempt delivers it");
  assert.equal(t.size, 0);
});

test("order survives a failed flush", async () => {
  // Deltas are order-sensitive: a +1 then a -1 is not the same as a -1 then a
  // +1, and a reordering retry would silently rewrite the reader's taste.
  let attempt = 0;
  const t = new K.TasteQueue({
    post: async () => { if (++attempt === 1) throw new Error("boom"); }
  });
  t.push({ kind: "taste", tag: "a", delta: 1 });
  t.push({ kind: "taste", tag: "b", delta: -1 });
  await t.flush();
  assert.deepEqual(
    t.pending.map((e) => e.tag),
    ["a", "b"],
    "the retained batch must keep its order"
  );
});

test("a flush respects the batch size and leaves the rest queued", async () => {
  const sent = [];
  const t = new K.TasteQueue({ batchSize: 2, post: async (b) => sent.push(...b) });
  for (const tag of ["a", "b", "c", "d", "e"]) {
    t.push({ kind: "taste", tag, delta: 1 });
  }
  const r = await t.flush();
  assert.equal(sent.length, 2);
  assert.equal(r.sent, 2);
  assert.equal(r.kept, 3, "the overflow stays queued for the next flush");
});

test("flushing an empty queue is a no-op, not a request", async () => {
  let called = false;
  const t = new K.TasteQueue({ post: async () => { called = true; } });
  const r = await t.flush();
  assert.equal(r.sent, 0);
  assert.equal(called, false, "an empty flush must not make a request");
});

test("nothing in the queued payload can identify a reader", () => {
  // Belt and braces over the per-field check: assert on the whole queued
  // object that it contains nothing URL-shaped or identity-shaped.
  const t = q();
  t.push({ kind: "taste", tag: "enemies to lovers", delta: 0.4 });
  const blob = JSON.stringify(t.pending);
  assert.ok(!/https?:/.test(blob), "no URL in the payload");
  assert.ok(!/works\/\d+/.test(blob), "no work id in the payload");
  assert.ok(!/users\//.test(blob), "no user id in the payload");
  assert.deepEqual(Object.keys(t.pending[0]).sort(), ["delta", "kind", "tag", "v"]);
});
