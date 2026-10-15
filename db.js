// db.js — the extension's only local state after §48: which instance it talks to, and the
// handful of settings around that.
//
// Upstream this file was the local taste store: preferred tags and fandoms with weights,
// blocked tags and authors, author penalties, a dislike history, a custom-row store and a
// fic cache, all of them feeding a ranker that ran in the extension. §48.2 moves the ranking
// to the instance, so none of that has a reader any more. The server's answers are cached in
// cache.js, and the reader's history comes from GET /api/v1/library/history.
//
// Two deliberate choices:
//   * the database NAME is unchanged, so an existing install keeps the settings it has
//     instead of starting over;
//   * the old stores are left in place rather than deleted. Deleting a reader's local data
//     to tidy a schema is not a trade this extension gets to make, and nothing reads them.

const DB_NAME = "MyAO3Algorithm";
const DB_VERSION = 2;

const STORES = {
  SETTINGS: "settings",
};

const DEFAULT_SETTINGS = {
  id: "main",
  // §48.5: the one thing this extension cannot work without. Empty means "not configured
  // yet", and an unconfigured client refuses to guess a host.
  instance: "",
  theme: "dark",
};

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
        db.createObjectStore(STORES.SETTINGS, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function _request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function _store(name, mode = "readonly") {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

async function dbGet(name, key) {
  return _request((await _store(name)).get(key));
}

async function dbPut(name, record) {
  return _request((await _store(name, "readwrite")).put(record));
}

async function dbGetAll(name) {
  return _request((await _store(name)).getAll());
}

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
  const stored = (await dbGet(STORES.SETTINGS, "main")) || {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function getInstance() {
  const s = await getSettings();
  return ((s && s.instance) || "").trim();
}

async function setInstance(url) {
  const s = await getSettings();
  s.instance = (url || "").trim().replace(/\/+$/, "");
  await dbPut(STORES.SETTINGS, s);
  return s.instance;
}
