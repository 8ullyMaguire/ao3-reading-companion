// feed.js — multi-row feed (Phase 7a + 7b + 7c).
//
// Seven rows today, each scored from the same cache with a row-specific
// filter + sort + jitter range:
//   Similar to your tastes, Your authors, Fresh chapters, Popular,
//   Hidden gems, Discover new, Completed long reads.
// Feed-wide controls (text size, list/grid, collapse-all, tag filter) apply
// across every row. Per-row controls (refresh, see-all) act on one row.

const TOP_N = 20;
const PREVIEW_COUNT = 6;
const SUMMARY_COLLAPSE_CHARS = 280;
const MAX_CHIPS = 10;
const MAX_FANDOMS = 4;

// The default row config — mirrors db.js DEFAULT_SETTINGS.feedRowConfig.
// Kept here so "Reset to defaults" in the manage-rows modal works without
// hitting the DB defaults object directly.
const DEFAULT_ROW_CONFIG = [
  { id: "similar_to_tastes",    visible: true },
  { id: "your_authors",         visible: true },
  { id: "fresh_chapters",       visible: true },
  { id: "popular",              visible: true },
  { id: "hidden_gems",          visible: true },
  { id: "discover_new",         visible: true },
  { id: "completed_long_reads", visible: true }
];

// "5/?" or "5/5" -> 5. Used by fresh_chapters to compare current chapters
// posted against the user's furthest-read chapter for this fic.
function parseChapterCurrent(chaptersStr) {
  if (!chaptersStr) return null;
  const first = String(chaptersStr).split("/")[0];
  const n = parseInt(first, 10);
  return Number.isFinite(n) ? n : null;
}

// ---------- Row definitions ----------
//
// Each row's buildResult(scoredItems, ctx) receives the fics already scored
// with this row's rowType (jitter is baked in) and returns
// { items: [...top N], anchor?, anchorDisplay? }.

const ROW_DEFINITIONS = {

  similar_to_tastes: {
    id: "similar_to_tastes",
    title: "Similar to your tastes",
    icon: "\u2665",        // ♥
    accent: "pink",
    subtitle: () => "Ranked by how well each fic matches your taste profile",
    rowType: "similar_to_tastes",
    buildResult: (scoredItems) => ({
      items: scoredItems.slice(0, TOP_N)
    }),
    emptyTitle: "Nothing matches your profile yet.",
    emptyBody: 'Browse <a href="https://archiveofourown.org/" target="_blank" rel="noopener">AO3</a> a little so the extension has something to score, or loosen up your blocked tags in Re-run setup.'
  },

  your_authors: {
    id: "your_authors",
    title: "Your authors",
    icon: "\u2712",        // ✒
    accent: "gold",
    subtitle: (ctx) => {
      const status = ctx.subscriptionsLastSyncAt
        ? `Synced ${formatAgo(ctx.subscriptionsLastSyncAt)}`
        : "Not synced yet";
      return `New works by authors you\u2019re subscribed to &middot; <span class="subs-sync-status">${escapeHtml(status)}</span> &middot; <button class="subs-sync-btn" type="button" data-action="subs-sync">Sync now</button>`;
    },
    rowType: "your_authors",
    buildResult: (_scoredItems, ctx) => {
      // Your Authors is not a scoring row — it's a straight author-filter on
      // ficCache, sorted by most recent update. Works are excluded if the user
      // already read them (history hit). Phase 7c will broaden "read" to
      // include passively-tracked visits; for now history = onboarded-loved.
      if (!ctx.subscribedAuthors || ctx.subscribedAuthors.size === 0) {
        return { items: [] };
      }
      const matches = ctx.allFics
        .filter(fic => fic && fic.author && ctx.subscribedAuthors.has(String(fic.author).toLowerCase()))
        .filter(fic => !ctx.historyFicIds.has(fic.ficId))
        .sort((a, b) => String(b.lastUpdated || "").localeCompare(String(a.lastUpdated || "")))
        .slice(0, TOP_N)
        .map(fic => ({
          fic,
          score: 0,
          breakdown: {
            passed: true,
            tagMatches: { matched: [], gainedPoints: 0 },
            fandomMatches: { matched: [], gainedPoints: 0 },
            authorAffinity: 0,
            kudos: 0, hits: 0, ratio: 0,
            reasons: ["From one of your subscribed authors."]
          }
        }));
      return { items: matches };
    },
    emptyTitle: "No works from your subscribed authors yet.",
    emptyBody: (ctx) => {
      const hasUsername = !!ctx.ao3Username;
      const subsUrl = hasUsername
        ? `https://archiveofourown.org/users/${encodeURIComponent(ctx.ao3Username)}/subscriptions?type=users`
        : "https://archiveofourown.org/";
      const hint = ctx.subscribedAuthors && ctx.subscribedAuthors.size > 0
        ? "You have subscriptions, but none of their works are in your cache yet. Try <strong>Sync now</strong> above or browse your subscribed authors on AO3."
        : "You don\u2019t have any AO3 subscriptions synced yet.";
      return `${hint} <a href="${subsUrl}" target="_blank" rel="noopener">Open AO3 subscriptions</a>.`;
    }
  },

  fresh_chapters: {
    id: "fresh_chapters",
    title: "Fresh chapters",
    icon: "\u26A1",        // ⚡
    accent: "electric",
    subtitle: () => "New chapters in ongoing fics you've already started",
    rowType: "fresh_chapters",
    buildResult: (_scoredItems, ctx) => {
      // Not a scoring row — we scan the history store for WIPs the user has
      // started, cross-reference ficCache for current chapter count, and keep
      // the ones where new chapters have posted since maxChapterRead.
      //
      // Filter gates (all must hold):
      //   - fic is in ficCache (ficByFicId map lookup)
      //   - fic.isComplete === false (only WIPs — completed fics never get "fresh")
      //   - history.state === "reading" (Phase 7d: save_for_later fics don't
      //     belong in a "you've already started" row; they haven't been read yet)
      //   - parseChapterCurrent(fic.chapters) > history.maxChapterRead
      //   - history.lastOpened within the last 90 days (stops ancient abandoned
      //     reads from clogging the row forever)
      //
      // Sort by fic.lastUpdated descending — the freshest new chapter first.
      const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const out = [];

      for (const [ficId, hist] of ctx.historyByFicId) {
        const fic = ctx.ficByFicId.get(ficId);
        if (!fic) continue;
        if (fic.isComplete !== false) continue;
        if (hist.state !== "reading") continue;

        const lastOpenedMs = Date.parse(hist.lastOpened || "");
        if (!lastOpenedMs || (now - lastOpenedMs) > NINETY_DAYS_MS) continue;

        const chaptersNow = parseChapterCurrent(fic.chapters);
        const max = Number(hist.maxChapterRead) || 0;
        if (chaptersNow == null || chaptersNow <= max) continue;

        const fresh = chaptersNow - max;
        out.push({
          fic,
          score: 0,
          breakdown: {
            passed: true,
            tagMatches: { matched: [], gainedPoints: 0 },
            fandomMatches: { matched: [], gainedPoints: 0 },
            authorAffinity: 0,
            kudos: 0, hits: 0, ratio: 0,
            reasons: [
              `${fresh} new chapter${fresh === 1 ? "" : "s"} since you last read this fic (you were on chapter ${max}).`
            ]
          }
        });
      }

      out.sort((a, b) => String(b.fic.lastUpdated || "").localeCompare(String(a.fic.lastUpdated || "")));
      return { items: out.slice(0, TOP_N) };
    },
    emptyTitle: "No fresh chapters right now.",
    emptyBody: "This row fills with ongoing fics you've started reading that have posted new chapters. Open a WIP on AO3 and the extension will start tracking your progress."
  },

  popular: {
    id: "popular",
    title: "Popular in your fandoms",
    icon: "\u2605",        // ★
    accent: "orange",
    subtitle: () => "Well-loved fics from fandoms and tags you care about",
    rowType: "popular",
    buildResult: (scoredItems) => {
      const filtered = scoredItems.filter(item => {
        const b = item.breakdown;
        return (b.tagMatches.matched.length > 0) || (b.fandomMatches.matched.length > 0);
      });
      // Sort by log10(kudos) — smooths so top 3 aren't always mega-fics.
      // Tiebreak on taste score, to prefer on-profile at equal popularity.
      filtered.sort((a, b) => {
        const ka = Math.log10(Math.max(1, a.fic.kudos || 0));
        const kb = Math.log10(Math.max(1, b.fic.kudos || 0));
        if (ka !== kb) return kb - ka;
        return b.score - a.score;
      });
      return { items: filtered.slice(0, TOP_N) };
    },
    emptyTitle: "No popular fics in your areas yet.",
    emptyBody: "Browse a few tag or fandom pages on AO3 and this row will populate from what the extension sees."
  },

  hidden_gems: {
    id: "hidden_gems",
    title: "Hidden gems",
    icon: "\u2666",        // ♦
    accent: "cyan",
    subtitle: () => "Under-loved fics with strong reader love",
    rowType: "hidden_gems",
    buildResult: (scoredItems) => {
      const filtered = scoredItems.filter(item => {
        const f = item.fic;
        const k = f.kudos || 0;
        const h = f.hits || 0;
        if (h <= 0) return false;
        if (k < 50 || k > 1000) return false;
        if (k / h < 0.10) return false;
        const b = item.breakdown;
        return (b.tagMatches.matched.length > 0) || (b.fandomMatches.matched.length > 0);
      });
      return { items: filtered.slice(0, TOP_N) };
    },
    emptyTitle: "No hidden gems yet.",
    emptyBody: "Hidden gems need fics with 50–1 000 kudos AND at least a 10% kudos-to-hits ratio in your fandoms/tags. Browse more on AO3 to gather candidates."
  },

  discover_new: {
    id: "discover_new",
    title: "Discover new",
    icon: "\u2727",        // ✧
    accent: "purple",
    subtitle: (ctx) =>
      ctx.anchorDisplay
        ? `Anchored by <span class="anchor-tag">${escapeHtml(ctx.anchorDisplay)}</span> — fics where your favorite tag lives in unfamiliar territory`
        : "Add more preferred tags (weight 3+) in setup so this row has something to anchor on",
    rowType: "discover_new",
    buildResult: (scoredItems, ctx) => {
      // Pick one preferred tag with weight >= 3 as the anchor each run.
      const strong = [...ctx.preferredTagMap.entries()].filter(([_, w]) => w >= 3);
      if (strong.length === 0) return { items: [] };
      const [anchorLower] = strong[Math.floor(Math.random() * strong.length)];
      const anchorDisplay = ctx.preferredTagDisplayByLower.get(anchorLower) || anchorLower;

      // Keep fics that have the anchor AND at most 1 other preferred-tag match.
      // That surfaces the anchor "in new company" rather than the usual cluster.
      const filtered = scoredItems.filter(item => {
        const fic = item.fic;
        const allTags = new Set();
        for (const arr of [fic.freeformTags, fic.relationships, fic.characters, fic.warnings]) {
          for (const t of arr || []) allTags.add(String(t).toLowerCase());
        }
        if (!allTags.has(anchorLower)) return false;
        let otherMatches = 0;
        for (const [t] of ctx.preferredTagMap) {
          if (t !== anchorLower && allTags.has(t)) {
            otherMatches++;
            if (otherMatches > 1) return false;
          }
        }
        return true;
      });
      return { items: filtered.slice(0, TOP_N), anchor: anchorLower, anchorDisplay };
    },
    emptyTitle: "Nothing to discover right now.",
    emptyBody: "This row rolls a random preferred tag each refresh and looks for fics where that tag stands alone. Add more preferred tags in setup or browse around to widen the pool, then hit ↻ Refresh on this row to re-roll."
  },

  completed_long_reads: {
    id: "completed_long_reads",
    title: "Completed long reads",
    icon: "\u25B2",        // ▲
    accent: "green",
    subtitle: () => "Finished epics (100,000+ words) that match your taste",
    rowType: "completed_long_reads",
    buildResult: (scoredItems) => {
      const filtered = scoredItems.filter(item => {
        const f = item.fic;
        if (!f.isComplete) return false;
        if ((f.wordCount || 0) < 100000) return false;
        const b = item.breakdown;
        return (b.tagMatches.matched.length > 0) || (b.fandomMatches.matched.length > 0);
      });
      return { items: filtered.slice(0, TOP_N) };
    },
    emptyTitle: "No long reads in cache yet.",
    emptyBody: "Complete 100 000+ word fics are rarer; keep browsing AO3 and they'll accumulate."
  }

};

