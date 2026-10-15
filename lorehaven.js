'use strict';
// lorehaven.js — the only file in this extension that calls fetch (§48.2).
//
// The extension holds no ranker and no taste store: Lorehaven's server decides what is
// shown, and this client is the whole of the extension's view of it. Two rules from §48.5
// are enforced here rather than documented and hoped for:
//
//   1. Every request asserts its target origin, and api() refuses anything that is not a
//      PATH. Concatenating a caller-supplied URL onto the base and then checking the
//      result is not a check: `new URL('https://basehttps://evil.example/')` parses as a
//      path on the configured origin and the credentials ride along. A path-only client
//      cannot be aimed anywhere.
//   2. Non-safe methods carry `x-csrf-token`. The token is READ, SENT, FORGOTTEN — never
//      stored, never logged.
//
// Why there is no impression-reporting function: the server records the slot it served
// (routes/discovery.rs calls recommendation_slots::record_response for every item), so an
// impression the extension invented would be a second, competing record of what was shown.
// The plan's §47 blocker ("log_impression has no route") is answered by a better mechanism
// on the server side, not by a route.

const SESSION_COOKIE = 'lorehaven_session'; // lorehaven auth.rs:36
const CSRF_COOKIE = 'lorehaven_csrf';       // lorehaven auth.rs:39
const CSRF_HEADER = 'x-csrf-token';         // lorehaven auth.rs:42
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

let configuredBase = null;
let cookieReader = readCookieFromBrowser;

function setBaseUrl(base) {
  configuredBase = base || null;
}

/** Test seam: Node has neither `browser` nor an instance to read cookies from. */
function setCookieReader(fn) {
  cookieReader = fn || readCookieFromBrowser;
}

function configuredOrigin() {
  if (!configuredBase) throw new Error('No Lorehaven instance configured (§48.5)');
  return new URL(configuredBase).origin;
}

function assertConfiguredOrigin(url) {
  if (new URL(url).origin !== configuredOrigin()) {
    throw new Error('Refusing to send credentials off-instance (§48.5)');
  }
}

/**
 * The instance's cookies are NOT visible to `document.cookie` from an extension
 * background page: they belong to the instance's origin and this document's origin is
 * moz-extension://. The plan's sketch reads document.cookie; that cannot work here, so the
 * WebExtension cookies API is used and `cookies` is requested in the manifest.
 */
async function readCookieFromBrowser(name, url) {
  if (typeof browser === 'undefined' || !browser.cookies) {
    throw new Error(`the cookies API is unavailable, so ${name} cannot be read`);
  }
  const hit = await browser.cookies.get({ url, name });
  return hit ? hit.value : null;
}

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * ONE rule: a request goes to the configured origin or it does not go. A caller may pass a
 * path or a URL; `//host/x` is protocol-relative and names another host while looking like
 * a path, so it is resolved rather than concatenated — and then the same guard decides.
 *
 * Written this way on purpose: a version that only refused inputs which "looked like URLs"
 * would make assertConfiguredOrigin dead code, and a guard nothing can reach is a guard
 * that cannot fail a test.
 */
// Every id a caller passes becomes ONE path segment, never a path. The server's own payload
// carries the slot ids this client loops over, so an id containing "/" or ".." must not be
// able to climb out of the route it belongs to — encodeURIComponent at each call site, and
// the origin guard behind them as the second line of defence.
function apiUrl(target) {
  if (typeof target !== 'string' || target === '') {
    throw new Error('api() needs a path or a URL');
  }
  const resolved = ABSOLUTE.test(target) || target.startsWith('//') ? target : configuredOrigin() + target;
  const url = new URL(resolved, configuredOrigin()).href;
  assertConfiguredOrigin(url);
  return url;
}

async function api(path, { method = 'GET', body } = {}) {
  const url = apiUrl(path);
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (!SAFE_METHODS.includes(method)) {
    const csrf = await cookieReader(CSRF_COOKIE, url);
    if (csrf) headers[CSRF_HEADER] = csrf;
  }
  const res = await fetch(url, {
    method,
    headers,
    credentials: 'include', // the session cookie, and nothing else
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// --- the surface §48 needs. Every route is the one verified in docs/PLAN.md §1. ---

const getFeed = () => api('/api/v1/discovery');
const getTasteVector = () => api('/api/v1/discovery/taste-profile/me');
const getHistory = () => api('/api/v1/library/history');
// reading.rs:56-58, verified: GET /library/history, POST /library/history/clear,
// DELETE /library/history/{id}. (An earlier revision of this client had a DELETE on the
// collection, which is not a route — the plan's table said collection-level DELETE and the
// route table says otherwise. The route table wins.)
const clearHistory = () => api('/api/v1/library/history/clear', { method: 'POST' });
const deleteHistoryEntry = (id) => api(`/api/v1/library/history/${encodeURIComponent(id)}`, { method: 'DELETE' });
/**
 * §33.3 / M29: WHY a work was served, read from the RECORDED slot —
 * GET /api/v1/discovery/slots/{slot_id}/explanation ->
 * {slot_id, work_id, position, reasons[], taste_signal?, seeded_by?, recipe_stage?,
 *  instance_curation?, blend_score, served_at}. The plan's §48.3 called this "no endpoint";
 * it exists, and the discovery response already stamps each item with its slot_id, so the
 * extension can show the reader real reasons rather than a stated absence.
 */
const explainSlot = (slotId) => api(`/api/v1/discovery/slots/${encodeURIComponent(slotId)}/explanation`);
const getNotes = () => api('/api/v1/notes');
// NoteRequest is {subject_type, subject_id, anchor?, body} (reading.rs:120) — NOT
// {work_id, body}. subject_type is a free-form string the database does not constrain,
// so 'work' is this client's convention and it lives here, once.
// GET /api/v1/works/{id} — read_work (works.rs:115). The discovery feed carries only
// work_id and slot_id (routes/discovery.rs:237), so the details a card renders come from
// here, one request per work.
const getWork = (workId) => api(`/api/v1/works/${encodeURIComponent(workId)}`);
const addNote = (workId, text) =>
  api('/api/v1/notes', { method: 'PUT', body: { subject_type: 'work', subject_id: workId, body: text } });
const deleteNote = (noteId) => api(`/api/v1/notes/${noteId}`, { method: 'DELETE' });
// kudos need only `content.read` (works.rs:1450) because kudos are a statement about the
// reader — so no elevated scope is requested for them.
const toggleKudos = (workId) => api(`/api/v1/works/${workId}/kudos`, { method: 'POST' });
const getDnf = () => api('/api/v1/me/dnf'); // display only: filtering is the server's (§48.4)
const getStreak = () => api('/api/v1/me/streak');

const apiSurface = {
  setBaseUrl,
  setCookieReader,
  configuredOrigin,
  assertConfiguredOrigin,
  apiUrl,
  api,
  getFeed,
  getWork,
  explainSlot,
  getTasteVector,
  getHistory,
  clearHistory,
  deleteHistoryEntry,
  getNotes,
  addNote,
  deleteNote,
  toggleKudos,
  getDnf,
  getStreak,
  SESSION_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  SAFE_METHODS,
};

// A background script has no `module`; Node's test runner does. Guarded so the file is a
// plain script in the extension and requireable in tests, with no build step either way.
if (typeof module !== 'undefined' && module.exports) module.exports = apiSurface;
