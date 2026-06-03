// scoring.js — pure scoring logic for My AO3 Algorithm.
//
// Given a fic + a snapshot of the user's preferences, return a numeric score
// plus a structured `breakdown` object explaining how the score was built.
// That breakdown becomes the payload for the future "why this?" UI.
//
// No DB writes, no network calls. Reads from the DB only via loadScoringInputs.
//
// Conventions (locked in via Phase 5 design Q&A):
//   - Constants stay decimal where the formula calls for it (1.5x browsing-style
//     multiplier, +0.5/+1/+1.5/+2 popularity, +/- 1.5 jitter). The integer-only
//     rule applies to user-set weights, not internal scoring constants.
//   - Tag matches are deduped across the four tag-like fields on a fic
//     (freeformTags, relationships, characters, warnings). Each preferred tag
//     contributes its weight at most once per fic.
//   - Behavioral signals are stubbed (always 0). Real implementation is a
//     later phase but the breakdown slot is present so the UI shape is stable.

const ROW_TYPE_JITTER = {
  similar_to_tastes: 1.5,
  discover_new: 4,
  popular: 1,
  hidden_gems: 1,
  your_authors: 0,
  completed_long_reads: 2,
  fresh_chapters: 0
};
const DEFAULT_JITTER = 1.5;
const BROWSING_STYLE_MULTIPLIER = 1.5;

function _round1(n) { return Math.round(n * 10) / 10; }

function _collectAllTags(fic) {
  const out = new Set();
  for (const arr of [fic.freeformTags, fic.relationships, fic.characters, fic.warnings]) {
    for (const t of arr || []) {
      if (t) out.add(String(t).toLowerCase());
    }
  }
  return out;
}

// ---------- Hard filter ----------
//
// Returns { passed: true } if the fic survives, otherwise
// { passed: false, reason: "blocked_tag:Mpreg" } (or similar).

function hardFilter(fic, preferences) {
  const { blockedTagSet, blockedAuthorSet, structural } = preferences;

  const author = (fic.author || "").toLowerCase();
  if (author && blockedAuthorSet.has(author)) {
    return { passed: false, reason: `blocked_author:${fic.author}` };
  }

  if (blockedTagSet && blockedTagSet.size > 0) {
    const allTags = _collectAllTags(fic);
    for (const t of allTags) {
      if (blockedTagSet.has(t)) {
        return { passed: false, reason: `blocked_tag:${t}` };
      }
    }
  }

  if (structural) {
    const wc = fic.wordCount;
    if (structural.minWords && wc != null && wc < structural.minWords) {
      return { passed: false, reason: `below_min_words (${wc} < ${structural.minWords})` };
    }
    if (structural.maxWords && wc != null && wc > structural.maxWords) {
      return { passed: false, reason: `above_max_words (${wc} > ${structural.maxWords})` };
    }
    if (Array.isArray(structural.ratings) && structural.ratings.length > 0 && fic.rating) {
      if (!structural.ratings.includes(fic.rating)) {
        return { passed: false, reason: `wrong_rating (${fic.rating})` };
      }
    }
    if (structural.completeOnly && fic.isComplete === false) {
      return { passed: false, reason: "wip_when_complete_only" };
    }
  }

  return { passed: true, reason: null };
}

// ---------- Per-component scorers ----------

function _scoreTagMatches(fic, preferredTagMap) {
  const all = _collectAllTags(fic);
  const matched = [];
  let raw = 0;
  for (const t of all) {
    if (preferredTagMap.has(t)) {
      const w = preferredTagMap.get(t);
      raw += w;
      matched.push(t);
    }
  }
  return { matched, raw };
}

function _scoreFandomMatches(fic, preferredFandomMap) {
  const matched = [];
  let raw = 0;
  for (const f of fic.fandoms || []) {
    const key = String(f).toLowerCase();
    if (preferredFandomMap.has(key)) {
      raw += preferredFandomMap.get(key);
      matched.push(f);
    }
  }
  return { matched, raw };
}

function _scoreAuthorAffinity(fic, affinityMap) {
  const author = (fic.author || "").toLowerCase();
  const a = author ? affinityMap.get(author) : null;
  if (!a) return { reads: 0, score: 0 };

  // +1 per completed read by this author, capped at +5.
  let score = Math.min(a.ficsCompleted || 0, 5);

  // -5 for each negativeTagCombo entry that appears in this fic's tags.
  if (Array.isArray(a.negativeTagCombos) && a.negativeTagCombos.length > 0) {
    const fictags = _collectAllTags(fic);
    for (const combo of a.negativeTagCombos) {
      if (combo && fictags.has(String(combo).toLowerCase())) score -= 5;
    }
  }

  // Phase 8: manual penalty applied via the "I don't like this" → "Less of it"
  // path on an author. Defaults to 0 / undefined on every legacy record.
  score += a.manualPenalty || 0;

  return { reads: a.ficsCompleted || 0, score };
}