// ---------- Custom rows (Phase 11) ----------
//
// Custom rows live in the customRows IndexedDB store. At feed boot we read
// them and synthesize ROW_DEFINITIONS entries for each, sharing one
// rowType ("custom_row") so they share the score cache. Each row's
// buildResult is generated from its filter record by makeCustomRowBuildResult.
//
// The icon + accent palette is fixed for v1: 8 preset combos that map to
// existing CSS classes (row-style-pink, row-style-cyan, etc.). Constraint
// over freedom — users can't make ugly mismatches.

const CUSTOM_ROW_PALETTE = [
  { icon: "♥", accent: "pink",     label: "Pink heart" },     // ♥
  { icon: "♦", accent: "cyan",     label: "Cyan diamond" },   // ♦
  { icon: "★", accent: "orange",   label: "Orange star" },    // ★
  { icon: "▲", accent: "green",    label: "Green triangle" }, // ▲
  { icon: "✧", accent: "purple",   label: "Purple sparkle" }, // ✧
  { icon: "✒", accent: "gold",     label: "Gold pen" },       // ✒
  { icon: "⚡", accent: "electric", label: "Electric bolt" },  // ⚡
  { icon: "❖", accent: "pink",     label: "Pink lozenge" }    // ❖
];

const DEFAULT_PALETTE_INDEX = 0;
const CUSTOM_ROW_TYPE = "custom_row";

let customRowsCache = [];   // raw records from DB, refreshed on load + save

