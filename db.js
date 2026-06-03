// db.js — IndexedDB layer for My AO3 Algorithm.
//
// Everything lives locally inside the user's Firefox profile.
// Nothing is ever sent to a server.
//
// Six stores ("drawers"):
//   preferences     — preferred/blocked tags, fandoms, blocked authors, structural prefs.
//                     Keyed by a composite string id like "preferred_tag:Slow Burn".
//                     Each record carries a `type` field for filtering.
//   history         — per-fic reading history, keyed by ficId.
//   ficCache        — per-fic scraped metadata, keyed by ficId.
//   authorAffinity  — per-author scoring data, keyed by author name.
//   customRows      — user-defined feed rows, keyed by rowName.
//   settings        — single record (id="main") holding all global settings.

const DB_NAME = "MyAO3Algorithm";
const DB_VERSION = 2;

const STORES = {
  PREFERENCES: "preferences",
  HISTORY: "history",
  FIC_CACHE: "ficCache",
  AUTHOR_AFFINITY: "authorAffinity",
  CUSTOM_ROWS: "customRows",
  SETTINGS: "settings",
  DISLIKE_HISTORY: "dislikeHistory"
};

const DEFAULT_SETTINGS = {
  id: "main",
  scrapeDelaySeconds: 10,
  backoffOn429: true,
  behavioralSignalsEnabled: false,
  behavioralSignalsThreshold: 10,
  historyRetentionDays: null,
  theme: "dark",
  scheduledPullIntervalHours: 8,
  // How many AO3 pages a single scheduled / manual pull may fetch. Higher =
  // wider coverage of the user's preferred tags/fandoms but slower refresh
  // (each request is spaced by scrapeDelaySeconds). On-open refresh ignores
  // this and uses a fixed cap of 3 to stay quick. Allowed: 3/6/10/15/20.
  pagesPerRefresh: 6,
  // Phase 12: scheduler state.
  // - lastScheduledPull: ISO timestamp of the last completed pull (any source —
  //   alarm, on-open, manual). Used by the on-open staleness check (4h gate).
  // - backoffOn429At: ISO timestamp of the most recent 429. While this is
  //   within 24h, scheduled and on-open pulls skip; manual refresh ignores it.
  // - scheduledPullsPaused: when true, the alarm-driven scheduled pull AND the
  //   daily subscriptions sync both skip. Manual refresh and on-open refresh
  //   still fire (those are explicit user actions).
  lastScheduledPull: null,
  backoffOn429At: null,
  scheduledPullsPaused: false,
  feedViewMode: "list",
  feedTextSize: "M",
  // Phase 7b: captured passively from any logged-in AO3 page the user visits.
  // Used to build the /users/<username>/subscriptions URL for background sync.
  ao3Username: null,
  subscriptionsLastSyncAt: null,
  // Phase 7d: one-time onboarding hint shown the first time the user clicks
  // "Set aside". Flipped to true after the toast is shown.
  hasSeenSetAsideExplanation: false,
  // Phase 8: persistent "Stop suggesting" flags for the dislike-pattern
  // detection prompt. Each key, when true, silences that pattern's suggestion
  // permanently. ratings is a per-rating object so the user can stop a single
  // rating's prompt without silencing all of them.
  dismissedPatternHints: {
    length_too_long: false,
    length_too_short: false,
    ratings: {}   // e.g. { "Mature": true }
  },
  // Phase 7a: which rows render, and in what order. Only the rows listed here
  // get evaluated; feed.js filters out unknown ids and appends any newly-added
  // built-in rows at the end on next load.
  feedRowConfig: [
    { id: "similar_to_tastes",    visible: true },
    { id: "your_authors",         visible: true },
    { id: "fresh_chapters",       visible: true },
    { id: "popular",              visible: true },
    { id: "hidden_gems",          visible: true },
    { id: "discover_new",         visible: true },
    { id: "completed_long_reads", visible: true }
  ]
};

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORES.PREFERENCES)) {
        const store = db.createObjectStore(STORES.PREFERENCES, { keyPath: "id" });
        store.createIndex("type", "type", { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.HISTORY)) {
        const store = db.createObjectStore(STORES.HISTORY, { keyPath: "ficId" });
        store.createIndex("lastOpened", "lastOpened", { unique: false });
        store.createIndex("author", "author", { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.FIC_CACHE)) {
        const store = db.createObjectStore(STORES.FIC_CACHE, { keyPath: "ficId" });
        store.createIndex("author", "author", { unique: false });
        store.createIndex("scrapedAt", "scrapedAt", { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.AUTHOR_AFFINITY)) {
        db.createObjectStore(STORES.AUTHOR_AFFINITY, { keyPath: "author" });
      }

      if (!db.objectStoreNames.contains(STORES.CUSTOM_ROWS)) {
        const store = db.createObjectStore(STORES.CUSTOM_ROWS, { keyPath: "rowName" });
        store.createIndex("position", "position", { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
        db.createObjectStore(STORES.SETTINGS, { keyPath: "id" });
      }

      // Phase 8: dislikeHistory. Auto-incrementing id so multiple dislikes on
      // the same fic over time keep separate records. Indexed by ficId so the
      // debug view + future preferences dashboard can pivot on a single fic,
      // and by timestamp for chronological listings.
      if (!db.objectStoreNames.contains(STORES.DISLIKE_HISTORY)) {
        const store = db.createObjectStore(STORES.DISLIKE_HISTORY, {
          keyPath: "id",
          autoIncrement: true
        });
        store.createIndex("ficId", "ficId", { unique: false });
        store.createIndex("timestamp", "timestamp", { unique: false });
      }
    };

    req.onsuccess = (event) => resolve(event.target.result);
    req.onerror = (event) => reject(event.target.error);
    req.onblocked = () => reject(new Error("openDB blocked — another tab has an older DB version open"));
  });
  return _dbPromise;
}

function _request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function _store(db, storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

// ---------- Generic CRUD ----------

async function dbAdd(storeName, record) {
  const db = await openDB();
  return _request(_store(db, storeName, "readwrite").add(record));
}

async function dbPut(storeName, record) {
  // put = upsert: insert if missing, replace if key exists.
  const db = await openDB();
  return _request(_store(db, storeName, "readwrite").put(record));
}

async function dbGet(storeName, key) {
  const db = await openDB();
  return _request(_store(db, storeName, "readonly").get(key));
}

async function dbGetAll(storeName) {
  const db = await openDB();
  return _request(_store(db, storeName, "readonly").getAll());
}

async function dbDelete(storeName, key) {
  const db = await openDB();
  return _request(_store(db, storeName, "readwrite").delete(key));
}

async function dbClear(storeName) {
  const db = await openDB();
  return _request(_store(db, storeName, "readwrite").clear());
}

async function dbCount(storeName) {
  const db = await openDB();
  return _request(_store(db, storeName, "readonly").count());
}

async function dbGetByIndex(storeName, indexName, value) {
  const db = await openDB();
  const idx = _store(db, storeName, "readonly").index(indexName);
  return _request(idx.getAll(value));
}

// ---------- Preference helpers ----------
//
// Composite IDs let us upsert by (type, value) without tracking auto-incremented IDs.

function _prefId(type, value) {
  return `${type}:${value}`;
}

async function setPreferredTag(value, weight, locked = false) {
  return dbPut(STORES.PREFERENCES, {
    id: _prefId("preferred_tag", value),
    type: "preferred_tag",
    value,
    weight,
    locked
  });
}

async function setBlockedTag(value) {
  return dbPut(STORES.PREFERENCES, {
    id: _prefId("blocked_tag", value),
    type: "blocked_tag",
    value
  });
}

async function setPreferredFandom(value, weight, locked = false) {
  return dbPut(STORES.PREFERENCES, {
    id: _prefId("preferred_fandom", value),
    type: "preferred_fandom",
    value,
    weight,
    locked
  });
}

async function setBlockedAuthor(value) {
  return dbPut(STORES.PREFERENCES, {
    id: _prefId("blocked_author", value),
    type: "blocked_author",
    value
  });
}

// ---------- Subscribed-authors sync (Phase 7b) ----------
//
// Stored in the preferences store as type "subscribed_author". Each record:
//   { id, type: "subscribed_author", value: username, pseud, firstSeen, lastConfirmed }
// syncSubscribedAuthors reconciles a fresh scrape against the stored list —
// preserves firstSeen on authors that are still subscribed, updates pseud +
// lastConfirmed, adds new ones, and removes authors that disappeared.

async function getSubscribedAuthors() {
  return getPreferencesByType("subscribed_author");
}

async function syncSubscribedAuthors(freshList) {
  // freshList: [{ username, pseud }]. Usernames are compared case-insensitively
  // because AO3 URLs preserve case but logins treat usernames as case-insensitive.
  const now = new Date().toISOString();
  const existing = await getPreferencesByType("subscribed_author");
  const existingByKey = new Map(existing.map(r => [String(r.value).toLowerCase(), r]));
  const freshByKey = new Map();
  for (const entry of freshList) {
    const key = String(entry.username).toLowerCase();
    if (!freshByKey.has(key)) freshByKey.set(key, entry);
  }

  let added = 0, updated = 0, removed = 0;

  for (const [key, entry] of freshByKey) {
    const prior = existingByKey.get(key);
    const record = {
      id: _prefId("subscribed_author", entry.username),
      type: "subscribed_author",
      value: entry.username,
      pseud: entry.pseud || entry.username,
      firstSeen: prior ? (prior.firstSeen || now) : now,
      lastConfirmed: now
    };
    await dbPut(STORES.PREFERENCES, record);
    if (prior) updated++; else added++;
  }

  for (const [key, record] of existingByKey) {
    if (!freshByKey.has(key)) {
      await dbDelete(STORES.PREFERENCES, record.id);
      removed++;
    }
  }

  return { added, updated, removed, total: freshByKey.size, syncedAt: now };
}

async function setStructuralPreferences(prefs) {
  // prefs: { minWords, maxWords, ratings: [], completeOnly }
  return dbPut(STORES.PREFERENCES, {
    id: "structural",
    type: "structural",
    ...prefs
  });
}

async function getPreferencesByType(type) {
  return dbGetByIndex(STORES.PREFERENCES, "type", type);
}

// Delete all records of a given type, then add the new ones.
// Useful when a screen edits a list (e.g. preferred fandoms): the user might
// have removed items, so we can't just upsert — we need to clear-and-rewrite.
async function replacePreferencesByType(type, records) {
  const existing = await getPreferencesByType(type);
  for (const rec of existing) {
    await dbDelete(STORES.PREFERENCES, rec.id);
  }
  for (const rec of records) {
    await dbPut(STORES.PREFERENCES, rec);
  }
}

// ---------- History state (Phase 7d) ----------
//
// Every history record carries a `state` field: "save_for_later" or "reading".
// Legacy records (pre-7d) have no state field — ensureHistoryState infers one
// from existing data without writing back (the caller can opt in to a write).
// Same inference is used by the feed and the background handlers so the two
// never disagree about a record's category.

const AUTO_PROMOTE_SCROLL_PCT = 15;
const AUTO_PROMOTE_MINUTES = 2;

function ensureHistoryState(record) {
  if (!record) return record;
  if (record.state === "save_for_later" || record.state === "reading") return record;
  // Legacy / migration path. Priority: onboarding-loved > met thresholds > default.
  if (record.userVerdict === "loved") {
    record.state = "reading";
  } else if ((record.maxScrollOnChapter || 0) > AUTO_PROMOTE_SCROLL_PCT ||
             (record.totalReadingTimeMinutes || 0) >= AUTO_PROMOTE_MINUTES) {
    record.state = "reading";
  } else {
    record.state = "save_for_later";
  }
  if (typeof record.autoPromoteBlocked !== "boolean") {
    record.autoPromoteBlocked = false;
  }
  return record;
}

function parseChaptersSnapshot(chaptersStr) {
  // "5/?" -> { current: 5, total: null }. "5/10" -> { current: 5, total: 10 }.
  if (!chaptersStr) return { current: null, total: null };
  const parts = String(chaptersStr).split("/").map(x => x.trim());
  const cur = parseInt(parts[0], 10);
  const total = parts[1] === "?" ? null : parseInt(parts[1], 10);
  return {
    current: Number.isFinite(cur) ? cur : null,
    total: Number.isFinite(total) ? total : null
  };
}

// ---------- Settings ----------

async function ensureDefaultSettings() {
  const existing = await dbGet(STORES.SETTINGS, "main");
  if (!existing) {
    await dbPut(STORES.SETTINGS, { ...DEFAULT_SETTINGS });
    return { created: true };
  }
  return { created: false };
}

async function resetSettingsToDefaults() {
  return dbPut(STORES.SETTINGS, { ...DEFAULT_SETTINGS });
}

async function getSettings() {
  return dbGet(STORES.SETTINGS, "main");
}

// ---------- Dislike history (Phase 8) ----------
//
// Each record represents one applied "I don't like this" action.
//   {
//     id              autoIncrement
//     ficId, title, author
//     timestamp       ISO string
//     reasons         structured array of what the user picked
//     changes         structured record of what was applied (used to undo)
//     canUndo         flips to false once the changes have been further
//                     modified — set lazily at undo time, not eagerly
//   }
//
// `changes` is an array of operations. Each op carries enough state to be
// reversed without consulting anything else. Op kinds:
//   { kind: "tag_weight",       value, prior, next }   prior=null if no record
//   { kind: "tag_block",        value, hadPreferred, priorWeight }
//   { kind: "author_penalty",   author, prior, next }
//   { kind: "author_block",     author }
//   { kind: "author_neg_combo", author, value }        appended to combos[]

async function addDislikeRecord(record) {
  const db = await openDB();
  const store = _store(db, STORES.DISLIKE_HISTORY, "readwrite");
  // store.add returns the auto-generated key.
  return _request(store.add(record));
}

async function listDislikeHistory(limit = 50) {
  const all = await dbGetAll(STORES.DISLIKE_HISTORY);
  // Newest first by timestamp; falls back to insertion-order id if timestamps tie.
  all.sort((a, b) => {
    const ta = a.timestamp || "";
    const tb = b.timestamp || "";
    if (tb !== ta) return tb.localeCompare(ta);
    return (b.id || 0) - (a.id || 0);
  });
  return all.slice(0, limit);
}

async function getDislikeRecord(id) {
  return dbGet(STORES.DISLIKE_HISTORY, id);
}

async function deleteDislikeRecord(id) {
  return dbDelete(STORES.DISLIKE_HISTORY, id);
}

async function updateDislikeRecord(record) {
  return dbPut(STORES.DISLIKE_HISTORY, record);
}

// Adjust an authorAffinity record's manualPenalty in-place. Seeds a new
// record if one doesn't exist (because an author the user hasn't read before
// can still be downweighted via the dislike flow).
async function bumpAuthorPenalty(author, delta) {
  const existing = await dbGet(STORES.AUTHOR_AFFINITY, author);
  const prior = (existing && typeof existing.manualPenalty === "number") ? existing.manualPenalty : 0;
  const next = prior + delta;
  const record = existing
    ? { ...existing, manualPenalty: next }
    : {
        author,
        ficsRead: 0,
        ficsCompleted: 0,
        averageReadingTime: null,
        affinityScore: 0,
        negativeTagCombos: [],
        manualPenalty: next
      };
  await dbPut(STORES.AUTHOR_AFFINITY, record);
  return { prior, next };
}

async function setAuthorPenalty(author, value) {
  const existing = await dbGet(STORES.AUTHOR_AFFINITY, author);
  const record = existing
    ? { ...existing, manualPenalty: value }
    : {
        author,
        ficsRead: 0,
        ficsCompleted: 0,
        averageReadingTime: null,
        affinityScore: 0,
        negativeTagCombos: [],
        manualPenalty: value
      };
  return dbPut(STORES.AUTHOR_AFFINITY, record);
}

async function appendAuthorNegCombo(author, tagValue) {
  const existing = await dbGet(STORES.AUTHOR_AFFINITY, author);
  const combos = Array.isArray(existing?.negativeTagCombos) ? [...existing.negativeTagCombos] : [];
  if (!combos.some(c => String(c).toLowerCase() === String(tagValue).toLowerCase())) {
    combos.push(tagValue);
  }
  const record = existing
    ? { ...existing, negativeTagCombos: combos }
    : {
        author,
        ficsRead: 0,
        ficsCompleted: 0,
        averageReadingTime: null,
        affinityScore: 0,
        negativeTagCombos: combos,
        manualPenalty: 0
      };
  return dbPut(STORES.AUTHOR_AFFINITY, record);
}

async function removeAuthorNegCombo(author, tagValue) {
  const existing = await dbGet(STORES.AUTHOR_AFFINITY, author);
  if (!existing) return;
  const combos = (existing.negativeTagCombos || []).filter(
    c => String(c).toLowerCase() !== String(tagValue).toLowerCase()
  );
  return dbPut(STORES.AUTHOR_AFFINITY, { ...existing, negativeTagCombos: combos });
}

async function getPreferredTagWeight(value) {
  // Returns the current numeric weight, or null if the tag isn't a preference.
  const rec = await dbGet(STORES.PREFERENCES, _prefId("preferred_tag", value));
  if (!rec) return null;
  return typeof rec.weight === "number" ? rec.weight : null;
}

async function deletePreferredTag(value) {
  return dbDelete(STORES.PREFERENCES, _prefId("preferred_tag", value));
}

async function deletePreferredFandom(value) {
  return dbDelete(STORES.PREFERENCES, _prefId("preferred_fandom", value));
}

async function deleteBlockedTag(value) {
  return dbDelete(STORES.PREFERENCES, _prefId("blocked_tag", value));
}

async function deleteBlockedAuthor(value) {
  return dbDelete(STORES.PREFERENCES, _prefId("blocked_author", value));
}

async function clearAllAuthorAffinity() {
  return dbClear(STORES.AUTHOR_AFFINITY);
}

// ---------- Custom feed rows (Phase 11) ----------
//
// User-defined rows that render in the feed alongside the built-ins.
// Records are keyed by `rowName` — a stable slug+timestamp ID that doesn't
// change when the user renames the row. The display title is a separate
// field. Schema:
//   {
//     rowName, title, description, icon, accent,
//     includeTags[], excludeTags[], includeFandoms[],
//     authorFilter, minWords, maxWords, ratings[], completeOnly,
//     excludeRead, sortBy,
//     createdAt, updatedAt
//   }

async function listCustomRows() {
  return dbGetAll(STORES.CUSTOM_ROWS);
}

async function setCustomRow(record) {
  return dbPut(STORES.CUSTOM_ROWS, record);
}

async function deleteCustomRow(rowName) {
  return dbDelete(STORES.CUSTOM_ROWS, rowName);
}
