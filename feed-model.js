'use strict';
// feed-model.js — the feed's render model, and the only place the server's payload becomes
// something the UI draws.
//
// §48.2 lives here as a property rather than a comment: **the order is the server's order,
// verbatim.** There is no score, no sort, no jitter and no row type in this file, and a
// work whose details or explanation are missing keeps its place in the list rather than
// being dropped or moved. A client that quietly re-ranked would be a second ranker, which
// is the one thing §48 forbids.
//
// Pure functions over plain data: no fetch, no DOM, no browser API. The client
// (lorehaven.js) does the talking; this decides what the result means.

/** §48.3: what the reader has already read, from the server's own history. */
function readSetFromHistory(history) {
  const rows = Array.isArray(history) ? history : (history && Array.isArray(history.items) ? history.items : []);
  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = row.work_id || row.workId || row.ficId || row.id;
    if (id) ids.add(String(id));
  }
  return ids;
}

/**
 * The recorded slot's reasons, in the server's own words. `available: false` means the
 * explanation could not be read — the caller renders that state; it must NOT substitute a
 * breakdown of its own, because a recomputed explanation is a plausible-looking lie (§33.3).
 */
function reasonFrom(explanation) {
  if (!explanation || typeof explanation !== 'object') {
    // Same keys as the available case, so a renderer never has to branch on presence: a
    // missing number is null, not undefined.
    return { available: false, lines: [], blendScore: null, servedAt: null, seededBy: null, recipeStage: null, tasteSignal: null };
  }
  const lines = [];
  for (const r of Array.isArray(explanation.reasons) ? explanation.reasons : []) {
    if (typeof r === 'string') { lines.push(r); continue; }
    if (!r || typeof r !== 'object') continue;
    // SlotReason's own fields, whichever the server populates: prefer a rendered sentence,
    // else the label, else the kind. Never invented, never reworded.
    const line = r.text || r.summary || r.label || r.kind || r.kind_str || r.reason;
    if (typeof line === 'string' && line.trim()) lines.push(line.trim());
  }
  if (explanation.instance_curation) lines.push(String(explanation.instance_curation));
  return {
    available: true,
    lines,
    blendScore: typeof explanation.blend_score === 'number' ? explanation.blend_score : null,
    servedAt: explanation.served_at || null,
    seededBy: explanation.seeded_by || null,
    recipeStage: explanation.recipe_stage || null,
    tasteSignal: explanation.taste_signal || null,
  };
}

/**
 * One feed entry. `work` is the server's own payload, passed through — this file does not
 * know which fields a card wants, and inventing or renaming them here is how a client
 * drifts from its server.
 */
function itemFrom({ item, work, read, explanation }) {
  const workId = item && item.work_id != null ? String(item.work_id) : null;
  return {
    workId,
    slotId: (item && item.slot_id) || null,
    fic: ficFrom(work, workId),  // null = details unavailable; the card says so
    read: !!read,
    reason: reasonFrom(explanation),
  };
}

/**
 * @param {{discovery: object, worksById?: object, history?: any, explanationsById?: object}} input
 * @returns {{sort: any, requestId: string|null, items: Array}} items in the server's order.
 */
function buildFeed({ discovery, worksById = {}, history = [], explanationsById = {} } = {}) {
  const items = (discovery && Array.isArray(discovery.items)) ? discovery.items : [];
  const read = readSetFromHistory(history);
  return {
    sort: discovery ? discovery.sort ?? null : null,
    requestId: (discovery && discovery.request_id) || null,
    items: items.map((item) => {
      const workId = item && item.work_id != null ? String(item.work_id) : null;
      return itemFrom({
        item,
        work: workId ? (worksById[workId] ?? null) : null,
        read: workId ? read.has(workId) : false,
        explanation: (item && item.slot_id && explanationsById[item.slot_id]) || null,
      });
    }),
  };
}

/**
 * The fields a card would like and the server's public work view simply does not carry, so
 * nothing can render them: `PublicWorkView` (routes/works.rs:236) has no tags of any kind
 * and no update time. `published_at` is NOT an update time and is never shown as one.
 * Named here, machine-readably, so a card states the absence instead of inventing a value.
 */
const MISSING_SERVER_FIELDS = ['fandoms', 'relationships', 'characters', 'freeformTags', 'warnings', 'lastUpdated'];

/**
 * One card's view of a work. Every value comes from the server's payload; nothing is
 * invented and nothing is silently defaulted. Absent stays absent:
 *   * `metrics` is null when the owner has switched public aggregates off (§9.5), so kudos
 *     and views are null rather than 0 — a 0 would claim nobody read it;
 *   * `publishedAt` is a publication time, kept under its own name.
 */
function ficFrom(work, workId) {
  if (!work || typeof work !== 'object') return null;
  const chapters = Array.isArray(work.chapters) ? work.chapters : [];
  const authors = Array.isArray(work.authors) ? work.authors : [];
  const nameOf = (a) => (a && (a.handle || a.pseud_handle || a.name || a.pseud || a.username)) || null;
  const metrics = work.metrics && typeof work.metrics === 'object' ? work.metrics : null;
  const words = chapters.reduce((n, c) => n + (typeof c?.word_count === 'number' ? c.word_count : 0), 0);
  return {
    ficId: String(work.id ?? work.work_id ?? workId),
    title: work.title ?? null,
    summary: work.summary ?? null,
    language: work.language ?? null,
    rating: work.rating ?? null,
    isComplete: work.completion === 'complete',   // exact match; the enum's other values are not completion
    completion: work.completion ?? null,
    publishedAt: work.published_at ?? null,
    author: nameOf(authors[0]),
    coauthors: authors.slice(1).map(nameOf).filter(Boolean),
    authorCount: authors.length,
    chapters: chapters.length || null,
    wordCount: words || null,
    // Counts, never averages; null when the owner disabled public aggregates.
    kudos: metrics ? metrics.kudos ?? null : null,
    hits: metrics ? metrics.views ?? null : null,
    bookmarks: metrics ? metrics.bookmarks ?? null : null,
    reviews: metrics ? metrics.reviews ?? null : null,
    ratingSummary: work.rating_summary ?? null,
    // §49.4: the top-rated rec note, as a SECOND summary — never a replacement.
    recBlurb: work.rec_blurb ?? null,
    raw: work,
  };
}

const feedModel = { buildFeed, itemFrom, reasonFrom, readSetFromHistory, ficFrom, MISSING_SERVER_FIELDS };

if (typeof module !== 'undefined' && module.exports) module.exports = feedModel;
