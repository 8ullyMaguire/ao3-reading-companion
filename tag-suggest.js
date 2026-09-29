// tag-suggest.js — mine candidate tags from the fics a reader has browsed.
//
// Issue #1 asks for "some sort of algorithm that looks for frequent tags from
// fics you browse, so that you can easily add them". The hard part is not the
// counting; it is not suggesting a tag the reader already has an opinion
// about, and not suggesting a tag that is on every fic in existence.
//
// Three exclusions, each for a different reason:
//
//   already decided   — suggesting a tag the reader already preferred or blocked
//                       is noise at best and insulting at worst. A blocked tag
//                       coming back as a suggestion is the worst case: it
//                       means the mining ignored the reader's own input.
//   universal tags    — "female/male", "no archive warnings apply". They are
//                       on most fics, so frequency alone surfaces them at the
//                       top, and they carry no information about taste. A tag
//                       on 90% of fics describes the archive, not the reader.
//   fandom-only tags  — mined from freeform/relationship/character tags only.
//                       Fandom is captured separately and a fandom tag is
//                       redundant with it.
//
// No ranking by raw frequency alone. A tag on 3 of 4 fics is not evidence of
// taste, it is evidence of a small cache; "andromeda", "draco malfoy" and
// "harry potter" would win. The ratio term is what separates "this reader
// reads these 3 of their 4 fics" from "this tag is everywhere".
//
// No DB writes, no network. Reads via the passed-in records only, so it is
// testable without IndexedDB.

// Boilerplate suppression.
//
// This started as a ratio test at 0.5, which was wrong twice over. A ratio
// measures how OFTEN a tag appears, and frequency is the thing the feature is
// ranking by — so a ratio cutoff throws away the strongest evidence of taste
// there is. A tag on 3 of 4 fics (ratio 0.75) is the clearest signal a reader
// has; a ratio cutoff at 0.5 discarded it and kept only the tags on ONE fic,
// exactly backwards. Eight tests failed and were right to.
//
// It then moved to 0.9, which was better but still wrong, because ratio alone
// cannot tell "every fic I read has this tag" from "this tag is on everything
// on AO3". For a narrow reader those are indistinguishable, and the all-of-
// cache tag is their taste.
//
// So frequency alone ranks, and the only thing suppressed is a tag on EVERY
// fic when the cache is large enough that "every" is statistically
// meaningful. Below MIN_FICS_FOR_UNIVERSAL the reader's cache is too small for
// "all of them" to mean anything, so an all-of-cache tag is kept: three fics
// that all share a tag is a reader with three fics, not a universal.
//
// What this actually removes is "no archive warnings apply" on a reader with
// 15+ fics — which is the case it was written for, and the only one that was
// ever real.
const UNIVERSAL_RATIO = 1.0;
const MIN_FICS_FOR_UNIVERSAL = 8;

// Below this many fics there is no basis for a suggestion at all. Three fics
// cannot distinguish a preference from a coincidence.
const MIN_FICS = 3;

const SUGGEST_LIMIT = 12;

// A tag on only one fic is an accident, not a pattern. Two is borderline;
// three is where "I keep seeing this" becomes defensible.
const MIN_FIC_COUNT = 2;

// ---------- Tag extraction ----------

// Only the three tag fields a reader expresses taste through. Fandom is a
// separate preference type and is not mined here.
function suggestionTags(fic) {
  if (!fic) return [];
  const out = [];
  for (const arr of [fic.freeformTags, fic.relationships, fic.characters]) {
    for (const t of arr || []) {
      if (t) out.push(String(t));
    }
  }
  return out;
}

// ---------- Mining ----------

// mineTagSuggestions(fics, existing, opts) -> [{ tag, display, ficCount, ratio }]
//
// fics      — the reader's fics (history records joined with ficCache, or
//             simply the cached fics they have opened)
// existing  — { preferred: Set<string>, blocked: Set<string> } of LOWERCASE
//             values; used to suppress decided tags
// opts      — { limit, minFics, minFicCount, universalRatio }
function mineTagSuggestions(fics, existing, opts = {}) {
  const limit = opts.limit ?? SUGGEST_LIMIT;
  const minFics = opts.minFics ?? MIN_FICS;
  const minFicCount = opts.minFicCount ?? MIN_FIC_COUNT;
  const universalRatio = opts.universalRatio ?? UNIVERSAL_RATIO;
  const minFicsForUniversal = opts.minFicsForUniversal ?? MIN_FICS_FOR_UNIVERSAL;

  const list = (fics || []).filter(Boolean);
  if (list.length < minFics) return [];

  const preferred = (existing && existing.preferred) || new Set();
  const blocked = (existing && existing.blocked) || new Set();

  // Per-fic Set, so a tag repeated inside one fic (AO3 does allow a tag to
  // appear in both the character and relationship lists) counts once for that
  // fic. Counting it twice would inflate a tag's ratio and could push it over
  // the universal threshold on its own.
  const counts = new Map();
  const displayByLower = new Map();

  for (const fic of list) {
    const seen = new Set();
    for (const raw of suggestionTags(fic)) {
      const lower = raw.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      counts.set(lower, (counts.get(lower) || 0) + 1);
      // Keep the reader's casing: "Enemies to Lovers" reads better than
      // "enemies to lovers" on a button they are about to click.
      if (!displayByLower.has(lower)) displayByLower.set(lower, raw);
    }
  }

  const n = list.length;
  const out = [];

  for (const [lower, ficCount] of counts) {
    if (ficCount < minFicCount) continue;
    if (preferred.has(lower) || blocked.has(lower)) continue;

    const ratio = ficCount / n;
    // "Universal" means on every fic AND the cache is big enough for that to
    // mean something. n < MIN_FICS_FOR_UNIVERSAL keeps all-of-cache tags.
    if (n >= minFicsForUniversal && ratio >= universalRatio) continue;

    out.push({
      tag: lower,
      display: displayByLower.get(lower),
      ficCount,
      ratio
    });
  }

  // Most-seen first, then alphabetical for a stable order.
  //
  // No "rarer wins" tiebreak on ratio: ratio is ficCount/n, so at equal counts
  // it is always 0 and the term was dead weight pretending to be a
  // preference. A tag on more of the reader's fics is the better suggestion,
  // full stop.
  out.sort((a, b) => b.ficCount - a.ficCount || a.tag.localeCompare(b.tag));

  return out.slice(0, limit);
}

// ---------- Exports ----------
//
// This file is loaded two ways: as a plain <script> in feed.html, where a bare
// `function` declaration already puts mineTagSuggestions on window, and by the
// node test runner, where it is imported as a module and a bare declaration
// exports nothing at all — the first version of the test failed with
// "mineTagSuggestions is not a function" for exactly that reason, pointing at
// the test file when the real cause was here.
//
// Guarded so the browser path does not throw on a missing module object.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { mineTagSuggestions, suggestionTags };
}