// Tolerant reader for legacy debug-console records that wrote CSV strings.
// New records write arrays directly; old records get parsed on read so the
// rest of the pipeline can assume arrays.
function _csvToArray(v) {
  if (Array.isArray(v)) return v.slice();
  if (typeof v === "string" && v.trim()) {
    return v.split(",").map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function _normalizeCustomRow(rec) {
  const palette = CUSTOM_ROW_PALETTE.find(p => p.icon === rec.icon && p.accent === rec.accent)
               || CUSTOM_ROW_PALETTE[DEFAULT_PALETTE_INDEX];
  return {
    rowName: rec.rowName,
    title: rec.title || rec.rowName || "Untitled row",
    description: rec.description || "",
    icon: palette.icon,
    accent: palette.accent,
    includeTags: _csvToArray(rec.includeTags).map(s => String(s).toLowerCase()),
    excludeTags: _csvToArray(rec.excludeTags).map(s => String(s).toLowerCase()),
    includeFandoms: _csvToArray(rec.includeFandoms).map(s => String(s).toLowerCase()),
    authorFilter: rec.authorFilter ? String(rec.authorFilter).toLowerCase() : null,
    minWords: typeof rec.minWords === "number" ? rec.minWords : null,
    maxWords: typeof rec.maxWords === "number" ? rec.maxWords : null,
    ratings: Array.isArray(rec.ratings) && rec.ratings.length > 0
      ? rec.ratings
      : _csvToArray(rec.ratings).length > 0 ? _csvToArray(rec.ratings) : ["G","T","M","E","Not Rated"],
    completeOnly: !!rec.completeOnly,
    excludeRead: !!rec.excludeRead,
    sortBy: typeof rec.sortBy === "string" ? rec.sortBy : "relevance",
    createdAt: rec.createdAt || null,
    updatedAt: rec.updatedAt || null
  };
}

function makeCustomRowBuildResult(rec) {
  // Returns a buildResult(scoredItems, ctx) closure that filters by the
  // record's include/exclude rules + structural filters + author + history,
  // then sorts per the chosen mode. Operates on the global scored list, so
  // includeTags/excludeTags are pure filters — they don't reweight score.
  return function (scoredItems, ctx) {
    const allowedRatings = new Set(rec.ratings);
    const include = rec.includeTags;
    const exclude = rec.excludeTags;
    const fandoms = rec.includeFandoms;

    // Build per-fic tag set from the relevant tag categories. Cached on the
    // item to avoid recomputation if the same scored list is filtered by
    // multiple custom rows.
    function ficTagSet(fic) {
      const s = new Set();
      for (const arr of [fic.freeformTags, fic.relationships, fic.characters, fic.warnings]) {
        for (const t of arr || []) s.add(String(t).toLowerCase());
      }
      return s;
    }

    function ficFandomSet(fic) {
      const s = new Set();
      for (const f of fic.fandoms || []) s.add(String(f).toLowerCase());
      return s;
    }

    const filtered = scoredItems.filter(item => {
      const fic = item.fic;
      if (!fic) return false;

      // Structural filters (the row's own — overrides the user's global ones).
      if (rec.minWords != null && (fic.wordCount || 0) < rec.minWords) return false;
      if (rec.maxWords != null && (fic.wordCount || 0) > rec.maxWords) return false;
      if (rec.completeOnly && fic.isComplete !== true) return false;
      if (fic.rating != null && !allowedRatings.has(fic.rating)) return false;
      // Allow null rating only when "Not Rated" is in the allowed set.
      if (fic.rating == null && !allowedRatings.has("Not Rated")) return false;

      // Author filter — exact match, case-insensitive.
      if (rec.authorFilter && String(fic.author || "").toLowerCase() !== rec.authorFilter) {
        return false;
      }

      // Tag filters.
      if (include.length > 0 || exclude.length > 0) {
        const tags = ficTagSet(fic);
        for (const t of include) if (!tags.has(t)) return false;
        for (const t of exclude) if (tags.has(t)) return false;
      }

      // Fandom include — any-of match.
      if (fandoms.length > 0) {
        const fSet = ficFandomSet(fic);
        let hit = false;
        for (const f of fandoms) if (fSet.has(f)) { hit = true; break; }
        if (!hit) return false;
      }

      // Exclude-read filter — drop fics the user already has in history.
      if (rec.excludeRead && ctx.historyFicIds && ctx.historyFicIds.has(fic.ficId)) {
        return false;
      }

      return true;
    });

    // Sort. "relevance" uses the global score (already including jitter for
    // the custom_row rowType); the rest sort by ficCache fields directly.
    switch (rec.sortBy) {
      case "kudos":
        filtered.sort((a, b) => (b.fic.kudos || 0) - (a.fic.kudos || 0));
        break;
      case "hits":
        filtered.sort((a, b) => (b.fic.hits || 0) - (a.fic.hits || 0));
        break;
      case "words_desc":
        filtered.sort((a, b) => (b.fic.wordCount || 0) - (a.fic.wordCount || 0));
        break;
      case "words_asc":
        filtered.sort((a, b) => (a.fic.wordCount || 0) - (b.fic.wordCount || 0));
        break;
      case "recent":
        filtered.sort((a, b) => String(b.fic.lastUpdated || "").localeCompare(String(a.fic.lastUpdated || "")));
        break;
      case "random":
        // Independent random shuffle per refresh, even though all custom rows
        // share rowType="custom_row" and would otherwise sort identically.
        for (let i = filtered.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
        }
        break;
      case "relevance":
      default:
        // Default — score descending. The scoring layer already added jitter.
        filtered.sort((a, b) => b.score - a.score);
        break;
    }

    return { items: filtered.slice(0, TOP_N) };
  };
}

function synthesizeCustomRowDefinition(rec) {
  const norm = _normalizeCustomRow(rec);
  const def = {
    id: norm.rowName,
    title: norm.title,
    icon: norm.icon,
    accent: norm.accent,
    isCustom: true,
    rowName: norm.rowName,
    subtitle: () => norm.description ? escapeHtml(norm.description) : "Custom row",
    rowType: CUSTOM_ROW_TYPE,
    buildResult: makeCustomRowBuildResult(norm),
    emptyTitle: `No matches yet for ${norm.title}.`,
    // Body is a function so it can render the Edit link tied to this row's id.
    emptyBody: () =>
      `Try refreshing as your cache grows, or <button type="button" class="row-empty-edit-link" data-action="edit-custom-row" data-row-id="${escapeHtml(norm.rowName)}">edit the row's filters</button>.`
  };
  return def;
}

async function loadCustomRowsIntoDefinitions() {
  // Read all customRows from DB and graft them into ROW_DEFINITIONS so the
  // existing render pipeline picks them up. Called at boot AND after every
  // create/edit/delete so the in-memory map stays in sync with the DB.
  // We don't mutate built-ins — only add/replace custom row entries.
  let records = [];
  try { records = await listCustomRows(); } catch (e) { console.warn("loadCustomRows failed:", e); }
  customRowsCache = records || [];

  // Drop any previously-merged custom rows (.isCustom flag) before re-merging.
  for (const id of Object.keys(ROW_DEFINITIONS)) {
    if (ROW_DEFINITIONS[id] && ROW_DEFINITIONS[id].isCustom) delete ROW_DEFINITIONS[id];
  }

  for (const rec of customRowsCache) {
    if (!rec || !rec.rowName) continue;
    const def = synthesizeCustomRowDefinition(rec);
    ROW_DEFINITIONS[def.id] = def;
  }
}

// ---------- Runtime state ----------

const filterState = {
  selectedValue: null,            // lowercase string
  selectedDisplay: null,          // original-case label
  selectedKind: null,             // "tag" or "fandom"
  originalOrderByRow: {}          // rowId -> [ficId, ficId, ...]
};

const soloState = { rowId: null };

let scoringData = null;           // cached output of loadAllForScoring
let preferredTagMap = new Map();
let preferredFandomMap = new Map();
let preferredTagDisplayByLower = new Map();
let rowConfig = [];               // [{id, visible}], persisted in settings
const rowRuns = {};               // rowId -> last buildResult output

// ---------- Tiny helpers ----------

function $(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatAgo(isoString) {
  // Compact relative time for "Synced X ago" displays. Clamps to "just now" for
  // anything under a minute and falls back to the ISO date after a week.
  const t = Date.parse(isoString);
  if (!t) return "never";
  const diffMs = Date.now() - t;
  if (diffMs < 60_000) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return isoString.slice(0, 10);
}

function formatNumber(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString();
}

function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast" + (isError ? " error" : "");
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2400);
}

function ao3WorkUrl(ficId)   { return `https://archiveofourown.org/works/${encodeURIComponent(ficId)}`; }
function ao3UserUrl(username) { return `https://archiveofourown.org/users/${encodeURIComponent(username)}`; }

function ratingClass(rating) {
  if (rating === "G") return "r-G";
  if (rating === "T") return "r-T";
  if (rating === "M") return "r-M";
  if (rating === "E") return "r-E";
  return "r-NR";
}

function ratingShort(rating) {
  if (!rating) return "NR";
  if (rating === "Not Rated") return "NR";
  return rating;
}

function ratingBorderClass(rating) {
  if (rating === "G") return "rating-G";
  if (rating === "T") return "rating-T";
  if (rating === "M") return "rating-M";
  if (rating === "E") return "rating-E";
  return "rating-NR";
}

function ficMatchesFilter(fic, valueLower, kind) {
  if (kind === "fandom") {
    for (const f of fic.fandoms || []) {
      if (String(f).toLowerCase() === valueLower) return true;
    }
    return false;
  }
  for (const arr of [fic.freeformTags, fic.relationships, fic.characters, fic.warnings]) {
    for (const t of arr || []) {
      if (String(t).toLowerCase() === valueLower) return true;
    }
  }
  return false;
}

function sortByPreferenceThenAlpha(items, preferredMap, getText = x => x.text || x) {
  return [...items]
    .map(it => ({
      _orig: it,
      _text: getText(it),
      _weight: preferredMap.get(String(getText(it)).toLowerCase()) || 0
    }))
    .sort((a, b) => {
      const aPref = a._weight > 0;
      const bPref = b._weight > 0;
      if (aPref !== bPref) return aPref ? -1 : 1;
      if (aPref && bPref && b._weight !== a._weight) return b._weight - a._weight;
      return a._text.localeCompare(b._text);
    })
    .map(o => o._orig);
}

// ---------- Plain-language reason builders (unchanged from Phase 6) ----------

function buildMatchStrengthLabel(breakdown) {
  const tagN = breakdown.tagMatches?.matched.length || 0;
  const fanN = breakdown.fandomMatches?.matched.length || 0;
  const reads = breakdown.authorAffinity?.reads || 0;

  const parts = [];
  if (tagN > 0) parts.push(`${tagN} favorite tag${tagN === 1 ? "" : "s"}`);
  if (fanN > 0) parts.push(`${fanN} favorite fandom${fanN === 1 ? "" : "s"}`);
  if (reads > 0) parts.push(`an author you've read`);

  if (parts.length === 0) {
    return { kind: "variety", strength: "Variety pick", reasons: "kept the feed fresh" };
  }

  const totalHits = tagN + fanN + (reads > 0 ? 1 : 0);
  let strength;
  if (totalHits >= 5) strength = "Strong match";
  else if (totalHits >= 3) strength = "Good match";
  else strength = "Light match";

  return { kind: "match", strength, reasons: parts.join(" + ") };
}

// Reasons are either plain strings or { parts: [...] } objects.
// A "parts" entry is rendered as a sequence of text/chips so the modal can
// inline ♥ chips (matched tags) and accent chips (matched fandoms) right
// inside the sentence. Chips render as buttons that close the modal and
// filter the feed by that value — same behavior as chip clicks on cards.
function buildWhyReasons(item) {
  const b = item.breakdown;
  const reasons = [];

  if (b.tagMatches.matched.length > 0) {
    const n = b.tagMatches.matched.length;
    const parts = [{ text: `Matches ${n} of your favorite tag${n === 1 ? "" : "s"}: ` }];
    b.tagMatches.matched.forEach((t, i) => {
      if (i > 0) parts.push({ text: " " });
      parts.push({ chip: "tag", text: t });
    });
    parts.push({ text: "." });
    reasons.push({ parts });
  }

  if (b.fandomMatches.matched.length > 0) {
    const n = b.fandomMatches.matched.length;
    const parts = [{ text: `In ${n === 1 ? "one" : n} of your fandom${n === 1 ? "" : "s"}: ` }];
    b.fandomMatches.matched.forEach((f, i) => {
      if (i > 0) parts.push({ text: " " });
      parts.push({ chip: "fandom", text: f });
    });
    parts.push({ text: "." });
    reasons.push({ parts });
  }

  if (b.browsingStyle.boostedField) {
    const mode = b.browsingStyle.mode === "tags-first" ? "tags-first" : "fandom-first";
    reasons.push(`You told us you browse ${mode}, so ${b.browsingStyle.boostedField} matches got a ${b.browsingStyle.multiplier}× boost.`);
  }

  if (b.authorAffinity.reads > 0 && b.authorAffinity.score > 0) {
    const r = b.authorAffinity.reads;
    reasons.push(`You've completed ${r} fic${r === 1 ? "" : "s"} by this author before (+${b.authorAffinity.score}).`);
  } else if (b.authorAffinity.score < 0) {
    reasons.push(`This author often writes tags you skip, which lowered the score by ${-b.authorAffinity.score}.`);
  }

  if (b.popularity.score > 0) {
    const k = formatNumber(b.popularity.kudos);
    if (b.popularity.score >= 2) reasons.push(`Very popular — ${k} kudos (+${b.popularity.score}).`);
    else if (b.popularity.score >= 1) reasons.push(`Quite popular — ${k} kudos (+${b.popularity.score}).`);
    else reasons.push(`Has some traction — ${k} kudos (+${b.popularity.score}).`);
  }

  if (b.freshness.state === "complete") reasons.push("It's complete (+2).");
  else if (b.freshness.state === "wip_recent") reasons.push("Active WIP — updated in the last 3 months (+1).");
  else if (b.freshness.state === "wip_stale") reasons.push("WIP that hasn't updated in a while (no bonus or penalty).");
  else if (b.freshness.state === "wip_abandoned") reasons.push("WIP that hasn't updated in over a year — that hurt the score (-5).");

  if (Math.abs(b.jitter.score) >= 1) {
    if (b.jitter.score > 0) reasons.push(`A little randomness pushed it up by +${b.jitter.score}, to keep the feed varied.`);
    else reasons.push(`A little randomness pulled it down by ${b.jitter.score}, to keep the feed varied.`);
  }

  // Variety-pick fallback bullet removed in Phase 9 — the match-strength
  // line at the top already says "Variety pick — kept the feed fresh", so
  // repeating it in the bullet list was redundant.

  return reasons;
}

function formatBreakdownPlain(breakdown) {
  if (!breakdown.passed) return `REJECTED: ${breakdown.rejectedReason}`;
  const lines = [];
  const pad = (s) => s.padEnd(16, " ");
  const tm = breakdown.tagMatches;
  const fm = breakdown.fandomMatches;
  lines.push(`${pad("tagMatches:")}${tm.applied}  (raw ${tm.raw}, matched: ${tm.matched.join(", ") || "(none)"})`);
  lines.push(`${pad("fandomMatches:")}${fm.applied}  (raw ${fm.raw}, matched: ${fm.matched.join(", ") || "(none)"})`);
  const bs = breakdown.browsingStyle;
  lines.push(`${pad("browsingStyle:")}${bs.boostedField ? `${bs.multiplier}× on ${bs.boostedField}` : "no boost"}  (mode: ${bs.mode || "unset"})`);
  lines.push(`${pad("authorAffinity:")}${breakdown.authorAffinity.score}  (reads: ${breakdown.authorAffinity.reads})`);
  lines.push(`${pad("popularity:")}${breakdown.popularity.score}  (kudos: ${breakdown.popularity.kudos})`);
  lines.push(`${pad("freshness:")}${breakdown.freshness.score}  (${breakdown.freshness.state})`);
  lines.push(`${pad("jitter:")}${breakdown.jitter.score}  (range ±${breakdown.jitter.range})`);
  lines.push(`${pad("behavioral:")}${breakdown.behavioral.score}  (${breakdown.behavioral.enabled ? "enabled" : "stub/disabled"})`);
  lines.push(`\n${pad("total:")}${breakdown.total}`);
  return lines.join("\n");
}

// ---------- Card rendering (unchanged from Phase 6.5 polish) ----------

function summaryToParagraphs(summary) {
  if (!summary) return "";
  return summary
    .split(/\n{2,}|\r\n{2,}/)
    .map(p => `<p>${escapeHtml(p.trim())}</p>`)
    .join("");
}

function renderCard(item, preferredTagMapArg, preferredFandomMapArg) {
  const fic = item.fic;
  const b = item.breakdown;

  const card = document.createElement("article");
  card.className = `card ${ratingBorderClass(fic.rating)}`;
  card.dataset.ficId = fic.ficId;

  const matchedTags = new Set((b.tagMatches?.matched || []).map(t => t.toLowerCase()));
  const matchedFandoms = new Set((b.fandomMatches?.matched || []).map(t => t.toLowerCase()));

  const titleHtml = `
    <h3 class="card-title">
      <a href="${ao3WorkUrl(fic.ficId)}" target="_blank" rel="noopener">${escapeHtml(fic.title || "(untitled)")}</a>
    </h3>
    <p class="card-author">by ${
      fic.author
        ? `<a href="${ao3UserUrl(fic.author)}" target="_blank" rel="noopener">${escapeHtml(fic.authorPseud || fic.author)}</a>`
        : "<span>Anonymous</span>"
    }${
      fic.coauthors && fic.coauthors.length
        ? ` & ${fic.coauthors.map(c => escapeHtml(c)).join(", ")}`
        : ""
    }</p>
  `;

  let fandomsHtml = "";
  if (Array.isArray(fic.fandoms) && fic.fandoms.length) {
    const sortedFandoms = sortByPreferenceThenAlpha(
      fic.fandoms.map(f => ({ text: f })),
      preferredFandomMapArg || new Map()
    );
    const remaining = Math.max(0, sortedFandoms.length - MAX_FANDOMS);

    const parts = sortedFandoms.map((f, i) => {
      const lower = String(f.text).toLowerCase();
      const matched = matchedFandoms.has(lower);
      const overflow = i >= MAX_FANDOMS;
      const heart = matched ? `<span class="heart-mark">♥</span>` : "";
      const cls = `fandom-name${matched ? " matched" : ""}${overflow ? " overflow" : ""}`;
      return `<button type="button" class="${cls}" data-action="filter" data-filter-kind="fandom" data-filter-value="${escapeHtml(lower)}" data-filter-display="${escapeHtml(f.text)}">${heart}${escapeHtml(f.text)}</button>`;
    });
    if (remaining > 0) {
      parts.push(`<button type="button" class="fandoms-toggle" data-action="toggle-fandoms" data-collapsed-label="+${remaining} more" data-expanded-label="show fewer">+${remaining} more</button>`);
    }
    fandomsHtml = `<p class="card-fandoms fandoms-collapsed">${parts.join("")}</p>`;
  }

  const summaryText = fic.summary || "";
  const isLong = summaryText.length > SUMMARY_COLLAPSE_CHARS;
  const summaryHtml = summaryText
    ? `
      <div class="card-summary${isLong ? " collapsed" : ""}" data-collapsed="${isLong}">${summaryToParagraphs(summaryText)}</div>
      ${isLong ? `<button class="summary-toggle" data-action="expand-summary">Show more</button>` : ""}
    `
    : "";

  const chipSource = [
    ...(fic.relationships || []).map(t => ({ text: t, kind: "relationship" })),
    ...(fic.freeformTags || []).map(t => ({ text: t, kind: "freeform" }))
  ];
  const sortedChips = sortByPreferenceThenAlpha(chipSource, preferredTagMapArg || new Map());
  const remainingChips = Math.max(0, sortedChips.length - MAX_CHIPS);

  let tagsHtml = "";
  if (sortedChips.length) {
    const chipPieces = sortedChips.map((c, i) => {
      const tagLower = String(c.text).toLowerCase();
      const matched = matchedTags.has(tagLower);
      const overflow = i >= MAX_CHIPS;
      const cls = `chip ${c.kind}${matched ? " matched" : ""}${overflow ? " overflow" : ""}`;
      const heart = matched ? `<span class="heart-mark">♥</span>` : "";
      return `<button type="button" class="${cls}" data-action="filter" data-filter-kind="tag" data-filter-value="${escapeHtml(tagLower)}" data-filter-display="${escapeHtml(c.text)}">${heart}${escapeHtml(c.text)}</button>`;
    });
    if (remainingChips > 0) {
      chipPieces.push(`<button type="button" class="chip toggle-tags" data-action="toggle-tags" data-collapsed-label="+${remainingChips} more" data-expanded-label="Show fewer">+${remainingChips} more</button>`);
    }
    tagsHtml = `<div class="card-tags tags-collapsed">${chipPieces.join("")}</div>`;
  }

  const ratingBadge = `<span class="rating-badge ${ratingClass(fic.rating)}">${escapeHtml(ratingShort(fic.rating))}</span>`;
  const statsParts = [];
  if (fic.wordCount != null) statsParts.push(`<span class="stat"><span class="stat-value">${formatNumber(fic.wordCount)}</span><span class="stat-label">words</span></span>`);
  if (fic.chapters)         statsParts.push(`<span class="stat"><span class="stat-value">${escapeHtml(fic.chapters)}</span><span class="stat-label">chapters</span></span>`);
  if (fic.kudos != null)    statsParts.push(`<span class="stat"><span class="stat-value">${formatNumber(fic.kudos)}</span><span class="stat-label">kudos</span></span>`);
  if (fic.isComplete)       statsParts.push(`<span class="stat"><span class="stat-value">Complete</span></span>`);
  const statsHtml = `<div class="card-stats">${ratingBadge}${statsParts.join("")}</div>`;

  const m = buildMatchStrengthLabel(b);
  const matchHtml = `
    <div class="card-match${m.kind === "variety" ? " variety" : ""}">
      <span class="strength">${escapeHtml(m.strength)}</span>
      <span>— ${escapeHtml(m.reasons)}</span>
    </div>
  `;

  const actionsHtml = `
    <div class="card-actions">
      <button class="why" data-action="why">Why this?</button>
      <button class="dislike" data-action="dislike">I don't like this</button>
    </div>
  `;

  card.innerHTML = titleHtml + fandomsHtml + summaryHtml + tagsHtml + statsHtml + matchHtml + actionsHtml;
  card._item = item;
  return card;
}

// ---------- Per-row section builder ----------

function buildRowSection(def, result, ctx) {
  const section = document.createElement("section");
  section.className = `feed-row row-preview row-style-${def.accent}`;
  section.dataset.rowId = def.id;

  // ---- Row header
  const header = document.createElement("div");
  header.className = "feed-row-header";
  // Subtitle functions need the full ctx (subscriptionsLastSyncAt, ao3Username,
  // preferredTagDisplayByLower, etc.), plus the row-specific result fields.
  // Passing just { anchor, anchorDisplay } would starve your_authors' "Synced
  // Xm ago" indicator of its timestamp.
  const subtitleHtml = def.subtitle({
    ...ctx,
    anchor: result.anchor,
    anchorDisplay: result.anchorDisplay
  });
  const itemCount = result.items.length;
  const showSeeAll = itemCount > PREVIEW_COUNT;
  header.innerHTML = `
    <div class="feed-row-title-group">
      <h2 class="feed-row-title"><span class="row-icon" aria-hidden="true">${def.icon}</span>${escapeHtml(def.title)}</h2>
      <p class="feed-row-sub">${subtitleHtml}</p>
    </div>
    <div class="feed-row-controls">
      <button class="ghost row-refresh" type="button" data-action="row-refresh" title="Re-roll just this row">↻ Refresh</button>
      ${showSeeAll ? `<button class="ghost row-see-all" type="button" data-action="row-see-all">See all (${itemCount}) →</button>` : ""}
    </div>
  `;
  section.appendChild(header);

  // ---- Cards or empty state
  if (itemCount === 0) {
    const empty = document.createElement("div");
    empty.className = "row-empty";
    const bodyHtml = typeof def.emptyBody === "function" ? def.emptyBody(ctx) : def.emptyBody;
    empty.innerHTML = `
      <h4>${escapeHtml(def.emptyTitle)}</h4>
      <p>${bodyHtml}</p>
    `;
    section.appendChild(empty);
  } else {
    const cards = document.createElement("div");
    cards.className = "cards";
    for (const item of result.items) {
      cards.appendChild(renderCard(item, ctx.preferredTagMap, ctx.preferredFandomMap));
    }
    section.appendChild(cards);
  }

  return section;
}

// ---------- Scoring + rendering for all rows ----------

async function buildContext() {
  // Preferred-tag display map (original case) for the Discover New subtitle.
  // The scoring snapshot already has a lowercase-keyed weight map; this one
  // stores original casing so we can show "Enemies to Lovers" not "enemies to lovers".
  const prefTagRecs = await getPreferencesByType("preferred_tag");
  const display = new Map();
  for (const r of prefTagRecs) display.set(String(r.value).toLowerCase(), r.value);
  preferredTagDisplayByLower = display;

  preferredTagMap = scoringData.inputs.preferences.preferredTagMap;
  preferredFandomMap = scoringData.inputs.preferences.preferredFandomMap;

  // Phase 7b + 7c: row-specific lookup data pulled here so every buildResult
  // sees the same snapshot.
  //   subscribedAuthors   — set of lowercase usernames (Your authors)
  //   historyFicIds       — set of ficIds seen at least once (Your authors
  //                         exclude-already-read filter)
  //   historyByFicId      — Map<ficId, historyRecord> (Fresh chapters needs
  //                         the per-fic maxChapterRead + lastOpened)
  //   ficByFicId          — Map<ficId, fic> for O(1) lookups by id
  const subAuthorRecs = await getSubscribedAuthors();
  const subscribedAuthors = new Set(subAuthorRecs.map(r => String(r.value).toLowerCase()));
  const historyRecs = await dbGetAll("history");
  // Phase 7d: fill in state on legacy records without persisting. Feed rows
  // read `state` directly, and the inference is deterministic — same rule
  // runs in background.js when the next VISIT/TICK comes in, at which point
  // the record gets written back.
  for (const h of historyRecs) ensureHistoryState(h);
  const historyFicIds = new Set(historyRecs.map(h => h.ficId));
  const historyByFicId = new Map(historyRecs.map(h => [h.ficId, h]));
  const ficByFicId = new Map(scoringData.fics.map(f => [f.ficId, f]));
  const settings = (await getSettings()) || {};

  return {
    preferredTagMap,
    preferredFandomMap,
    preferredTagDisplayByLower,
    allFics: scoringData.fics,
    subscribedAuthors,
    historyFicIds,
    historyByFicId,
    ficByFicId,
    ao3Username: settings.ao3Username || null,
    subscriptionsLastSyncAt: settings.subscriptionsLastSyncAt || null
  };
}

// Rows whose entire purpose is to show fics the user has already read.
// `fresh_chapters` surfaces new chapters of works in progress, so filtering
// read fics out of it would delete the row. This is why the exemption lives
// here, by name, rather than as a side effect inside that row's own
// buildResult: a global "exclude read" boolean would have to either break
// fresh_chapters or leave the other six broken, and there is no single value
// of that boolean that is right for both.
const READ_EXEMPT_ROW_TYPES = new Set(["fresh_chapters"]);

// Remove already-read fics from a row's scored items.
//
// This is the whole fix, in one place, on purpose. The alternative is a
// filter inside each of the seven buildResult bodies: seven places to get
// right, and a row added later ships broken by default. Filtering at the one
// seam every row passes through means new rows are correct for free.
//
// `your_authors` is absent from the exemption list because it already does
// this itself (it filters ctx.allFics by historyFicIds, not scoredItems), so
// the two filters do not compose into anything harmful but the early return
// below keeps the common case cheap.
function excludeReadItems(scoredItems, ctx, rowType) {
  if (READ_EXEMPT_ROW_TYPES.has(rowType)) return scoredItems;
  if (!ctx || !ctx.historyFicIds || ctx.historyFicIds.size === 0) return scoredItems;
  return scoredItems.filter(it => !ctx.historyFicIds.has(it.fic.ficId));
}

async function renderAllRows() {
  const container = $("rows-container");
  container.innerHTML = "";
  resetFilterOrder();

  // Skeletons while we load — one block per configured visible row.
  const visibleRows = rowConfig.filter(r => r.visible && ROW_DEFINITIONS[r.id]);
  for (const r of visibleRows) {
    const def = ROW_DEFINITIONS[r.id];
    const placeholder = document.createElement("section");
    placeholder.className = `feed-row row-style-${def.accent}`;
    placeholder.dataset.rowId = r.id;
    placeholder.innerHTML = `
      <div class="feed-row-header">
        <div class="feed-row-title-group">
          <h2 class="feed-row-title"><span class="row-icon" aria-hidden="true">${def.icon}</span>${escapeHtml(def.title)}</h2>
          <p class="feed-row-sub">Loading…</p>
        </div>
      </div>
      <div class="cards">
        <div class="skeleton"><div class="sk-line title"></div><div class="sk-line author"></div><div class="sk-line summary"></div><div class="sk-line summary summary-2"></div><div class="sk-line summary summary-3"></div><div class="sk-line tags"></div></div>
      </div>
    `;
    container.appendChild(placeholder);
  }

  try {
    scoringData = await loadAllForScoring();
  } catch (e) {
    console.error("Scoring load failed:", e);
    container.innerHTML = `<div class="empty-state"><h3>Couldn't load your cache.</h3><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }

  const ctx = await buildContext();

  // Score once per unique rowType.
  const scoreCache = {};
  container.innerHTML = "";

  if (visibleRows.length === 0) {
    $("no-rows-state").hidden = false;
    return;
  }
  $("no-rows-state").hidden = true;

  for (const { id } of visibleRows) {
    const def = ROW_DEFINITIONS[id];
    if (!scoreCache[def.rowType]) {
      scoreCache[def.rowType] = scoreAllWithData(def.rowType, scoringData);
    }
    const scored = scoreCache[def.rowType].results;
    // Drop fics the user has already read before the row sees them. Reading a
    // fic is the strongest positive signal a reader can give, so the scoring
    // layer ranks read fics at the very top -- correctly, since that is what
    // the score means. But "you liked this" is not a recommendation, and
    // showing it back is the bug: five of the seven default rows were
    // rendering read fics they had never filtered.
    const result = def.buildResult(excludeReadItems(scored, ctx, def.rowType), ctx);
    rowRuns[id] = result;
    const section = buildRowSection(def, result, ctx);
    container.appendChild(section);
    filterState.originalOrderByRow[id] = result.items.map(i => i.fic.ficId);
  }

  // Empty-all collapse: if every visible row resolved to zero items (fresh
  // install with empty cache, for example), five nearly-identical "browse AO3"
  // boxes would be noise. Clear the row frames and show one clean message.
  const anyWithItems = Object.values(rowRuns).some(r => (r.items || []).length > 0);
  if (!anyWithItems) {
    container.innerHTML = "";
    $("no-rows-state").hidden = false;
  }

  // If solo mode was active before re-render, re-apply it.
  reapplySoloMode();
  // If a filter was active before re-render, re-apply it.
  if (filterState.selectedValue) applyFilterToAllRows();

  updateCollapseAllVisibility();
}

async function triggerManualSubsSync(button) {
  // Fires SYNC_SUBSCRIPTIONS to the background script. The background does
  // two network round-trips (Users tab, 10s wait, Works tab), so this can
  // take 15+ seconds. We disable the button and swap the label so the user
  // knows something is happening, then re-render on completion.
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Syncing\u2026";
  try {
    const reply = await browser.runtime.sendMessage({ type: "SYNC_SUBSCRIPTIONS" });
    if (reply && reply.reason === "no_username") {
      toast("Sync skipped: visit any AO3 page while logged in so we can detect your username, then try again.", true);
    } else if (reply && reply.reason === "logged_out") {
      toast("Sync skipped: you appear to be logged out of AO3.", true);
    } else if (reply && reply.ok) {
      const u = reply.users || {};
      toast(`Synced: ${u.total || 0} subscribed author${(u.total === 1) ? "" : "s"} (+${u.added || 0}, -${u.removed || 0})`);
    } else {
      toast("Sync failed \u2014 check the extension console for details.", true);
    }
  } catch (e) {
    console.error("SYNC_SUBSCRIPTIONS failed:", e);
    toast(`Sync failed: ${e.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
    // Re-render so Your Authors picks up the new subscribed list and the
    // "Synced Xh ago" text refreshes.
    await renderAllRows();
  }
}

async function refreshRow(rowId) {
  const def = ROW_DEFINITIONS[rowId];
  if (!def || !scoringData) return;

  const ctx = await buildContext();
  const scored = scoreAllWithData(def.rowType, scoringData).results;
  const result = def.buildResult(scored, ctx);
  rowRuns[rowId] = result;

  const oldSection = document.querySelector(`.feed-row[data-row-id="${rowId}"]`);
  if (!oldSection) return;

  const newSection = buildRowSection(def, result, ctx);
  if (oldSection.classList.contains("solo-target")) newSection.classList.add("solo-target");
  if (!oldSection.classList.contains("row-preview")) newSection.classList.remove("row-preview");

  oldSection.replaceWith(newSection);
  filterState.originalOrderByRow[rowId] = result.items.map(i => i.fic.ficId);

  if (filterState.selectedValue) applyFilterToAllRows();
  updateCollapseAllVisibility();
}

// ---------- Cross-row filter (highlight + reorder within each row) ----------

function applyFilterToAllRows() {
  const { selectedValue, selectedKind, selectedDisplay } = filterState;
  if (!selectedValue) return;

  document.body.classList.add("tag-active");
  $("tag-bar").hidden = false;
  $("tag-bar-label").textContent = `Filtering by ${selectedKind}:`;
  $("tag-bar-name").textContent = selectedDisplay;

  document.querySelectorAll(".feed-row").forEach(section => {
    reorderRowSection(section, selectedValue, selectedKind);
  });

  document.querySelectorAll("[data-filter-value]").forEach(el => {
    const matches = el.dataset.filterValue === selectedValue && el.dataset.filterKind === selectedKind;
    el.classList.toggle("selected", matches);
  });
}

function reorderRowSection(section, valueLower, kind) {
  const cardsContainer = section.querySelector(".cards");
  if (!cardsContainer) return;
  const cards = Array.from(cardsContainer.querySelectorAll(".card"));
  const matching = [];
  const others = [];
  for (const card of cards) {
    const fic = card._item?.fic;
    if (fic && ficMatchesFilter(fic, valueLower, kind)) {
      card.classList.add("tag-match");
      matching.push(card);
    } else {
      card.classList.remove("tag-match");
      others.push(card);
    }
  }
  for (const c of matching) cardsContainer.appendChild(c);
  for (const c of others) cardsContainer.appendChild(c);
}

function selectFilter(valueLower, display, kind) {
  filterState.selectedValue = valueLower;
  filterState.selectedDisplay = display;
  filterState.selectedKind = kind;
  // Reset DOM to original score order first so switching filters doesn't
  // leave stale orderings cascading across the "others" section.
  restoreOriginalOrder();
  applyFilterToAllRows();
}

function restoreOriginalOrder() {
  document.querySelectorAll(".feed-row").forEach(section => {
    const rowId = section.dataset.rowId;
    const order = filterState.originalOrderByRow[rowId];
    if (!order) return;
    const cardsContainer = section.querySelector(".cards");
    if (!cardsContainer) return;
    for (const ficId of order) {
      const card = cardsContainer.querySelector(`[data-fic-id="${CSS.escape(ficId)}"]`);
      if (card) cardsContainer.appendChild(card);
    }
  });
}

function clearFilter() {
  if (!filterState.selectedValue) return;
  filterState.selectedValue = null;
  filterState.selectedDisplay = null;
  filterState.selectedKind = null;
  document.body.classList.remove("tag-active");
  $("tag-bar").hidden = true;
  restoreOriginalOrder();
  document.querySelectorAll(".tag-match").forEach(c => c.classList.remove("tag-match"));
  document.querySelectorAll(".selected").forEach(c => c.classList.remove("selected"));
}

function resetFilterOrder() {
  filterState.originalOrderByRow = {};
}

// ---------- Solo "See all" mode ----------

function enterSoloMode(rowId) {
  const def = ROW_DEFINITIONS[rowId];
  if (!def) return;
  soloState.rowId = rowId;
  document.body.classList.add("solo-active");
  document.querySelectorAll(".feed-row").forEach(s => s.classList.remove("solo-target"));
  const section = document.querySelector(`.feed-row[data-row-id="${rowId}"]`);
  if (section) section.classList.add("solo-target");
  $("solo-bar-name").textContent = def.title;
  $("solo-bar").hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function exitSoloMode() {
  soloState.rowId = null;
  document.body.classList.remove("solo-active");
  document.querySelectorAll(".feed-row").forEach(s => s.classList.remove("solo-target"));
  $("solo-bar").hidden = true;
}

// Re-apply solo-target class after a full rerender (refresh-all, manage-rows
// changes). If the solo row is gone, exit solo mode cleanly.
function reapplySoloMode() {
  if (!soloState.rowId) return;
  const section = document.querySelector(`.feed-row[data-row-id="${soloState.rowId}"]`);
  if (section) {
    section.classList.add("solo-target");
  } else {
    exitSoloMode();
  }
}

// ---------- Collapse-all (scans every row) ----------

function isAnythingExpanded() {
  const root = $("rows-container");
  if (!root) return false;

  if (root.querySelector(".card.grid-expanded")) return true;

  for (const sum of root.querySelectorAll(".card-summary:not(.collapsed)")) {
    if (sum.parentElement.querySelector(".summary-toggle")) return true;
  }
  for (const t of root.querySelectorAll(".card-tags:not(.tags-collapsed)")) {
    if (t.querySelector(".chip.overflow")) return true;
  }
  for (const f of root.querySelectorAll(".card-fandoms:not(.fandoms-collapsed)")) {
    if (f.querySelector(".fandom-name.overflow")) return true;
  }
  return false;
}

function updateCollapseAllVisibility() {
  const btn = $("collapse-all-btn");
  if (!btn) return;
  btn.hidden = !isAnythingExpanded();
}

function collapseAll() {
  const root = $("rows-container");
  if (!root) return;

  root.querySelectorAll(".card-summary:not(.collapsed)").forEach(sum => {
    const toggle = sum.parentElement.querySelector(".summary-toggle");
    if (toggle) {
      sum.classList.add("collapsed");
      toggle.textContent = "Show more";
    }
  });

  root.querySelectorAll(".card-tags:not(.tags-collapsed)").forEach(t => {
    const toggle = t.querySelector(".chip.toggle-tags");
    if (toggle) {
      t.classList.add("tags-collapsed");
      toggle.textContent = toggle.dataset.collapsedLabel;
    }
  });

  root.querySelectorAll(".card-fandoms:not(.fandoms-collapsed)").forEach(f => {
    const toggle = f.querySelector(".fandoms-toggle");
    if (toggle) {
      f.classList.add("fandoms-collapsed");
      toggle.textContent = toggle.dataset.collapsedLabel;
    }
  });

  root.querySelectorAll(".card.grid-expanded").forEach(c => c.classList.remove("grid-expanded"));

  updateCollapseAllVisibility();
}

// ---------- Feed-wide event wiring ----------

function wireFeedEvents() {
  const root = $("rows-container");

  root.addEventListener("click", (ev) => {
    // Row-level actions first (live in the row header, outside any .card).
    const subsSyncBtn = ev.target.closest("[data-action='subs-sync']");
    if (subsSyncBtn) {
      ev.preventDefault();
      triggerManualSubsSync(subsSyncBtn);
      return;
    }

    const rowAction = ev.target.closest("[data-action='row-refresh'], [data-action='row-see-all']");
    if (rowAction) {
      const section = rowAction.closest(".feed-row");
      const rowId = section?.dataset.rowId;
      if (!rowId) return;
      if (rowAction.dataset.action === "row-refresh") {
        refreshRow(rowId);
      } else {
        enterSoloMode(rowId);
      }
      return;
    }

    // Custom row empty state: "edit the row's filters" link in the empty body.
    const editCustomBtn = ev.target.closest("[data-action='edit-custom-row']");
    if (editCustomBtn) {
      ev.preventDefault();
      const rowId = editCustomBtn.dataset.rowId;
      const rec = customRowsCache.find(r => r.rowName === rowId);
      if (rec) openRowBuilderModal(rec);
      return;
    }

    const card = ev.target.closest(".card");
    if (!card) return;

    const interactive = ev.target.closest("a, button, [data-action]");

    // GRID mode: clicking the card body (not a link/button) toggles expand.
    if (!interactive && document.body.classList.contains("view-grid")) {
      card.classList.toggle("grid-expanded");
      updateCollapseAllVisibility();
      return;
    }
    if (!interactive) return;

    const action = interactive.dataset.action;
    if (!action) return;

    if (action === "expand-summary") {
      const sum = card.querySelector(".card-summary");
      if (sum.classList.contains("collapsed")) {
        sum.classList.remove("collapsed");
        interactive.textContent = "Show less";
      } else {
        sum.classList.add("collapsed");
        interactive.textContent = "Show more";
      }
      updateCollapseAllVisibility();

    } else if (action === "filter") {
      ev.preventDefault();
      ev.stopPropagation();
      const value = interactive.dataset.filterValue;
      const display = interactive.dataset.filterDisplay;
      const kind = interactive.dataset.filterKind;
      if (filterState.selectedValue === value && filterState.selectedKind === kind) {
        clearFilter();
      } else {
        selectFilter(value, display, kind);
      }

    } else if (action === "toggle-tags") {
      const tagsRow = card.querySelector(".card-tags");
      const wasCollapsed = tagsRow.classList.contains("tags-collapsed");
      tagsRow.classList.toggle("tags-collapsed");
      interactive.textContent = wasCollapsed
        ? interactive.dataset.expandedLabel
        : interactive.dataset.collapsedLabel;
      updateCollapseAllVisibility();

    } else if (action === "toggle-fandoms") {
      const fandomsRow = card.querySelector(".card-fandoms");
      const wasCollapsed = fandomsRow.classList.contains("fandoms-collapsed");
      fandomsRow.classList.toggle("fandoms-collapsed");
      interactive.textContent = wasCollapsed
        ? interactive.dataset.expandedLabel
        : interactive.dataset.collapsedLabel;
      updateCollapseAllVisibility();

    } else if (action === "why") {
      openWhyModal(card._item);
    } else if (action === "dislike") {
      // Phase 8: open the dislike popover.
      // - Apply hides the card via class only — re-rendering immediately would
      //   risk the fic re-appearing if it still scores high enough, breaking
      //   the "hide immediately" guarantee. The card stays hidden until the
      //   user manually refreshes the row or refreshes all.
      // - Undo restores by re-rendering, which rebuilds at the now-reverted
      //   preference state so the card lands in its original position.
      window.openDislikePopover(card._item, card, {
        onApplied: () => { /* card already hidden via class */ },
        onUndone:  () => { renderAllRows(); }
      });
    }
  });
}

// ---------- View mode (List / Grid) — persisted, applies feed-wide ----------

async function loadViewMode() {
  try {
    const settings = await getSettings();
    return (settings && settings.feedViewMode === "grid") ? "grid" : "list";
  } catch {
    return "list";
  }
}

async function saveViewMode(mode) {
  try {
    const settings = (await getSettings()) || { id: "main" };
    settings.feedViewMode = mode;
    await dbPut("settings", settings);
  } catch (e) {
    console.warn("Could not save view mode:", e);
  }
}

function applyViewMode(mode) {
  document.body.classList.remove("view-list", "view-grid");
  document.body.classList.add(mode === "grid" ? "view-grid" : "view-list");
  document.querySelectorAll(".view-toggle-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === mode);
  });
  document.querySelectorAll(".card.grid-expanded").forEach(c => c.classList.remove("grid-expanded"));
  updateCollapseAllVisibility();
}

function wireViewToggle() {
  document.querySelectorAll(".view-toggle-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const mode = btn.dataset.view;
      applyViewMode(mode);
      await saveViewMode(mode);
    });
  });
}