function _scorePopularity(fic) {
  const k = fic.kudos;
  if (!k || k <= 0) return { kudos: k || 0, score: 0 };
  // (log10(k) - 1) * 0.5 — smooth log curve.
  // k=50  → ~0.35  → 0.4
  // k=500 → ~0.85  → 0.9
  // k=5000→ ~1.35  → 1.4
  // k=50k → ~1.85  → 1.9
  // Capped at +3.
  const raw = Math.max(0, (Math.log10(k) - 1) * 0.5);
  const score = Math.min(3, _round1(raw));
  return { kudos: k, score };
}

function _scoreFreshness(fic) {
  if (fic.isComplete) return { state: "complete", score: 2 };
  if (!fic.lastUpdated) return { state: "wip_unknown", score: 0 };
  const updated = new Date(fic.lastUpdated);
  if (isNaN(updated.getTime())) return { state: "wip_unknown", score: 0 };
  const monthsAgo = (Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24 * 30);
  if (monthsAgo < 3) return { state: "wip_recent", score: 1 };
  if (monthsAgo < 12) return { state: "wip_stale", score: 0 };
  return { state: "wip_abandoned", score: -5 };
}

function _scoreJitter(rowType) {
  const range = ROW_TYPE_JITTER[rowType] != null ? ROW_TYPE_JITTER[rowType] : DEFAULT_JITTER;
  if (range === 0) return { range, score: 0 };
  const score = _round1((Math.random() * 2 - 1) * range);
  return { range, score };
}

function _scoreBehavioral(fic, settings, historyCount) {
  // Stub — real implementation lands in a later phase.
  const enabled = !!(
    settings &&
    settings.behavioralSignalsEnabled &&
    historyCount >= (settings.behavioralSignalsThreshold || 10)
  );
  return { enabled, score: 0 };
}

// ---------- Main entry: score one fic ----------

function scoreFic(fic, preferences, affinityMap, rowType, historyCount = 0, settings = {}) {
  const filter = hardFilter(fic, preferences);
  if (!filter.passed) {
    return {
      total: -Infinity,
      breakdown: {
        passed: false,
        rejectedReason: filter.reason,
        tagMatches:    null,
        fandomMatches: null,
        browsingStyle: null,
        authorAffinity: null,
        popularity:    null,
        freshness:     null,
        jitter:        null,
        behavioral:    null,
        total: -Infinity
      }
    };
  }

  const tagRaw = _scoreTagMatches(fic, preferences.preferredTagMap);
  const fandomRaw = _scoreFandomMatches(fic, preferences.preferredFandomMap);

  let tagApplied = tagRaw.raw;
  let fandomApplied = fandomRaw.raw;
  let boostedField = null;
  if (preferences.browsingStyle === "tags-first") {
    tagApplied = tagRaw.raw * BROWSING_STYLE_MULTIPLIER;
    boostedField = "tags";
  } else if (preferences.browsingStyle === "fandom-first") {
    fandomApplied = fandomRaw.raw * BROWSING_STYLE_MULTIPLIER;
    boostedField = "fandoms";
  }

  const tagMatches = {
    matched: tagRaw.matched,
    raw: tagRaw.raw,
    applied: _round1(tagApplied)
  };
  const fandomMatches = {
    matched: fandomRaw.matched,
    raw: fandomRaw.raw,
    applied: _round1(fandomApplied)
  };
  const browsingStyle = {
    mode: preferences.browsingStyle,
    multiplier: boostedField ? BROWSING_STYLE_MULTIPLIER : 1,
    boostedField
  };

  const authorAffinity = _scoreAuthorAffinity(fic, affinityMap);
  const popularity = _scorePopularity(fic);
  const freshness = _scoreFreshness(fic);
  const jitter = _scoreJitter(rowType);
  const behavioral = _scoreBehavioral(fic, settings, historyCount);

  const total = _round1(
    tagApplied +
    fandomApplied +
    authorAffinity.score +
    popularity.score +
    freshness.score +
    jitter.score +
    behavioral.score
  );

  return {
    total,
    breakdown: {
      passed: true,
      rejectedReason: null,
      tagMatches,
      fandomMatches,
      browsingStyle,
      authorAffinity,
      popularity,
      freshness,
      jitter,
      behavioral,
      total
    }
  };
}

