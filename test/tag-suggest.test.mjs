// test/tag-suggest.test.mjs
//
// Issue #1's third ask: mine frequent tags from browsed fics so the reader can
// add them to preferred/blocked with one click.
//
// The counting is trivial. These tests are about the three exclusions, because
// each one is a way the feature looks broken rather than absent:
//   - suggesting a tag you already blocked reads as ignoring you
//   - suggesting "no archive warnings apply" reads as broken
//   - suggesting "draco malfoy" above your actual taste reads as broken
//
//   node --test 'test/*.test.mjs'

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// tag-suggest.js has no browser dependencies, so it loads directly — no copy,
// no drift check needed.
//
// It uses a bare `function` declaration (this codebase is plain scripts, not
// modules), so there is no `default` export. Import the namespace and read the
// binding off it; `mod.default || mod` would silently yield a namespace whose
// .mineTagSuggestions is undefined, and every test fails with a message that
// points at the test file rather than the import.
// CommonJS interop: the file is loaded as a <script> in the browser and
// imported here, and `import()` of a CJS module puts everything on `.default`.
const mod = await import(join(root, "tag-suggest.js"));
const { mineTagSuggestions } = mod.default || mod;
assert.equal(typeof mineTagSuggestions, "function",
  "tag-suggest.js must export mineTagSuggestions for the test runner");

const none = { preferred: new Set(), blocked: new Set() };

function fic(id, freeformTags = [], extra = {}) {
  return {
    ficId: id,
    freeformTags,
    relationships: extra.relationships || [],
    characters: extra.characters || []
  };
}

// --- the basic claim ------------------------------------------------------

test("a tag the reader keeps hitting is suggested", () => {
  const fics = [
    fic(1, ["enemies to lovers", "slow burn"]),
    fic(2, ["enemies to lovers", "fluff"]),
    fic(3, ["enemies to lovers", "angst"]),
    fic(4, ["coffeeshop au"])
  ];
  const out = mineTagSuggestions(fics, none);

  const tags = out.map(s => s.tag);
  assert.ok(tags.includes("enemies to lovers"), `expected the recurring tag, got ${tags}`);
  assert.ok(!tags.includes("coffeeshop au"), "a one-off tag is not a pattern");
});

test("the reported ficCount and ratio are correct", () => {
  const fics = [
    fic(1, ["slow burn"]),
    fic(2, ["slow burn"]),
    fic(3, ["slow burn"]),
    fic(4, ["other"])
  ];
  const [top] = mineTagSuggestions(fics, none);
  assert.equal(top.tag, "slow burn");
  assert.equal(top.ficCount, 3);
  assert.equal(top.ratio, 0.75);
});

// --- exclusion 1: don't re-suggest what the reader already decided --------

test("a preferred tag is never suggested back", () => {
  const fics = [fic(1, ["slow burn"]), fic(2, ["slow burn"]), fic(3, ["slow burn"])];
  const out = mineTagSuggestions(fics, { preferred: new Set(["slow burn"]), blocked: new Set() });
  assert.equal(out.length, 0, "suggesting a tag they already preferred is pure noise");
});

test("a BLOCKED tag is never suggested back — the worst case", () => {
  const fics = [
    fic(1, ["non-con", "slow burn"]),
    fic(2, ["non-con", "slow burn"]),
    fic(3, ["non-con", "slow burn"])
  ];
  const out = mineTagSuggestions(fics, { preferred: new Set(), blocked: new Set(["non-con"]) });
  const tags = out.map(s => s.tag);
  assert.ok(!tags.includes("non-con"),
    `the reader blocked this and it came back: ${tags}`);
  assert.ok(tags.includes("slow burn"), "the unblocked tag should still be suggested");
});

test("exclusion matching is case-insensitive", () => {
  // Preferences are stored with the reader's casing but compared lowercase
  // everywhere else; a case-sensitive check here would leak blocked tags back.
  const fics = [fic(1, ["Non-Con"]), fic(2, ["Non-Con"]), fic(3, ["Non-Con"])];
  const out = mineTagSuggestions(fics, { preferred: new Set(), blocked: new Set(["non-con"]) });
  assert.equal(out.length, 0, "blocked match must ignore case");
});

// --- exclusion 2: archive boilerplate ------------------------------------

test("a tag on EVERY fic is suppressed as boilerplate, given enough fics", () => {
  // Needs >= MIN_FICS_FOR_UNIVERSAL (8) fics. Below that, "on all of them" is
  // a reader with a small cache, not a universal — see the next test.
  const fics = [];
  for (let i = 1; i <= 10; i++) {
    fics.push(fic(i, ["no archive warnings apply", `flavour${i % 3}`]));
  }
  const tags = mineTagSuggestions(fics, none).map(s => s.tag);
  assert.ok(!tags.includes("no archive warnings apply"),
    `archive boilerplate should be suppressed on a 10-fic cache, got ${tags}`);
  assert.ok(tags.includes("flavour0"),
    `a genuine recurring tag must survive, got ${tags}`);
});

test("with fewer than 8 fics, an all-of-cache tag is KEPT, not suppressed", () => {
  // The asymmetry is the point: 3 fics that all share a tag is a reader whose
  // taste is concentrated, not a fact about AO3. Suppressing it here would
  // make the feature useless for exactly the readers it helps most.
  const fics = [
    fic(1, ["slow burn"]),
    fic(2, ["slow burn"]),
    fic(3, ["slow burn"])
  ];
  const tags = mineTagSuggestions(fics, none).map(s => s.tag);
  assert.ok(tags.includes("slow burn"),
    `a narrow reader's all-of-cache tag is their taste, got ${tags}`);
});

