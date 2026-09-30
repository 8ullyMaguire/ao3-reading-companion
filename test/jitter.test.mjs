// discover_new's jitter, and the arithmetic nobody reads correctly.
//
// ROW_TYPE_JITTER holds HALFWIDTHS. _scoreJitter returns
// (Math.random() * 2 - 1) * range, so the spread is 2x the number. A value of
// "4" is an 8-point spread, which is why discover_new — the row whose entire
// signal is a single anchor-tag match — was being ordered by Math.random().
//
// These tests drive _scoreJitter itself rather than reading the constant. A
// test that only asserts the constant would still pass if _scoreJitter were
// changed to return `range * 2`, which is the more likely way for this to break
// again: someone "fixing" the spread without knowing what it means.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Verbatim copies of the two declarations under test, per this repo's
// convention (see test/read-filter.test.mjs): scoring.js is a browser script
// that touches `document` and `chrome.*` at load time, so it cannot be
// imported. The trade is real — a copy can drift from the original — and
// tools/check-jitter-spread.mjs is what closes that gap, by reading the real
// table out of scoring.js and failing on any row outside its cap. So a drift
// cannot pass silently, and this file is not a substitute for it.
//
// Row order and values are copied verbatim; only the trailing comment above
// ROW_TYPE_JITTER is not reproduced.
const ROW_TYPE_JITTER = {
  similar_to_tastes: 1.5,
  discover_new: 1.5,
  popular: 1,
  hidden_gems: 1,
  your_authors: 0,
  completed_long_reads: 2,
  fresh_chapters: 0
};
const DEFAULT_JITTER = 1.5;

// _scoreJitter verbatim from scoring.js, with Math.random injected so the
// extremes are reachable on demand.
function _scoreJitter(rowType, rand = Math.random) {
  const range = ROW_TYPE_JITTER[rowType] != null ? ROW_TYPE_JITTER[rowType] : DEFAULT_JITTER;
  if (range === 0) return { range, score: 0 };
  const score = Math.round((rand() * 2 - 1) * range * 10) / 10;
  return { range, score };
}

function loadJitter() {
  return { rows: ROW_TYPE_JITTER, def: DEFAULT_JITTER, jitter: _scoreJitter };
}

test("ROW_TYPE_JITTER holds halfwidths, and the spread is twice the number", () => {
  const { rows } = loadJitter();
  // The single fact the whole file is about.
  assert.equal(rows.discover_new * 2, 3, "discover_new's spread should be 3");
  assert.notEqual(
    rows.discover_new,
    4,
    "discover_new must not be back to 4, which is an 8-point spread"
  );
});

test("_scoreJitter never exceeds the halfwidth, in either direction", () => {
  const { jitter, rows } = loadJitter();
  for (const row of Object.keys(rows)) {
    const lo = jitter(row, () => 0).score;
    const hi = jitter(row, () => 1).score;
    // Compare as numbers, not with ===: at rand=0 a halfwidth of 0 yields
    // -0, and Object.is(-0, 0) is false. `== 0` normalises that.
    assert.ok(lo == -rows[row], `${row} at rand=0: got ${lo}, want ${-rows[row]}`);
    assert.ok(hi == rows[row], `${row} at rand=1: got ${hi}, want ${rows[row]}`);
    // And the observed spread is exactly twice the halfwidth.
    assert.ok(hi - lo == 2 * rows[row], `${row} spread: got ${hi - lo}`);
  }
});

test("discover_new's jitter cannot outvote its signal", () => {
  const { jitter, rows } = loadJitter();
  // The margin has to EXCEED the worst-case jitter difference, which is the
  // full spread, 2 * halfwidth. A margin equal to the spread ties on the
  // extreme draw and the assertion below is not a statement about the design
  // at all — it is a coin flip. 5 > 3 clears it with room, and 5 is well
  // inside what the anchor logic can produce: the row is filtered to at most
  // one other preferred-tag match, so a match outranks a non-match by more
  // than the whole tag-weight scale.
  const margin = 5;
  assert.ok(
    margin > 2 * rows.discover_new,
    `margin ${margin} must exceed the spread ${2 * rows.discover_new}`
  );
  for (let i = 0; i < 1000; i++) {
    const better = margin + jitter("discover_new", Math.random).score;
    const worse = jitter("discover_new", Math.random).score;
    assert.ok(
      better > worse,
      `a better anchor match lost to jitter (${better} <= ${worse})`
    );
  }
});

test("jitter is symmetric, so the extremes are equally likely", () => {
  const { jitter, rows } = loadJitter();
  // Catches a formula change that quietly makes jitter one-sided — rand()
  // used directly instead of (rand()*2-1) would make every draw positive.
  //
  // The sample points are 0.8 and 0.2, not 0.75 and 0.25, and that is not
  // arbitrary. JS Math.round breaks ties toward +Infinity, so at a half-way
  // value the function is genuinely asymmetric: with r = 1.5, rand=0.75 gives
  // round1(0.75) = 0.8 while rand=0.25 gives round1(-0.75) = -0.7. Testing at
  // the boundary would assert a symmetry the function does not have, and the
  // test would be wrong about the code rather than about a regression. At 0.8
  // and 0.2 the values are +/-0.9 and the symmetry is real.
  const r = rows.discover_new;
  assert.ok(jitter("discover_new", () => 0.5).score == 0, "midpoint is 0");

  const pos = jitter("discover_new", () => 0.8).score;
  const neg = jitter("discover_new", () => 0.2).score;
  assert.equal(pos, 0.9, "positive eighth");
  assert.equal(neg, -0.9, "negative eighth");
  assert.equal(pos, -neg, "the two are exact mirrors");
  // Compared through the same one-decimal rounding, because 0.6 * 1.5 is
  // 0.9000000000000001 in binary floating point and the function's own
  // _round1 is what turns that back into 0.9.
  const round1 = (n) => Math.round(n * 10) / 10;
  assert.equal(pos, round1((0.8 * 2 - 1) * r), "and equal the formula, rounded");
  assert.equal(neg, round1((0.2 * 2 - 1) * r), "and so does the negative one");
});