// ---------- Snapshot loader ----------
//
// Pulls everything scoreFic needs from the DB, in a shape that's fast to use
// (Maps and Sets keyed by lowercase strings). Call once per scoring run, then
// hand the result to scoreFic for every fic.

async function loadScoringInputs() {
  const [preferred_tag, blocked_tag, preferred_fandom, blocked_author, structuralRecs, browsingStyleRec] =
    await Promise.all([
      getPreferencesByType("preferred_tag"),
      getPreferencesByType("blocked_tag"),
      getPreferencesByType("preferred_fandom"),
      getPreferencesByType("blocked_author"),
      getPreferencesByType("structural"),
      dbGet("preferences", "browsing_style")
    ]);

  const settings = await getSettings();
  const affinityList = await dbGetAll("authorAffinity");

  const preferredTagMap = new Map();
  for (const r of preferred_tag) preferredTagMap.set(String(r.value).toLowerCase(), r.weight);

  const blockedTagSet = new Set(blocked_tag.map(r => String(r.value).toLowerCase()));

  const preferredFandomMap = new Map();
  for (const r of preferred_fandom) preferredFandomMap.set(String(r.value).toLowerCase(), r.weight);

  const blockedAuthorSet = new Set(blocked_author.map(r => String(r.value).toLowerCase()));

  const affinityMap = new Map();
  for (const a of affinityList) affinityMap.set(String(a.author).toLowerCase(), a);

  return {
    preferences: {
      preferredTagMap,
      blockedTagSet,
      preferredFandomMap,
      blockedAuthorSet,
      structural: structuralRecs[0] || null,
      browsingStyle: browsingStyleRec ? browsingStyleRec.value : null
    },
    affinityMap,
    settings: settings || {}
  };
}

// ---------- Score all cached fics ----------
//
// Returns { results: [{ fic, score, breakdown }, ...sorted desc],
//           rejected: [{ fic, breakdown }, ...],
//           stats: { total, kept, rejected, ms } }

async function scoreAllCachedFics(rowType) {
  const t0 = performance.now();
  const inputs = await loadScoringInputs();
  const fics = await dbGetAll("ficCache");
  const historyCount = await dbCount("history");

  const results = [];
  const rejected = [];
  for (const fic of fics) {
    const { total, breakdown } = scoreFic(
      fic, inputs.preferences, inputs.affinityMap, rowType, historyCount, inputs.settings
    );
    if (breakdown.passed) {
      results.push({ fic, score: total, breakdown });
    } else {
      rejected.push({ fic, breakdown });
    }
  }
  results.sort((a, b) => b.score - a.score);

  const t1 = performance.now();
  return {
    results,
    rejected,
    inputs,
    stats: {
      total: fics.length,
      kept: results.length,
      rejected: rejected.length,
      ms: Math.round(t1 - t0)
    }
  };
}

// ---------- Multi-row helpers ----------
//
// Phase 7a: the feed has multiple rows, each scoring with its own rowType
// (and therefore its own jitter range). Hitting the DB once and scoring the
// in-memory fic list five times is cheaper than five separate DB pulls.

async function loadAllForScoring() {
  const t0 = performance.now();
  const inputs = await loadScoringInputs();
  const fics = await dbGetAll("ficCache");
  const historyCount = await dbCount("history");
  return { inputs, fics, historyCount, loadMs: Math.round(performance.now() - t0) };
}

function scoreAllWithData(rowType, data) {
  const t0 = performance.now();
  const { inputs, fics, historyCount } = data;
  const results = [];
  const rejected = [];
  for (const fic of fics) {
    const { total, breakdown } = scoreFic(
      fic, inputs.preferences, inputs.affinityMap, rowType, historyCount, inputs.settings
    );
    if (breakdown.passed) {
      results.push({ fic, score: total, breakdown });
    } else {
      rejected.push({ fic, breakdown });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return {
    results,
    rejected,
    inputs,
    stats: {
      total: fics.length,
      kept: results.length,
      rejected: rejected.length,
      ms: Math.round(performance.now() - t0)
    }
  };
}

// Score one fic by ficId (returns null if not in cache).
async function scoreOneCachedFic(ficId, rowType) {
  const fic = await dbGet("ficCache", ficId);
  if (!fic) return null;
  const inputs = await loadScoringInputs();
  const historyCount = await dbCount("history");
  const { total, breakdown } = scoreFic(
    fic, inputs.preferences, inputs.affinityMap, rowType, historyCount, inputs.settings
  );
  return { fic, score: total, breakdown };
}