test("a tag the reader genuinely loves is NOT suppressed as universal", () => {
  // The suppression threshold must not eat real preferences. If every fic the
  // reader has is this tag, that IS their taste and suppressing it makes the
  // feature useless for a narrow reader.
  const fics = [fic(1, ["slow burn"]), fic(2, ["slow burn"]), fic(3, ["slow burn"])];
  const tags = mineTagSuggestions(fics, none).map(s => s.tag);
  assert.ok(tags.includes("slow burn"), "a genuine all-of-cache tag is a preference, not boilerplate");
});

// --- exclusion 3: fandom is not a freeform tag ---------------------------

test("relationship and character tags ARE mined; the fandom field is not", () => {
  // Relationships and characters are where AO3 taste actually lives, so they
  // must be mined. The `fandoms` field is deliberately NOT read — fandom is a
  // separate preference type with its own weight, and mining it here would
  // suggest a fandom as a "tag" and double-count it.
  const fics = [
    { ficId: 1, freeformTags: [], relationships: ["draco/harry"], characters: ["hedwig"], fandoms: ["Harry Potter"] },
    { ficId: 2, freeformTags: [], relationships: ["draco/harry"], characters: ["hedwig"], fandoms: ["Harry Potter"] },
    { ficId: 3, freeformTags: [], relationships: ["draco/harry"], characters: ["hedwig"], fandoms: ["Harry Potter"] }
  ];
  const tags = mineTagSuggestions(fics, none).map(s => s.tag);
  assert.ok(tags.includes("draco/harry"), `relationships must be mined, got ${tags}`);
  assert.ok(tags.includes("hedwig"), `characters must be mined, got ${tags}`);
  assert.ok(!tags.includes("harry potter"),
    `the fandom field must not be mined as a tag, got ${tags}`);
});

test("a tag repeated within ONE fic counts once", () => {
  // AO3 lets a tag appear in both the character and relationship lists.
  // Counting it twice would inflate the ratio and could cross the universal
  // threshold on its own.
  const fics = [
    fic(1, ["slow burn"], { characters: ["Slow Burn"] }),
    fic(2, ["other"]),
    fic(3, ["third"]),
    fic(4, ["fourth"])
  ];
  const out = mineTagSuggestions(fics, none);
  const hit = out.find(s => s.tag === "slow burn");
  assert.equal(hit, undefined,
    "one fic containing the tag twice is ficCount 1, below the pattern floor");
});

// --- cold start and edges ------------------------------------------------

test("no suggestions from fewer than three fics", () => {
  assert.equal(mineTagSuggestions([fic(1, ["a"]), fic(2, ["a"])], none).length, 0);
  assert.equal(mineTagSuggestions([fic(1, ["a"]), fic(2, ["a"]), fic(3, ["a"])], none).length, 1);
});

test("no suggestions from no fics at all", () => {
  assert.deepEqual(mineTagSuggestions([], none), []);
  assert.deepEqual(mineTagSuggestions(null, none), []);
  assert.deepEqual(mineTagSuggestions(undefined, undefined), []);
});

test("a fic with no tags does not throw", () => {
  const out = mineTagSuggestions([{ ficId: 1 }, fic(2, ["a"]), fic(3, ["a"]), null], none);
  assert.ok(Array.isArray(out));
});

test("suggestions are capped", () => {
  const tags = Array.from({ length: 40 }, (_, i) => `tag${i}`);
  const fics = Array.from({ length: 4 }, () => fic(1, tags));
  const out = mineTagSuggestions(fics, none, { limit: 12 });
  assert.equal(out.length, 12);
});

// --- ranking -------------------------------------------------------------

test("more frequent ranks first", () => {
  const fics = [
    fic(1, ["rare", "common"]),
    fic(2, ["rare", "common"]),
    fic(3, ["common"]),
    fic(4, ["common"]),
    fic(5, ["common"])
  ];
  const out = mineTagSuggestions(fics, none);
  assert.equal(out[0].tag, "common");
});

test("ties break toward the rarer (more specific) tag", () => {
  // Both appear on 2 of 4. "enemies to lovers" is a trope; "dark academia" is
  // a setting. Preferring the rarer one is the better suggestion.
  const fics = [
    fic(1, ["enemies to lovers", "dark academia"]),
    fic(2, ["enemies to lovers", "dark academia"]),
    fic(3, ["x"]),
    fic(4, ["y"])
  ];
  const out = mineTagSuggestions(fics, none);
  assert.equal(out[0].tag, "dark academia",
    `expected the rarer tag first, got ${out.map(s => s.tag)}`);
});

test("the display value keeps the reader's casing", () => {
  const fics = [fic(1, ["Enemies to Lovers"]), fic(2, ["Enemies to Lovers"]), fic(3, ["Enemies to Lovers"]), fic(4, ["z"]), fic(5, ["z"]), fic(6, ["z"]), fic(7, ["z"]), fic(8, ["z"]), fic(9, ["z"]), fic(10, ["z"])];
  const hit = mineTagSuggestions(fics, none).find(s => s.tag === "enemies to lovers");
  assert.equal(hit.display, "Enemies to Lovers");
  assert.equal(hit.tag, "enemies to lovers");
});