// ---------- Text size (S / M / L) — persisted, applies feed-wide via :root ----------

async function loadTextSize() {
  try {
    const settings = await getSettings();
    const s = settings && settings.feedTextSize;
    return (s === "S" || s === "L") ? s : "M";
  } catch {
    return "M";
  }
}

async function saveTextSize(size) {
  try {
    const settings = (await getSettings()) || { id: "main" };
    settings.feedTextSize = size;
    await dbPut("settings", settings);
  } catch (e) {
    console.warn("Could not save text size:", e);
  }
}

function applyTextSize(size) {
  document.body.classList.remove("size-S", "size-M", "size-L");
  document.body.classList.add(`size-${size}`);
  document.querySelectorAll(".text-size-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.size === size);
  });
}

function wireTextSizeToggle() {
  document.querySelectorAll(".text-size-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const size = btn.dataset.size;
      applyTextSize(size);
      await saveTextSize(size);
    });
  });
}

// ---------- Row config (show/hide + order) ----------

async function loadRowConfig() {
  // Custom rows must be merged into ROW_DEFINITIONS BEFORE this runs so
  // their IDs survive the "drop unknown" filter. Boot order in init()
  // calls loadCustomRowsIntoDefinitions() before loadRowConfig().
  const settings = await getSettings();
  let saved = Array.isArray(settings?.feedRowConfig) ? settings.feedRowConfig : [];
  // Drop unknown row ids (future phases may rename or remove rows; custom
  // rows the user deleted also get pruned here).
  const known = saved.filter(r => r && r.id && ROW_DEFINITIONS[r.id])
                     .map(r => ({ id: r.id, visible: r.visible !== false }));
  // Append any rows that aren't yet in saved config — built-ins added after
  // a phase bump, plus newly-created custom rows. New rows append to the
  // bottom of the visible feed by design.
  const seen = new Set(known.map(r => r.id));
  for (const id of Object.keys(ROW_DEFINITIONS)) {
    if (!seen.has(id)) known.push({ id, visible: true });
  }
  rowConfig = known;
}