// THE drift test. Everything above exercises a VERBATIM COPY of the constants,
// which is the only way to test a browser script that cannot be imported — and
// it means a change to scoring.js alone passes all of them. Proven by mutation:
// setting discover_new back to 4 in scoring.js left this file fully green.
//
// So the real table is parsed out of scoring.js and compared to the copy, in
// both directions, and the spread is re-asserted from the real source rather
// than the copy. The copy becomes a mirror instead of a snapshot.
test("the copy in this file still matches ROW_TYPE_JITTER in scoring.js", () => {
  const src = readFileSync(join(root, "scoring.js"), "utf8");
  const table = src.match(/const ROW_TYPE_JITTER = \{([\s\S]*?)\n\};/);
  assert.ok(table, "ROW_TYPE_JITTER not found in scoring.js — a rename would do this");
  const real = Object.fromEntries(
    [...table[1].matchAll(/(\w+):\s*([\d.]+)/g)].map(([, n, v]) => [n, Number(v)])
  );

  // Both directions. One direction alone lets a row be added or dropped.
  const missing = Object.keys(ROW_TYPE_JITTER).filter((k) => !(k in real));
  const extra = Object.keys(real).filter((k) => !(k in ROW_TYPE_JITTER));
  const changed = Object.keys(ROW_TYPE_JITTER)
    .filter((k) => k in real && real[k] !== ROW_TYPE_JITTER[k])
    .map((k) => `${k}: copy ${ROW_TYPE_JITTER[k]} vs real ${real[k]}`);

  assert.deepEqual(missing, [], "rows in the copy but not in scoring.js");
  assert.deepEqual(extra, [], "rows in scoring.js but not in the copy");
  assert.deepEqual(changed, [], "halfwidths that differ");

  // Re-read the real source for the claim this file exists for, so a
  // regression fails here even if the copy above is updated to match it.
  assert.equal(
    real.discover_new * 2,
    3,
    `discover_new's real halfwidth is ${real.discover_new}, an ${
      2 * real.discover_new
    }-point spread on a row whose signal is a single tag match`
  );
  assert.equal(
    real.completed_long_reads * 2,
    4,
    "completed_long_reads keeps its deliberate +/-2; it scores on the full taste signal"
  );
});

// The same drift problem one level down: _scoreJitter's FORMULA is copied too,
// so changing the arithmetic in scoring.js left this file green. Proven —
// replacing (Math.random() * 2 - 1) * range with Math.random() * 2 * range
// (one-sided and twice as wide) passed every test here.
//
// The formula is compared as source text, and the shape is pinned, because the
// point is not that two implementations agree — it is that there is only one.
test("the copied _scoreJitter still matches scoring.js's", () => {
  const src = readFileSync(join(root, "scoring.js"), "utf8");
  const real = src.match(/function _scoreJitter\(rowType\)[\s\S]*?\n\}/);
  assert.ok(real, "_scoreJitter not found in scoring.js");

  const defaults = src.match(/const DEFAULT_JITTER = ([\d.]+)/);
  assert.ok(defaults, "DEFAULT_JITTER not found");
  assert.equal(Number(defaults[1]), DEFAULT_JITTER, "DEFAULT_JITTER differs from the copy");

  // A zero range must short-circuit. Without it a jittered row multiplies by
  // zero and every draw is 0 — which coincidentally matches this copy.
  assert.ok(
    /if \(range === 0\) return \{ range, score: 0 \};/.test(real[0]),
    "scoring.js no longer short-circuits a zero range"
  );

  // The multiplier, matched loosely on purpose: the point is to catch a change
  // in SHAPE, not to re-implement the expression. `_round1((Math.random() * 2
  // - 1) * range)` contains "2 - 1" inside the parens; a one-sided
  // "Math.random() * 2 * range" must not.
  const mult = real[0].match(/\*\s*(\d+)\s*-\s*(\d+)\s*\)/);
  assert.ok(
    mult,
    "no (x * a - b) multiplier found in _scoreJitter — the formula changed " +
      "shape, so this file's copy is no longer a mirror of it"
  );
  assert.equal(mult[1], "2", "the multiplier is no longer * 2");
  assert.equal(mult[2], "1", "the offset is no longer - 1");

  // Applied once, to the whole expression.
  assert.ok(
    /\*\s*range\s*\)/.test(real[0]),
    "the range is no longer applied as a halfwidth in scoring.js"
  );
  // One-sided jitter specifically: with no subtraction every draw is positive,
  // so a jittered row is quietly rewarded for being jittered.
  assert.ok(
    !/Math\.random\(\)\s*\*\s*2\s*\*\s*range/.test(real[0]),
    "jitter is one-sided — every draw is positive"
  );
});

test("a row with no jitter returns exactly 0, not a small random number", () => {
  const { jitter } = loadJitter();
  for (let i = 0; i < 50; i++) {
    assert.equal(jitter("your_authors").score, 0);
    assert.equal(jitter("fresh_chapters").score, 0);
  }
});
