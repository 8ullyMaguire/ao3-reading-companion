'use strict';
// cache.js — the labelled cache (§48.5).
//
// Cached content is shown WITH ITS AGE and never presented as live. Two rules make that
// more than a comment: a stale hit is returned as `{stale: true, at}`, and the label is
// produced in one place so no caller can invent its own wording.
//
// It is a cache, not state (§48.5), so it lives in browser.storage.local rather than in
// the read-tracking store that db.js keeps.

const TTL_MS = 60 * 60 * 1000; // §48.5

let storage = null;

function setStorage(s) {
  storage = s;
}

function backing() {
  const s = storage || (typeof browser !== 'undefined' && browser.storage && browser.storage.local);
  if (!s) throw new Error('no storage available for the cache');
  return s;
}

/**
 * @returns {{data: any, at: number, stale: boolean}} `at` is when the data was fetched,
 *   so a caller can say how old it is. `stale` is true ONLY when a reload failed and the
 *   previous copy is being shown — never for a fresh hit.
 */
async function cached(key, loader, now = Date.now()) {
  const store = backing();
  const hit = (await store.get(key))[key];
  if (hit && now - hit.at < TTL_MS) return { data: hit.data, at: hit.at, stale: false };
  try {
    const data = await loader();
    const at = now;
    await store.set({ [key]: { data, at } });
    return { data, at, stale: false };
  } catch (err) {
    if (hit) return { data: hit.data, at: hit.at, stale: true };
    throw err;
  }
}

/** Whole units only: "cached 3 h ago" is honest, "cached 3.04 h ago" is noise. */
function ageText(at, now = Date.now()) {
  const secs = Math.max(0, Math.floor((now - at) / 1000));
  if (secs < 60) return `${secs} s`;
  if (secs < 3600) return `${Math.floor(secs / 60)} min`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h`;
  return `${Math.floor(secs / 86400)} d`;
}

/** The one place the §48.5 label is worded. Null when the entry is fresh. */
function staleLabel(entry, now = Date.now()) {
  return entry && entry.stale ? `cached ${ageText(entry.at, now)} ago` : null;
}

const cacheSurface = { TTL_MS, cached, ageText, staleLabel, setStorage };

if (typeof module !== 'undefined' && module.exports) module.exports = cacheSurface;