async function saveRowConfig() {
  try {
    const settings = (await getSettings()) || { id: "main" };
    settings.feedRowConfig = rowConfig.map(r => ({ id: r.id, visible: r.visible }));
    await dbPut("settings", settings);
  } catch (e) {
    console.warn("Could not save row config:", e);
  }
}

// ---------- Manage rows modal ----------

function renderManageRowsList() {
  const ul = $("manage-rows-list");
  ul.innerHTML = "";
  rowConfig.forEach((row) => {
    const def = ROW_DEFINITIONS[row.id];
    if (!def) return;
    const isCustom = !!def.isCustom;
    const li = document.createElement("li");
    li.dataset.rowId = row.id;
    // draggable is toggled on per-row by the mousedown handler when the
    // user grabs the .drag-handle, then reset on mouseup / dragend. Doing
    // it this way scopes drags to the handle without needing a target
    // check inside dragstart, which is unreliable across browsers because
    // dragstart's e.target is the <li>, not the inner span.
    if (!row.visible) li.classList.add("row-hidden");
    const customExtras = isCustom
      ? `
        <span class="row-custom-tag">Custom</span>
        <button class="manage-icon-btn" type="button" data-action="manage-edit" data-row-id="${escapeHtml(row.id)}" title="Edit row" aria-label="Edit row">✎</button>
        <button class="manage-icon-btn danger" type="button" data-action="manage-delete" data-row-id="${escapeHtml(row.id)}" title="Delete row" aria-label="Delete row">🗑</button>
      `
      : "";
    li.innerHTML = `
      <span class="drag-handle" title="Drag to reorder" aria-label="Drag to reorder">⋮⋮</span>
      <input type="checkbox" class="manage-checkbox" ${row.visible ? "checked" : ""} data-row-id="${escapeHtml(row.id)}" aria-label="Show ${escapeHtml(def.title)}" />
      <span class="row-icon-cell">${escapeHtml(def.icon || "")}</span>
      <span class="manage-row-label" title="${escapeHtml(def.title)}">${escapeHtml(def.title)}</span>
      ${customExtras}
    `;
    ul.appendChild(li);
  });
}

