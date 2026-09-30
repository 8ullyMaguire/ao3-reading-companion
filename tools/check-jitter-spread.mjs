#!/usr/bin/env node
// Fails if any row's jitter can outvote its signal.
//
// The field is a HALFWIDTH: _scoreJitter returns (Math.random() * 2 - 1) *
// range, so the spread is twice the number in ROW_TYPE_JITTER. discover_new
// read 4, which is an 8-point spread, on a row whose whole signal is an
// anchor-tag match worth a few points. That is the bug this file exists to
// stop coming back — it is invisible in the source, because "4" looks small.
//
// The cap is PER ROW, because a single global cap is the wrong shape. A row's
// jitter is only a problem relative to how much signal it has. Two rows here
// use the full taste score (similar_to_tastes, completed_long_reads) — for
// those, jitter is a variety knob and a spread of 4 is deliberate. A first
// version of this file applied one global cap of 3.0 and flagged
// completed_long_reads, whose +/-2 is intentional; a check people disable is
// worse than no check.
//
// A row with jitter and no declared cap is itself a failure: an uncapped row
// is how discover_new reached 4 in the first place.
//
// Run: node tools/check-jitter-spread.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "scoring.js"), "utf8");

// The table's own braces, so this does not match a row id appearing in a
// comment or in ROW_DEFINITIONS.
const table = src.match(/const ROW_TYPE_JITTER = \{([\s\S]*?)\n\};/);
if (!table) {
  console.error("FAIL: ROW_TYPE_JITTER not found in scoring.js");
  process.exit(1);
}

const rows = [...table[1].matchAll(/(\w+):\s*([\d.]+)/g)].map(([, name, v]) => ({
  name,
  halfwidth: Number(v),
}));

if (rows.length === 0) {
  // A regex that matches nothing is indistinguishable from a clean pass, and
  // reads as one. Say so rather than exiting 0.
  console.error("FAIL: parsed zero rows — the anchor matched nothing.");
  process.exit(1);
}

// full-signal rows (score is the full taste score) -> jitter is variety
// thin-signal rows -> jitter must not outvote the one thing they measure
const CAPS = {
  similar_to_tastes: 4.5,
  completed_long_reads: 4.5,
  discover_new: 3.0,
  popular: 3.0,
  hidden_gems: 3.0,
  your_authors: 3.0,
  fresh_chapters: 3.0,
};

let bad = 0;
let uncapped = 0;

console.log("row                   halfwidth  spread   cap");
for (const r of rows) {
  const spread = 2 * r.halfwidth;
  const has = Object.prototype.hasOwnProperty.call(CAPS, r.name);
  if (!has) {
    if (r.halfwidth > 0) {
      uncapped++;
      console.log(
        `  ${r.name.padEnd(20)} ${String(r.halfwidth).padStart(6)}  ` +
          `${spread.toFixed(1).padStart(5)}   <-- NO CAP`
      );
    }
    continue;
  }
  const cap = CAPS[r.name];
  const over = spread > cap;
  if (over) bad++;
  console.log(
    `  ${r.name.padEnd(20)} ${String(r.halfwidth).padStart(6)}  ` +
      `${spread.toFixed(1).padStart(5)}   ${String(cap).padStart(4)}` +
      (over ? "  <-- OVER" : "")
  );
}

if (uncapped > 0) {
  console.error(`\nFAIL: ${uncapped} row(s) have jitter but no declared cap. Add them to`);
  console.error("      CAPS with a reason. An uncapped row is how discover_new");
  console.error("      reached 4 in the first place.");
  process.exit(1);
}
if (bad > 0) {
  console.error(`\nFAIL: ${bad} row(s) can be reordered by jitter alone. A spread wider`);
  console.error("      than the signal means the row is ordered by Math.random().");
  process.exit(1);
}
console.log("\nPASS: every spread is within its row's cap.");