function openManageRowsModal() {
  renderManageRowsList();
  const modal = $("manage-rows-modal");
  modal.hidden = false;
  void modal.offsetWidth;
  modal.classList.add("is-open");
  document.body.style.overflow = "hidden";
  _manageRowsFocusRestore = setupModalFocus(modal);
}

function closeManageRowsModal() {
  $("manage-rows-modal").classList.remove("is-open");
  $("manage-rows-modal").hidden = true;
  document.body.style.overflow = "";
  if (_manageRowsFocusRestore) { _manageRowsFocusRestore(); _manageRowsFocusRestore = null; }
}

function wireManageRows() {
  $("manage-rows-btn").addEventListener("click", openManageRowsModal);
  $("manage-close").addEventListener("click", closeManageRowsModal);
  $("manage-done").addEventListener("click", closeManageRowsModal);

  $("manage-rows-modal").addEventListener("click", (ev) => {
    if (ev.target === $("manage-rows-modal")) closeManageRowsModal();
  });

  $("manage-reset").addEventListener("click", async () => {
    // Reset restores built-in order/visibility but does NOT delete custom
    // rows — those live in their own store and have their own delete flow.
    // Append any custom rows (still present in ROW_DEFINITIONS) to the bottom
    // so they don't visibly disappear from the list this session.
    rowConfig = DEFAULT_ROW_CONFIG.map(r => ({ ...r }));
    const seen = new Set(rowConfig.map(r => r.id));
    for (const id of Object.keys(ROW_DEFINITIONS)) {
      if (!seen.has(id) && ROW_DEFINITIONS[id].isCustom) {
        rowConfig.push({ id, visible: true });
      }
    }
    await saveRowConfig();
    renderManageRowsList();
    // If the user was in solo mode on a row that now might be hidden, exit.
    if (soloState.rowId) {
      const target = rowConfig.find(r => r.id === soloState.rowId);
      if (!target || !target.visible) exitSoloMode();
    }
    await renderAllRows();
  });

  $("manage-create-btn").addEventListener("click", () => {
    closeManageRowsModal();
    openRowBuilderModal(null);  // null = create mode
  });

  $("manage-rows-list").addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action]");
    if (!btn) return;
    const rowId = btn.dataset.rowId;
    const action = btn.dataset.action;

    if (action === "manage-edit") {
      const rec = customRowsCache.find(r => r.rowName === rowId);
      if (!rec) return;
      closeManageRowsModal();
      openRowBuilderModal(rec);
      return;
    }
    if (action === "manage-delete") {
      const def = ROW_DEFINITIONS[rowId];
      if (!confirm(`Delete the custom row "${def?.title || rowId}"? This can't be undone.`)) return;
      try {
        await deleteCustomRow(rowId);
        rowConfig = rowConfig.filter(r => r.id !== rowId);
        await saveRowConfig();
        await loadCustomRowsIntoDefinitions();
        renderManageRowsList();
        await renderAllRows();
      } catch (e) {
        console.error("delete custom row failed:", e);
      }
      return;
    }
  });

  // ---- Drag-and-drop reordering (Phase 11 polish) ----
  //
  // Replaces the previous up/down arrow buttons. Rows aren't draggable by
  // default — mousedown on .drag-handle flips draggable=true on the parent
  // <li>, mouseup/dragend flips it back. This scopes drags to the handle
  // without relying on dragstart's e.target (which is the <li> itself,
  // not the inner span the user actually grabbed, so a target-based check
  // fails and the drag silently aborts).
  //
  // Visual feedback: dragged row gets .dragging (opacity drop), the row
  // currently under the cursor gets .drag-over-above or .drag-over-below
  // depending on which half of it the cursor is in. CSS draws a thin
  // accent-coloured line at that edge as the insertion indicator.
  const list = $("manage-rows-list");
  let draggedRowId = null;

  function clearOverMarks() {
    list.querySelectorAll("li.drag-over-above, li.drag-over-below")
        .forEach(el => el.classList.remove("drag-over-above", "drag-over-below"));
  }

  function disarmAllDraggable() {
    list.querySelectorAll("li[draggable='true']").forEach(li => {
      li.removeAttribute("draggable");
    });
  }

  // Arm the parent <li> for dragging only while the user is engaging the
  // handle. Browsers check the draggable attribute at drag-init time, after
  // mousedown — so flipping it here lands in time.
  list.addEventListener("mousedown", (e) => {
    const handle = e.target.closest(".drag-handle");
    if (!handle) return;
    const li = handle.closest("li");
    if (li) li.setAttribute("draggable", "true");
  });

  // If the user mousedowns the handle but releases without dragging, no
  // dragend fires — clean up here. Listening on document so we still catch
  // releases outside the list (e.g. user releases over the modal backdrop).
  document.addEventListener("mouseup", disarmAllDraggable);

  list.addEventListener("dragstart", (e) => {
    const li = e.target.closest("li");
    if (!li || li.getAttribute("draggable") !== "true") {
      // Not handle-armed — abort. (Shouldn't fire because draggable is
      // false, but defensive.)
      e.preventDefault();
      return;
    }
    draggedRowId = li.dataset.rowId;
    li.classList.add("dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      // Some browsers require setData for drag to actually proceed.
      e.dataTransfer.setData("text/plain", draggedRowId || "");
    }
  });

  list.addEventListener("dragover", (e) => {
    if (!draggedRowId) return;
    const li = e.target.closest("li");
    if (!li || li.dataset.rowId === draggedRowId) {
      clearOverMarks();
      return;
    }
    e.preventDefault();  // required to allow drop
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rect = li.getBoundingClientRect();
    const above = (e.clientY - rect.top) < rect.height / 2;
    clearOverMarks();
    li.classList.add(above ? "drag-over-above" : "drag-over-below");
  });

  list.addEventListener("dragleave", (e) => {
    // dragleave fires constantly as the cursor moves between child
    // elements; only clear when leaving the list entirely.
    if (e.target === list || !list.contains(e.relatedTarget)) {
      clearOverMarks();
    }
  });

  list.addEventListener("drop", async (e) => {
    if (!draggedRowId) return;
    e.preventDefault();
    const li = e.target.closest("li");
    if (!li || li.dataset.rowId === draggedRowId) {
      clearOverMarks();
      return;
    }
    const rect = li.getBoundingClientRect();
    const above = (e.clientY - rect.top) < rect.height / 2;
    const targetRowId = li.dataset.rowId;

    const fromIdx = rowConfig.findIndex(r => r.id === draggedRowId);
    let toIdx = rowConfig.findIndex(r => r.id === targetRowId);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) {
      clearOverMarks();
      return;
    }
    // Splice out the dragged row, then re-insert at the new index. When
    // dropping below the target the insertion index is target+1, but if
    // the dragged row was earlier in the list, the splice already shifted
    // the target down by one — net adjustment is zero.
    const [moved] = rowConfig.splice(fromIdx, 1);
    if (fromIdx < toIdx) toIdx -= 1;  // compensate for the splice
    if (!above) toIdx += 1;
    rowConfig.splice(toIdx, 0, moved);

    clearOverMarks();
    await saveRowConfig();
    renderManageRowsList();
    await renderAllRows();
  });

  list.addEventListener("dragend", () => {
    list.querySelectorAll("li.dragging").forEach(el => el.classList.remove("dragging"));
    clearOverMarks();
    disarmAllDraggable();
    draggedRowId = null;
  });

  $("manage-rows-list").addEventListener("change", async (ev) => {
    const cb = ev.target.closest(".manage-checkbox");
    if (!cb) return;
    const rowId = cb.dataset.rowId;
    const row = rowConfig.find(r => r.id === rowId);
    if (!row) return;
    row.visible = cb.checked;
    await saveRowConfig();
    renderManageRowsList();
    // If the solo row just got hidden, exit solo mode.
    if (!row.visible && soloState.rowId === rowId) exitSoloMode();
    await renderAllRows();
  });
}

// ---------- Row builder modal (Phase 11) ----------
//
// Opens from the Manage Rows modal (sequentially, not stacked). Form is a
// single panel grouped into Basic / Filters / Display sections. Save writes
// to customRows, refreshes the in-memory definitions, and reopens Manage
// Rows so the user sees the new entry. Edit reuses the same modal pre-filled.
//
// Tag/fandom autocomplete is inlined here (matches the established
// preferences.js pattern of duplicating onboarding's logic for now).

let rowBuilderState = {
  editingRowName: null,
  includeTags: [],
  excludeTags: [],
  includeFandoms: [],
  paletteIndex: DEFAULT_PALETTE_INDEX
};

function _rbDebounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function rbFetchAutocomplete(endpoint, term) {
  const url = `https://archiveofourown.org/autocomplete/${endpoint}?term=${encodeURIComponent(term)}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15000);
  let resp;
  try {
    resp = await fetch(url, { credentials: "include", signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();
  let items = [];
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data)) {
      items = data.map(x => (typeof x === "string" ? x : (x?.name ?? x?.id))).filter(Boolean);
    }
  } catch {
    items = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }
  items = items.map(s => s.replace(/\s*\(\d+\)\s*$/, ""));
  const seen = new Set();
  return items.filter(s => seen.has(s) ? false : seen.add(s));
}

function rbSetupAutocomplete(inputId, dropdownId, endpoint, onSelect) {
  const input = $(inputId);
  const dropdown = $(dropdownId);
  if (!input || !dropdown || input.dataset.acWired === "true") return;
  input.dataset.acWired = "true";

  function hide() { dropdown.hidden = true; dropdown.innerHTML = ""; }
  function show(items) {
    dropdown.innerHTML = "";
    if (items.length === 0) {
      const div = document.createElement("div");
      div.className = "autocomplete-item empty";
      div.textContent = "No matches.";
      dropdown.appendChild(div);
    } else {
      for (const item of items) {
        const div = document.createElement("div");
        div.className = "autocomplete-item";
        div.textContent = item;
        div.addEventListener("mousedown", (e) => {
          e.preventDefault();
          onSelect(item);
          input.value = "";
          hide();
        });
        dropdown.appendChild(div);
      }
    }
    dropdown.hidden = false;
  }
  function showError(msg) {
    dropdown.innerHTML = "";
    const div = document.createElement("div");
    div.className = "autocomplete-item error";
    div.textContent = msg;
    dropdown.appendChild(div);
    dropdown.hidden = false;
  }

  const search = _rbDebounce(async (term) => {
    if (term.length < 2) return hide();
    try {
      const items = await rbFetchAutocomplete(endpoint, term);
      show(items);
    } catch (e) {
      showError(`Couldn't reach AO3 (${e.message}). Press Enter to add raw.`);
    }
  }, 280);

  input.addEventListener("input", () => search(input.value.trim()));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const v = input.value.trim();
      if (v.length > 0) {
        onSelect(v);
        input.value = "";
        hide();
      }
    } else if (e.key === "Escape") {
      hide();
    }
  });
  input.addEventListener("blur", () => setTimeout(hide, 150));
}

function rbRenderMulti(containerId, list) {
  const c = $(containerId);
  c.innerHTML = "";
  list.forEach((value, idx) => {
    const chip = document.createElement("span");
    chip.className = "rb-multi-chip";
    chip.textContent = value;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "rb-multi-chip-remove";
    x.textContent = "×";
    x.title = `Remove "${value}"`;
    x.addEventListener("click", () => {
      list.splice(idx, 1);
      rbRenderMulti(containerId, list);
    });
    chip.appendChild(x);
    c.appendChild(chip);
  });
}

function rbRenderPalette() {
  const grid = $("rb-palette");
  grid.innerHTML = "";
  CUSTOM_ROW_PALETTE.forEach((p, idx) => {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "rb-palette-cell row-style-" + p.accent + (idx === rowBuilderState.paletteIndex ? " is-selected" : "");
    cell.title = p.label;
    cell.textContent = p.icon;
    cell.style.color = `var(--row-${p.accent})`;
    cell.addEventListener("click", () => {
      rowBuilderState.paletteIndex = idx;
      rbRenderPalette();
    });
    grid.appendChild(cell);
  });
}

function rbResetForm() {
  rowBuilderState.editingRowName = null;
  rowBuilderState.includeTags = [];
  rowBuilderState.excludeTags = [];
  rowBuilderState.includeFandoms = [];
  rowBuilderState.paletteIndex = DEFAULT_PALETTE_INDEX;

  $("rb-title-input").value = "";
  $("rb-description-input").value = "";
  $("rb-author-input").value = "";
  $("rb-minwords").value = "";
  $("rb-maxwords").value = "";
  $("rb-complete-only").checked = false;
  $("rb-exclude-read").checked = false;
  $("rb-sortby").value = "relevance";
  Array.from(document.querySelectorAll(".rb-rating")).forEach(cb => { cb.checked = true; });
  $("rb-error").hidden = true;
  $("rb-error").textContent = "";
  rbUpdateAuthorHelp();

  rbRenderMulti("rb-include-tags", rowBuilderState.includeTags);
  rbRenderMulti("rb-exclude-tags", rowBuilderState.excludeTags);
  rbRenderMulti("rb-include-fandoms", rowBuilderState.includeFandoms);
  rbRenderPalette();
}

function rbPopulateForm(rec) {
  const norm = _normalizeCustomRow(rec);
  rowBuilderState.editingRowName = norm.rowName;
  rowBuilderState.includeTags = norm.includeTags.slice();
  rowBuilderState.excludeTags = norm.excludeTags.slice();
  rowBuilderState.includeFandoms = norm.includeFandoms.slice();
  rowBuilderState.paletteIndex = Math.max(0, CUSTOM_ROW_PALETTE.findIndex(p => p.icon === norm.icon && p.accent === norm.accent));

  $("rb-title-input").value = norm.title;
  $("rb-description-input").value = norm.description;
  $("rb-author-input").value = rec.authorFilter || "";
  $("rb-minwords").value = norm.minWords == null ? "" : String(norm.minWords);
  $("rb-maxwords").value = norm.maxWords == null ? "" : String(norm.maxWords);
  $("rb-complete-only").checked = norm.completeOnly;
  $("rb-exclude-read").checked = norm.excludeRead;
  $("rb-sortby").value = norm.sortBy;
  Array.from(document.querySelectorAll(".rb-rating")).forEach(cb => { cb.checked = norm.ratings.includes(cb.value); });
  $("rb-error").hidden = true;
  $("rb-error").textContent = "";
  rbUpdateAuthorHelp();

  rbRenderMulti("rb-include-tags", rowBuilderState.includeTags);
  rbRenderMulti("rb-exclude-tags", rowBuilderState.excludeTags);
  rbRenderMulti("rb-include-fandoms", rowBuilderState.includeFandoms);
  rbRenderPalette();
}

function rbUpdateAuthorHelp() {
  const author = $("rb-author-input").value.trim();
  $("rb-author-help").hidden = author.length === 0;
}

function _slugifyTitle(title) {
  return String(title || "row")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "row";
}

function _generateRowName(title) {
  // Stable slug + timestamp. Title can change later without renaming the key.
  return `${_slugifyTitle(title)}-${Date.now()}`;
}

function rbCollectFromForm() {
  const title = $("rb-title-input").value.trim();
  const description = $("rb-description-input").value.trim();
  const author = $("rb-author-input").value.trim();
  const minStr = $("rb-minwords").value;
  const maxStr = $("rb-maxwords").value;
  const ratings = Array.from(document.querySelectorAll(".rb-rating:checked")).map(cb => cb.value);
  const palette = CUSTOM_ROW_PALETTE[rowBuilderState.paletteIndex] || CUSTOM_ROW_PALETTE[0];

  return {
    title,
    description,
    author,
    minWords: minStr ? parseInt(minStr, 10) : null,
    maxWords: maxStr ? parseInt(maxStr, 10) : null,
    completeOnly: $("rb-complete-only").checked,
    excludeRead: $("rb-exclude-read").checked,
    sortBy: $("rb-sortby").value,
    ratings,
    icon: palette.icon,
    accent: palette.accent,
    includeTags: rowBuilderState.includeTags.slice(),
    excludeTags: rowBuilderState.excludeTags.slice(),
    includeFandoms: rowBuilderState.includeFandoms.slice()
  };
}

function _rbAddIfNew(list, value) {
  const v = String(value || "").trim();
  if (!v) return;
  const lower = v.toLowerCase();
  if (list.some(x => String(x).toLowerCase() === lower)) return;
  list.push(v);
}

async function rbSave() {
  const form = rbCollectFromForm();
  const errEl = $("rb-error");

  if (!form.title) {
    errEl.textContent = "Give the row a name.";
    errEl.hidden = false;
    return;
  }
  if (form.ratings.length === 0) {
    errEl.textContent = "Pick at least one rating.";
    errEl.hidden = false;
    return;
  }
  if (form.minWords != null && form.maxWords != null && form.minWords > form.maxWords) {
    errEl.textContent = "Min words must be less than or equal to max words.";
    errEl.hidden = false;
    return;
  }
  errEl.hidden = true;

  const isEditing = !!rowBuilderState.editingRowName;
  const now = new Date().toISOString();
  const rowName = isEditing ? rowBuilderState.editingRowName : _generateRowName(form.title);

  const record = {
    rowName,
    title: form.title,
    description: form.description,
    icon: form.icon,
    accent: form.accent,
    includeTags: form.includeTags,
    excludeTags: form.excludeTags,
    includeFandoms: form.includeFandoms,
    authorFilter: form.author || null,
    minWords: form.minWords,
    maxWords: form.maxWords,
    ratings: form.ratings,
    completeOnly: form.completeOnly,
    excludeRead: form.excludeRead,
    sortBy: form.sortBy,
    createdAt: isEditing ? undefined : now,
    updatedAt: now
  };

  // Preserve createdAt on edit by reading the existing record.
  if (isEditing) {
    const prior = customRowsCache.find(r => r.rowName === rowName);
    if (prior && prior.createdAt) record.createdAt = prior.createdAt;
  }

  try {
    await setCustomRow(record);
    await loadCustomRowsIntoDefinitions();

    // New row goes to the bottom of feedRowConfig (visible by default).
    if (!isEditing && !rowConfig.find(r => r.id === rowName)) {
      rowConfig.push({ id: rowName, visible: true });
      await saveRowConfig();
    }

    closeRowBuilderModal();
    openManageRowsModal();
    await renderAllRows();
  } catch (e) {
    console.error("save custom row failed:", e);
    errEl.textContent = `Save failed: ${e.message}`;
    errEl.hidden = false;
  }
}

function openRowBuilderModal(existingRecord) {
  if (existingRecord) {
    $("rb-title").textContent = "Edit custom row";
    $("rb-sub").textContent = "Update the row's filters and display options.";
    rbPopulateForm(existingRecord);
  } else {
    $("rb-title").textContent = "Create custom row";
    $("rb-sub").textContent = "Build a row that pulls fics matching your filters. Rows save to your local profile.";
    rbResetForm();
  }
  const modal = $("rowbuilder-modal");
  modal.hidden = false;
  void modal.offsetWidth;
  modal.classList.add("is-open");
  document.body.style.overflow = "hidden";
  _rowBuilderFocusRestore = setupModalFocus(modal);
}

function closeRowBuilderModal() {
  const modal = $("rowbuilder-modal");
  modal.classList.remove("is-open");
  modal.hidden = true;
  document.body.style.overflow = "";
  if (_rowBuilderFocusRestore) { _rowBuilderFocusRestore(); _rowBuilderFocusRestore = null; }
}

function wireRowBuilder() {
  rbSetupAutocomplete("rb-include-tag-input", "rb-include-tag-dropdown", "tag", v => {
    _rbAddIfNew(rowBuilderState.includeTags, v);
    rbRenderMulti("rb-include-tags", rowBuilderState.includeTags);
  });
  rbSetupAutocomplete("rb-exclude-tag-input", "rb-exclude-tag-dropdown", "tag", v => {
    _rbAddIfNew(rowBuilderState.excludeTags, v);
    rbRenderMulti("rb-exclude-tags", rowBuilderState.excludeTags);
  });
  rbSetupAutocomplete("rb-include-fandom-input", "rb-include-fandom-dropdown", "fandom", v => {
    _rbAddIfNew(rowBuilderState.includeFandoms, v);
    rbRenderMulti("rb-include-fandoms", rowBuilderState.includeFandoms);
  });

  $("rb-author-input").addEventListener("input", rbUpdateAuthorHelp);

  $("rb-cancel").addEventListener("click", () => {
    closeRowBuilderModal();
    openManageRowsModal();
  });
  $("rb-close").addEventListener("click", () => {
    closeRowBuilderModal();
    openManageRowsModal();
  });
  $("rb-save").addEventListener("click", rbSave);

  $("rowbuilder-modal").addEventListener("click", (ev) => {
    // Backdrop click closes — same pattern as the other modals on this page.
    if (ev.target === $("rowbuilder-modal")) {
      closeRowBuilderModal();
      openManageRowsModal();
    }
  });
}

// ---------- "Why this?" modal ----------

function renderReasonHtml(r) {
  // Plain string reason → escaped text.
  if (typeof r === "string") return escapeHtml(r);
  // Mixed reason: array of { text } and { chip, text } pieces.
  return r.parts.map(p => {
    if (p.chip === "tag") {
      const v = String(p.text).toLowerCase();
      return `<button type="button" class="modal-chip modal-chip-tag" data-modal-chip="tag" data-filter-value="${escapeHtml(v)}" data-filter-display="${escapeHtml(p.text)}"><span class="heart-mark">♥</span>${escapeHtml(p.text)}</button>`;
    }
    if (p.chip === "fandom") {
      const v = String(p.text).toLowerCase();
      return `<button type="button" class="modal-chip modal-chip-fandom" data-modal-chip="fandom" data-filter-value="${escapeHtml(v)}" data-filter-display="${escapeHtml(p.text)}">${escapeHtml(p.text)}</button>`;
    }
    return escapeHtml(p.text);
  }).join("");
}

// Phase 13 R2: shared focus management for the feed's three modals (and
// reused by the dislike popover via a separate copy in dislike.js). Captures
// the triggering element when a modal opens, moves focus into the dialog,
// traps Tab cycling inside it, and restores focus when it closes. Each
// open*Modal stores the cleanup and each close*Modal invokes it.
function _focusableInside(modalEl) {
  return Array.from(modalEl.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
    'select:not([disabled]), textarea:not([disabled]), summary, ' +
    '[tabindex]:not([tabindex="-1"])'
  )).filter(el => !el.hidden && el.offsetParent !== null);
}

function setupModalFocus(modalEl) {
  const previouslyFocused = document.activeElement;
  const focusables = _focusableInside(modalEl);
  if (focusables.length > 0) focusables[0].focus();
  else modalEl.querySelector(".modal")?.focus();

  function trapHandler(e) {
    if (e.key !== "Tab") return;
    const f = _focusableInside(modalEl);
    if (f.length === 0) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
  modalEl.addEventListener("keydown", trapHandler);

  return function restoreFocus() {
    modalEl.removeEventListener("keydown", trapHandler);
    if (previouslyFocused && typeof previouslyFocused.focus === "function" &&
        document.body.contains(previouslyFocused)) {
      previouslyFocused.focus();
    }
  };
}

let _whyModalFocusRestore = null;
let _manageRowsFocusRestore = null;
let _rowBuilderFocusRestore = null;

function openWhyModal(item) {
  const fic = item.fic;
  $("modal-fic-line").innerHTML =
    `<span class="fic-title">${escapeHtml(fic.title || "(untitled)")}</span> by ${escapeHtml(fic.authorPseud || fic.author || "Anonymous")}`;

  const m = buildMatchStrengthLabel(item.breakdown);
  const strengthEl = $("modal-match-strength");
  strengthEl.className = "modal-match-strength" + (m.kind === "variety" ? " variety" : "");
  strengthEl.innerHTML =
    `<span class="strength">${escapeHtml(m.strength)}</span> <span>— ${escapeHtml(m.reasons)}</span>`;

  const reasons = buildWhyReasons(item);
  const list = $("modal-reasons");
  const heading = document.querySelector("#why-modal .modal-h4");
  if (reasons.length === 0) {
    // Variety-pick with no other bullets — match-strength line at the top
    // already explains it. Hide the empty section instead of leaving a
    // dangling header above no content.
    list.hidden = true;
    if (heading) heading.hidden = true;
  } else {
    list.hidden = false;
    if (heading) heading.hidden = false;
    list.innerHTML = reasons
      .map(r => `<li><span class="marker">›</span>${renderReasonHtml(r)}</li>`)
      .join("");
  }

  $("modal-breakdown").textContent = formatBreakdownPlain(item.breakdown);

  const det = document.querySelector(".modal-numbers");
  if (det) det.open = false;

  const modal = $("why-modal");
  modal.hidden = false;
  // Force reflow then add .is-open so the CSS transition fires from
  // opacity 0 → 1 (and the modal slide-up). Toggling .hidden alone wouldn't
  // restart the transition reliably across reopens.
  void modal.offsetWidth;
  modal.classList.add("is-open");
  document.body.style.overflow = "hidden";
  _whyModalFocusRestore = setupModalFocus(modal);
}

function closeWhyModal() {
  $("why-modal").classList.remove("is-open");
  $("why-modal").hidden = true;
  document.body.style.overflow = "";
  if (_whyModalFocusRestore) { _whyModalFocusRestore(); _whyModalFocusRestore = null; }
}

function wireWhyModal() {
  $("modal-close").addEventListener("click", closeWhyModal);
  $("why-modal").addEventListener("click", (ev) => {
    // Chip click inside the modal: close, then apply the same feed-wide
    // filter that clicking a chip on a card would. Done via delegation so
    // we don't rebind every time openWhyModal rerenders the reasons list.
    const chipBtn = ev.target.closest("[data-modal-chip]");
    if (chipBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const value = chipBtn.dataset.filterValue;
      const display = chipBtn.dataset.filterDisplay;
      const kind = chipBtn.dataset.modalChip;  // "tag" or "fandom"
      closeWhyModal();
      selectFilter(value, display, kind);
      return;
    }
    if (ev.target === $("why-modal")) closeWhyModal();
  });
  // Esc: close whichever modal is open first; then collapse expansions; then exit solo mode.
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!$("why-modal").hidden) { closeWhyModal(); return; }
    // Row Builder sits on top of Manage Rows in the user's mental stack;
    // Esc closes it and reopens the Manage Rows modal it came from.
    if (!$("rowbuilder-modal").hidden) {
      closeRowBuilderModal();
      openManageRowsModal();
      return;
    }
    if (!$("manage-rows-modal").hidden) { closeManageRowsModal(); return; }
    if (isAnythingExpanded()) { collapseAll(); return; }
    if (soloState.rowId) { exitSoloMode(); return; }
  });
}

// ---------- Taste profile header ----------

async function renderTasteProfile() {
  try {
    const [fandoms, tags, blocked] = await Promise.all([
      getPreferencesByType("preferred_fandom"),
      getPreferencesByType("preferred_tag"),
      getPreferencesByType("blocked_tag")
    ]);
    const parts = [
      `${fandoms.length} fandom${fandoms.length === 1 ? "" : "s"}`,
      `${tags.length} tag${tags.length === 1 ? "" : "s"}`
    ];
    if (blocked.length > 0) parts.push(`${blocked.length} blocked`);
    $("taste-profile").textContent = `Your feed: ${parts.join(", ")}.`;
  } catch (e) {
    $("taste-profile").textContent = "Couldn't load taste profile.";
    console.error(e);
  }
}

// ---------- AO3 login check (cosmetic banner) ----------

async function checkLogin() {
  try {
    const result = await browser.runtime.sendMessage({ type: "CHECK_AO3_LOGIN" });
    if (result && result.loggedIn === false) {
      $("logout-banner").hidden = false;
    } else {
      $("logout-banner").hidden = true;
    }
  } catch (e) {
    console.warn("CHECK_AO3_LOGIN failed:", e);
  }
}

// ---------- Phase 13 R2: keyboard shortcuts ----------
//
// Esc closes whichever modal/expansion is open (already wired in
// wireWhyModal). `?` shows a small cheatsheet listing every shortcut the
// feed page supports. The cheatsheet defers to text-entry targets and any
// open modal, so it never interrupts the user.

function _isTextEntryTargetFeed(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  return false;
}

function _isAnyFeedModalOpen() {
  return !$("why-modal").hidden ||
         !$("manage-rows-modal").hidden ||
         !$("rowbuilder-modal").hidden;
}

function buildFeedShortcutsOverlay() {
  if (document.getElementById("shortcuts-overlay")) return;
  const backdrop = document.createElement("div");
  backdrop.id = "shortcuts-overlay";
  backdrop.className = "modal-backdrop is-open";
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" tabindex="-1">
      <button class="modal-close" id="shortcuts-close" type="button" aria-label="Close">&times;</button>
      <h2 id="shortcuts-title">Keyboard shortcuts</h2>
      <dl class="shortcuts-list">
        <div class="shortcut-row"><dt><kbd>?</kbd></dt><dd>Show this help</dd></div>
        <div class="shortcut-row"><dt><kbd>Esc</kbd></dt><dd>Close modal &middot; collapse expansions &middot; exit solo mode</dd></div>
      </dl>
    </div>
  `;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelector("#shortcuts-close").addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  backdrop.querySelector(".modal").focus();
}

function setupFeedKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (_isTextEntryTargetFeed(document.activeElement)) return;
    if (_isAnyFeedModalOpen()) return;
    if (document.getElementById("shortcuts-overlay")) return;
    if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
      e.preventDefault();
      buildFeedShortcutsOverlay();
    }
  });
}

// ---------- Boot ----------

(async function init() {
  // Header nav
  $("nav-debug").addEventListener("click", () => browser.tabs.create({ url: browser.runtime.getURL("debug.html") }));
  $("nav-rerun").addEventListener("click", () => browser.tabs.create({ url: browser.runtime.getURL("onboarding.html") }));
  $("nav-myreading").addEventListener("click", () => { window.location.href = "myreading.html"; });
  $("nav-preferences").addEventListener("click", () => { window.location.href = "preferences.html"; });
  $("nav-get-more").addEventListener("click", runGetMore);
  $("needs-setup-btn").addEventListener("click", () => browser.tabs.create({ url: browser.runtime.getURL("onboarding.html") }));
  $("no-rows-rerun").addEventListener("click", () => browser.tabs.create({ url: browser.runtime.getURL("onboarding.html") }));

  // Feed-wide toolbar
  $("refresh-all-btn").addEventListener("click", () => renderAllRows());
  $("collapse-all-btn").addEventListener("click", collapseAll);
  $("tag-bar-clear").addEventListener("click", clearFilter);
  $("solo-back-btn").addEventListener("click", exitSoloMode);

  // Delegated handlers live on #rows-container (cards) and #manage-rows-list.
  wireFeedEvents();
  wireManageRows();
  wireRowBuilder();
  wireWhyModal();
  wireViewToggle();
  wireTextSizeToggle();
  setupFeedKeyboardShortcuts();

  // Apply persisted UI prefs BEFORE the first paint so rows land right.
  const [mode, size] = await Promise.all([loadViewMode(), loadTextSize()]);
  applyViewMode(mode);
  applyTextSize(size);

  // Setup gate.
  let onboarding;
  try {
    onboarding = await dbGet("preferences", "onboarding");
  } catch (e) {
    console.error("Could not read onboarding state:", e);
  }
  if (!onboarding || !onboarding.completedAt) {
    $("feed-main").hidden = true;
    $("needs-setup").hidden = false;
    return;
  }

  $("nav-myreading").hidden = false;

  // Custom rows must be merged into ROW_DEFINITIONS before loadRowConfig
  // so their IDs survive its "drop unknown" filter.
  await loadCustomRowsIntoDefinitions();
  await loadRowConfig();
  renderTasteProfile();
  checkLogin();
  await renderAllRows();

  // Phase 12: on-open refresh. Fire-and-forget after the first render so the
  // user sees the existing cache instantly. Background's handler decides
  // whether to actually pull (only if >4h since last scheduled pull). If new
  // fics land and nothing is currently expanded / in solo / filtered,
  // auto-rerender so the user sees fresh data without a manual refresh.
  triggerOnOpenRefresh();
})();

async function triggerOnOpenRefresh() {
  const pill = $("refresh-pill");
  const pillText = $("refresh-pill-text");
  if (!pill || !pillText) return;
  pill.hidden = false;
  pill.classList.remove("is-done");
  pillText.textContent = "Refreshing…";

  let reply = null;
  try {
    reply = await browser.runtime.sendMessage({ type: "RUN_ONOPEN_REFRESH" });
  } catch (e) {
    console.warn("[My AO3 Algorithm] on-open refresh failed:", e);
  }

  // Hide pill quietly for outcomes that don't change what's on screen:
  // cache fresh, logged out, in flight, no targets, backoff active, or the
  // pull ran but returned only duplicates (saved === 0). No rerender needed
  // in any of those cases.
  const hasNewFics = reply && reply.ok && (reply.saved || 0) > 0;
  if (!hasNewFics) {
    pill.hidden = true;
    return;
  }

  // Auto-rerender path: only if nothing is expanded, no solo, no filter.
  // Otherwise show a "X new fics — refresh" pill the user can click.
  const safeToReRender = !isAnythingExpanded() && !soloState.rowId && !filterState.selectedValue;
  if (safeToReRender) {
    pill.classList.add("is-done");
    pillText.textContent = `Refreshed (+${reply.saved} new)`;
    await renderAllRows();
    setTimeout(() => { pill.hidden = true; }, 2500);
  } else {
    // User is mid-read — don't yank. Pill becomes a click target to refresh
    // when they're ready.
    pill.classList.add("is-done");
    pillText.textContent = `+${reply.saved} new fics — click to refresh`;
    pill.style.cursor = "pointer";
    pill.addEventListener("click", async function reRender() {
      pill.removeEventListener("click", reRender);
      pill.hidden = true;
      pill.style.cursor = "";
      await renderAllRows();
    }, { once: true });
  }
}

// "Get more" button — manual deep refresh. Disables the button, listens for
// progress broadcasts from the background, and toasts a count summary on
// completion. Auto-rerenders if nothing's expanded/in solo/filtered, same as
// on-open refresh.
let _getMoreInFlight = false;
async function runGetMore() {
  if (_getMoreInFlight) return;
  const btn = $("nav-get-more");
  const original = btn.textContent;
  _getMoreInFlight = true;
  btn.disabled = true;
  btn.textContent = "Getting more…";

  // Subscribe to PULL_PROGRESS broadcasts from background. Only count
  // "manual"-sourced events so an alarm pull that overlaps doesn't update
  // our button (which would be confusing). If the alarm has the guard, this
  // is moot — but cheap to be explicit.
  const progressListener = (msg) => {
    if (!msg || msg.type !== "PULL_PROGRESS" || msg.source !== "manual") return;
    btn.textContent = `Getting more… ${msg.current} of ${msg.total}`;
  };
  browser.runtime.onMessage.addListener(progressListener);

  let reply = null;
  try {
    reply = await browser.runtime.sendMessage({ type: "RUN_MANUAL_REFRESH" });
  } catch (e) {
    console.warn("[My AO3 Algorithm] Get more failed:", e);
    toast(`Get more failed: ${e.message}`, true);
  } finally {
    browser.runtime.onMessage.removeListener(progressListener);
    btn.disabled = false;
    btn.textContent = original;
    _getMoreInFlight = false;
  }

  if (!reply) return;
  if (reply.reason === "logged_out") {
    toast("Sign into AO3 first — I can't fetch fresh listings without your login session.", true);
    return;
  }
  if (!reply.ok) {
    toast("Get more didn't run — see console.", true);
    return;
  }
  const pull = reply.pull || {};
  if (pull.reason === "in_flight") {
    toast("Another refresh is already running — try again in a moment.", true);
    return;
  }
  if (pull.hit429) {
    toast("AO3 rate limit hit — wait a bit and try again.", true);
    return;
  }
  const saved = pull.saved || 0;
  const found = pull.found || 0;
  const errors = (pull.errors || []).length;
  const targets = pull.targets || 0;
  if (saved > 0) {
    toast(`Found ${saved} new fic${saved === 1 ? "" : "s"} (from ${found} scanned).`);
  } else if (found > 0) {
    toast(`No new fics — scanned ${found}, all already cached.`);
  } else if (errors > 0 && errors >= targets) {
    // Every target failed and nothing came back. Treat it as AO3-down rather
    // than a misleading "no new fics" message.
    toast("Couldn't reach AO3 right now — try again in a bit.", true);
  } else {
    toast("No new fics found.");
  }

  // Auto-rerender only if it's safe (nothing expanded, no solo, no filter).
  // Otherwise the user is mid-read and we shouldn't yank the layout.
  const safeToReRender = !isAnythingExpanded() && !soloState.rowId && !filterState.selectedValue;
  if (saved > 0 && safeToReRender) {
    await renderAllRows();
  }
}
