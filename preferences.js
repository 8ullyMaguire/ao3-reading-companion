// preferences.js — Phase 10 Round 1.
//
// User-facing dashboard for the taste profile. Sections in this round:
// Overview, Tags, Fandoms, Authors, Structural. Sections 6-10 (history,
// dislike history, cache, settings, backup) are stubs in the sidebar and
// land in Round 2.
//
// Pattern: every edit applies immediately and shows a "Saved" toast.
// No save buttons. The page is the source of truth — any change writes
// to IndexedDB right away.

console.log("[My AO3 Algorithm] Preferences page loaded.");

// ---------- DOM helpers ----------

function $(id) { return document.getElementById(id); }
function qs(sel, root = document) { return root.querySelector(sel); }
function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------- Toast ----------

const toastEl = $("toast");
let toastTimer = null;
function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = "pref-toast" + (isError ? " error" : "");
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2000);
}

// ---------- Weight helpers (mirrors onboarding's 1/3/5 model) ----------

const WEIGHTS = [
  { value: 1, label: "Light" },
  { value: 3, label: "Love" },
  { value: 5, label: "Must have" }
];

function weightLabel(w) {
  return (WEIGHTS.find(x => x.value === w) || WEIGHTS[1]).label;
}

function weightToPosition(w) {
  if (w >= 5) return 3;
  if (w >= 3) return 2;
  return 1;
}

function positionToWeight(p) {
  if (p === 3) return 5;
  if (p === 2) return 3;
  return 1;
}

function renderHearts(container, weight, onChange) {
  container.innerHTML = "";
  // Phase 13 R2: role=group + aria-label gives screen readers context that
  // the three heart buttons form a single importance picker.
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", "Importance");
  const currentPos = weightToPosition(weight);
  for (let pos = 1; pos <= 3; pos++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "heart" + (pos <= currentPos ? " filled" : "");
    btn.textContent = pos <= currentPos ? "♥" : "♡";
    const w = positionToWeight(pos);
    btn.title = `${weightLabel(w)} (weight ${w})`;
    btn.setAttribute("aria-label", `${weightLabel(w)} (weight ${w})`);
    btn.setAttribute("aria-pressed", String(pos === currentPos));
    btn.addEventListener("click", () => onChange(w));
    container.appendChild(btn);
  }
  const label = document.createElement("span");
  label.className = "heart-label";
  label.textContent = weightLabel(weight);
  container.appendChild(label);
}

// ---------- Autocomplete (inlined copy of onboarding's; see Round 2 for dedupe) ----------

async function fetchAutocomplete(endpoint, term) {
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

function setupAutocomplete(inputId, dropdownId, endpoint, onSelect) {
  const input = $(inputId);
  const dropdown = $(dropdownId);

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

  const search = debounce(async (term) => {
    if (term.length < 2) return hide();
    try {
      const items = await fetchAutocomplete(endpoint, term);
      show(items);
    } catch (e) {
      console.error(`autocomplete /${endpoint} failed:`, e);
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

// ---------- Section navigation ----------

const SECTIONS = [
  "overview", "tags", "fandoms", "authors", "structural",
  "history", "dislike-history", "cache", "settings", "backup"
];
const STORAGE_KEY_LAST_SECTION = "ao3rec.preferences.lastSection";

function showSection(name) {
  if (!SECTIONS.includes(name)) name = "overview";
  qsa(".section[data-section]").forEach(el => {
    el.hidden = el.dataset.section !== name;
  });
  qsa(".side-link[data-section]").forEach(btn => {
    btn.classList.toggle("is-active", btn.dataset.section === name);
  });
  try { localStorage.setItem(STORAGE_KEY_LAST_SECTION, name); } catch {}
}

function wireSidebar() {
  qsa(".side-link[data-section]").forEach(btn => {
    btn.addEventListener("click", () => showSection(btn.dataset.section));
  });
  qsa(".quick-link[data-jump]").forEach(btn => {
    btn.addEventListener("click", () => showSection(btn.dataset.jump));
  });
}

function wireHeader() {
  $("nav-feed").addEventListener("click", () => { window.location.href = "feed.html"; });
  $("nav-myreading").addEventListener("click", () => { window.location.href = "myreading.html"; });
  $("nav-rerun").addEventListener("click", () => { window.location.href = "onboarding.html"; });
  $("nav-debug").addEventListener("click", () => { window.location.href = "debug.html"; });
}

// ---------- State (held in memory, mirrored to IndexedDB on every edit) ----------

const state = {
  preferredTags: [],     // [{ value, weight, locked }]
  preferredFandoms: [],  // [{ value, weight, locked }]
  blockedTags: [],       // [{ value }]
  blockedAuthors: [],    // [{ value }]
  authorAffinity: [],    // [{ author, ficsRead, affinityScore, manualPenalty }]
  structural: { minWords: null, maxWords: null, ratings: [], completeOnly: false },
  browsingStyle: null,
  filters: {
    prefTags: "",
    prefFandoms: "",
    blockedTags: "",
    blockedAuthors: "",
    authors: "",
    authorSort: "affinity",
    history: "",
    historyState: "all"
  },
  // Pending add: when the user picks from autocomplete, the chosen value
  // sits here while they pick a weight. Cleared on commit/cancel.
  pendingPrefTag: null,    // { value, weight }
  pendingPrefFandom: null  // { value, weight }
};

async function loadAllState() {
  const [
    pTags, pFandoms, bTags, bAuthors, struct, browsing, affinity
  ] = await Promise.all([
    getPreferencesByType("preferred_tag"),
    getPreferencesByType("preferred_fandom"),
    getPreferencesByType("blocked_tag"),
    getPreferencesByType("blocked_author"),
    dbGet("preferences", "structural"),
    dbGet("preferences", "browsing_style"),
    dbGetAll("authorAffinity")
  ]);

  state.preferredTags = pTags.map(r => ({
    value: r.value,
    weight: typeof r.weight === "number" ? r.weight : 3,
    locked: !!r.locked
  })).sort((a, b) => a.value.localeCompare(b.value));

  state.preferredFandoms = pFandoms.map(r => ({
    value: r.value,
    weight: typeof r.weight === "number" ? r.weight : 3,
    locked: !!r.locked
  })).sort((a, b) => a.value.localeCompare(b.value));

  state.blockedTags = bTags.map(r => ({ value: r.value }))
    .sort((a, b) => a.value.localeCompare(b.value));

  state.blockedAuthors = bAuthors.map(r => ({ value: r.value }))
    .sort((a, b) => a.value.localeCompare(b.value));

  state.structural = {
    minWords: struct?.minWords ?? null,
    maxWords: struct?.maxWords ?? null,
    ratings: Array.isArray(struct?.ratings) ? [...struct.ratings] : ["G","T","M","E","Not Rated"],
    completeOnly: !!struct?.completeOnly
  };

  state.browsingStyle = browsing?.value || null;

  state.authorAffinity = (affinity || []).map(r => ({
    author: r.author,
    ficsRead: r.ficsRead || 0,
    ficsCompleted: r.ficsCompleted || 0,
    affinityScore: r.affinityScore || 0,
    manualPenalty: typeof r.manualPenalty === "number" ? r.manualPenalty : 0
  }));
}

// ---------- Overview ----------

async function renderOverview() {
  $("stat-pref-tags").textContent = state.preferredTags.length;
  $("stat-pref-fandoms").textContent = state.preferredFandoms.length;
  $("stat-blocked-tags").textContent = state.blockedTags.length;
  $("stat-blocked-authors").textContent = state.blockedAuthors.length;

  const cacheCount = await dbCount("ficCache").catch(() => 0);
  $("stat-cache").textContent = cacheCount;

  const historyCount = await dbCount("history").catch(() => 0);
  $("stat-history").textContent = historyCount;

  // Last cache refresh: max(scrapedAt) over ficCache. Indexed, so we open
  // the index in descending order and take the first record.
  const lastRefresh = await getMostRecentScrapedAt().catch(() => null);
  $("last-cache-refresh").textContent = lastRefresh
    ? formatRelative(lastRefresh)
    : "no fics cached yet";

  $("browsing-style-readout").textContent = state.browsingStyle === "tags-first"
    ? "Tags first"
    : state.browsingStyle === "fandom-first"
      ? "Fandoms first"
      : "(not set)";
}

async function getMostRecentScrapedAt() {
  // Scan ficCache for max(scrapedAt). O(n) over a few thousand records is
  // fine — runs once per Overview render, no perceptible cost. Reuses the
  // cached DB connection through dbGetAll instead of opening a second one.
  const all = await dbGetAll("ficCache");
  let max = null;
  for (const r of all) {
    if (r.scrapedAt && (!max || r.scrapedAt > max)) max = r.scrapedAt;
  }
  return max;
}

function formatRelative(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// ---------- Collapsible list-blocks ----------
//
// Each list ("pref-tags", "blocked-tags", "pref-fandoms", "authors",
// "blocked-authors") gets a header button that toggles its body. State
// is persisted per list in localStorage; if the user has never set it,
// the default kicks in: collapsed when the list has >= 10 items, open
// otherwise.

const COLLAPSE_THRESHOLD = 10;
const STORAGE_KEY_COLLAPSED = "ao3rec.preferences.collapsed";

function readCollapsedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_COLLAPSED);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeCollapsedState(stateMap) {
  try { localStorage.setItem(STORAGE_KEY_COLLAPSED, JSON.stringify(stateMap)); } catch {}
}

function findBlock(listKey) {
  const toggle = qs(`[data-toggle="${listKey}"]`);
  return toggle ? toggle.closest(".list-block") : null;
}

function setListCollapsed(listKey, collapsed) {
  const block = findBlock(listKey);
  if (!block) return;
  block.classList.toggle("is-collapsed", collapsed);
  const toggle = qs(`[data-toggle="${listKey}"]`);
  if (toggle) toggle.setAttribute("aria-expanded", String(!collapsed));
  const map = readCollapsedState();
  map[listKey] = collapsed;
  writeCollapsedState(map);
}

function applyDefaultCollapsed(listKey, count) {
  // Only seed the default if the user has never set this list. Once the
  // user explicitly toggles, their choice sticks.
  const map = readCollapsedState();
  if (typeof map[listKey] === "boolean") {
    setCollapsedFromMap(listKey, map[listKey]);
    return;
  }
  setCollapsedFromMap(listKey, count >= COLLAPSE_THRESHOLD);
}

function setCollapsedFromMap(listKey, collapsed) {
  // Apply without writing back — used when seeding from defaults or
  // re-applying persisted state on render.
  const block = findBlock(listKey);
  if (!block) return;
  block.classList.toggle("is-collapsed", collapsed);
  const toggle = qs(`[data-toggle="${listKey}"]`);
  if (toggle) toggle.setAttribute("aria-expanded", String(!collapsed));
}

function setListCount(listKey, count) {
  const el = $(`count-${listKey}`);
  if (el) el.textContent = String(count);
}

function wireCollapsibles() {
  qsa(".list-toggle[data-toggle]").forEach(btn => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.toggle;
      const block = btn.closest(".list-block");
      const isCollapsed = block.classList.contains("is-collapsed");
      setListCollapsed(key, !isCollapsed);
    });
  });
}

// ---------- Pending-row (heart picker for adding tags/fandoms) ----------

function renderPendingRow(containerId, pending, opts) {
  const container = $(containerId);
  if (!pending) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }

  container.innerHTML = "";

  const label = document.createElement("span");
  label.className = "pending-name";
  // Quoting the value makes the "with weight" intent of the row unambiguous
  // while keeping the row to a single line.
  label.textContent = `Add "${pending.value}" with`;
  container.appendChild(label);

  const hearts = document.createElement("div");
  hearts.className = "hearts";
  const drawHearts = (w) => {
    renderHearts(hearts, w, (next) => {
      pending.weight = next;
      drawHearts(next);
    });
  };
  drawHearts(pending.weight);
  container.appendChild(hearts);

  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "pending-confirm";
  confirm.textContent = "Add";
  confirm.addEventListener("click", opts.onCommit);
  container.appendChild(confirm);

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "pending-cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", opts.onCancel);
  container.appendChild(cancel);

  container.hidden = false;
}

// ---------- Tags section ----------

function filterByName(list, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return list;
  return list.filter(r => r.value.toLowerCase().includes(q));
}

function renderPrefTags() {
  const list = $("pref-tags-list");
  const items = filterByName(state.preferredTags, state.filters.prefTags);
  list.innerHTML = "";

  setListCount("pref-tags", state.preferredTags.length);

  if (state.preferredTags.length === 0) {
    $("pref-tags-empty").hidden = false;
  } else {
    $("pref-tags-empty").hidden = true;
  }

  for (const item of items) {
    list.appendChild(renderPrefRow(item, {
      onWeightChange: async (w) => {
        item.weight = w;
        await setPreferredTag(item.value, w, item.locked);
        toast(`"${item.value}" weight set to ${weightLabel(w)}`);
        renderPrefTags();
      },
      onLockChange: async (locked) => {
        item.locked = locked;
        await setPreferredTag(item.value, item.weight, locked);
        toast(locked ? `Locked "${item.value}"` : `Unlocked "${item.value}"`);
        renderPrefTags();
      },
      onRemove: async () => {
        if (!confirm(`Remove "${item.value}" from your preferred tags?`)) return;
        await deletePreferredTag(item.value);
        state.preferredTags = state.preferredTags.filter(x => x !== item);
        toast(`Removed "${item.value}"`);
        renderPrefTags();
        renderOverview();
      }
    }));
  }
}

function renderBlockedTags() {
  const list = $("blocked-tags-list");
  const items = filterByName(state.blockedTags, state.filters.blockedTags);
  list.innerHTML = "";

  setListCount("blocked-tags", state.blockedTags.length);

  if (state.blockedTags.length === 0) {
    $("blocked-tags-empty").hidden = false;
  } else {
    $("blocked-tags-empty").hidden = true;
  }

  for (const item of items) {
    list.appendChild(renderBlockRow(item.value, {
      onRemove: async () => {
        await deleteBlockedTag(item.value);
        state.blockedTags = state.blockedTags.filter(x => x !== item);
        toast(`Unblocked "${item.value}"`);
        renderBlockedTags();
        renderOverview();
      }
    }));
  }
}

function renderPrefRow(item, { onWeightChange, onLockChange, onRemove }) {
  const row = document.createElement("div");
  row.className = "pref-row" + (item.locked ? " locked" : "");

  const name = document.createElement("span");
  name.className = "pref-name";
  name.textContent = item.value;
  row.appendChild(name);

  const hearts = document.createElement("div");
  hearts.className = "hearts";
  renderHearts(hearts, item.weight, onWeightChange);
  row.appendChild(hearts);

  const lockLabel = document.createElement("label");
  lockLabel.className = "lock-toggle";
  lockLabel.title = "Locked tags won't be auto-adjusted by the dislike flow";
  const lockCb = document.createElement("input");
  lockCb.type = "checkbox";
  lockCb.checked = !!item.locked;
  lockCb.addEventListener("change", () => onLockChange(lockCb.checked));
  lockLabel.appendChild(lockCb);
  lockLabel.appendChild(document.createTextNode(" lock"));
  row.appendChild(lockLabel);

  const remove = document.createElement("button");
  remove.className = "pref-remove";
  remove.type = "button";
  remove.textContent = "Remove";
  remove.addEventListener("click", onRemove);
  row.appendChild(remove);

  return row;
}

function renderBlockRow(value, { onRemove }) {
  const row = document.createElement("div");
  row.className = "pref-row";

  const name = document.createElement("span");
  name.className = "pref-name";
  name.textContent = value;
  row.appendChild(name);

  const remove = document.createElement("button");
  remove.className = "pref-remove";
  remove.type = "button";
  remove.textContent = "Unblock";
  remove.addEventListener("click", onRemove);
  row.appendChild(remove);

  return row;
}

function renderPendingPrefTag() {
  renderPendingRow("pending-pref-tag", state.pendingPrefTag, {
    onCommit: commitPendingPrefTag,
    onCancel: cancelPendingPrefTag
  });
}

async function commitPendingPrefTag() {
  if (!state.pendingPrefTag) return;
  const { value, weight } = state.pendingPrefTag;
  if (state.preferredTags.some(x => x.value.toLowerCase() === value.toLowerCase())) {
    toast(`"${value}" is already on your preferred list`, true);
    return;
  }
  await setPreferredTag(value, weight, false);
  state.preferredTags.push({ value, weight, locked: false });
  state.preferredTags.sort((a, b) => a.value.localeCompare(b.value));
  state.pendingPrefTag = null;
  renderPendingPrefTag();
  renderPrefTags();
  renderOverview();
  toast(`Added "${value}" with weight ${weightLabel(weight)}`);
}

function cancelPendingPrefTag() {
  state.pendingPrefTag = null;
  renderPendingPrefTag();
}

function wireTagsSection() {
  setupAutocomplete("add-pref-tag-input", "add-pref-tag-dropdown", "tag", (value) => {
    const v = value.trim();
    if (!v) return;
    if (state.preferredTags.some(x => x.value.toLowerCase() === v.toLowerCase())) {
      toast(`"${v}" is already on your preferred list`, true);
      return;
    }
    // Pending flow: surface the pending row and let the user pick a weight
    // before committing. Default weight is 3 (Love), the middle value.
    state.pendingPrefTag = { value: v, weight: 3 };
    renderPendingPrefTag();
  });

  setupAutocomplete("add-blocked-tag-input", "add-blocked-tag-dropdown", "tag", async (value) => {
    const v = value.trim();
    if (!v) return;
    if (state.blockedTags.some(x => x.value.toLowerCase() === v.toLowerCase())) {
      toast(`"${v}" is already blocked`, true);
      return;
    }
    await setBlockedTag(v);
    state.blockedTags.push({ value: v });
    state.blockedTags.sort((a, b) => a.value.localeCompare(b.value));
    toast(`Blocked "${v}"`);
    renderBlockedTags();
    renderOverview();
  });

  $("filter-pref-tags").addEventListener("input", debounce((e) => {
    state.filters.prefTags = e.target.value;
    renderPrefTags();
  }, 100));

  $("filter-blocked-tags").addEventListener("input", debounce((e) => {
    state.filters.blockedTags = e.target.value;
    renderBlockedTags();
  }, 100));
}

// ---------- Fandoms section ----------

function renderPrefFandoms() {
  const list = $("pref-fandoms-list");
  const items = filterByName(state.preferredFandoms, state.filters.prefFandoms);
  list.innerHTML = "";

  setListCount("pref-fandoms", state.preferredFandoms.length);

  if (state.preferredFandoms.length === 0) {
    $("pref-fandoms-empty").hidden = false;
  } else {
    $("pref-fandoms-empty").hidden = true;
  }

  for (const item of items) {
    list.appendChild(renderPrefRow(item, {
      onWeightChange: async (w) => {
        item.weight = w;
        await setPreferredFandom(item.value, w, item.locked);
        toast(`"${item.value}" weight set to ${weightLabel(w)}`);
        renderPrefFandoms();
      },
      onLockChange: async (locked) => {
        item.locked = locked;
        await setPreferredFandom(item.value, item.weight, locked);
        toast(locked ? `Locked "${item.value}"` : `Unlocked "${item.value}"`);
        renderPrefFandoms();
      },
      onRemove: async () => {
        if (!confirm(`Remove "${item.value}" from your preferred fandoms?`)) return;
        await deletePreferredFandom(item.value);
        state.preferredFandoms = state.preferredFandoms.filter(x => x !== item);
        toast(`Removed "${item.value}"`);
        renderPrefFandoms();
        renderOverview();
      }
    }));
  }
}

function renderPendingPrefFandom() {
  renderPendingRow("pending-pref-fandom", state.pendingPrefFandom, {
    onCommit: commitPendingPrefFandom,
    onCancel: cancelPendingPrefFandom
  });
}

async function commitPendingPrefFandom() {
  if (!state.pendingPrefFandom) return;
  const { value, weight } = state.pendingPrefFandom;
  if (state.preferredFandoms.some(x => x.value.toLowerCase() === value.toLowerCase())) {
    toast(`"${value}" is already on your preferred list`, true);
    return;
  }
  await setPreferredFandom(value, weight, false);
  state.preferredFandoms.push({ value, weight, locked: false });
  state.preferredFandoms.sort((a, b) => a.value.localeCompare(b.value));
  state.pendingPrefFandom = null;
  renderPendingPrefFandom();
  renderPrefFandoms();
  renderOverview();
  toast(`Added "${value}" with weight ${weightLabel(weight)}`);
}

function cancelPendingPrefFandom() {
  state.pendingPrefFandom = null;
  renderPendingPrefFandom();
}

function wireFandomsSection() {
  setupAutocomplete("add-pref-fandom-input", "add-pref-fandom-dropdown", "fandom", (value) => {
    const v = value.trim();
    if (!v) return;
    if (state.preferredFandoms.some(x => x.value.toLowerCase() === v.toLowerCase())) {
      toast(`"${v}" is already on your preferred list`, true);
      return;
    }
    state.pendingPrefFandom = { value: v, weight: 3 };
    renderPendingPrefFandom();
  });

  $("filter-pref-fandoms").addEventListener("input", debounce((e) => {
    state.filters.prefFandoms = e.target.value;
    renderPrefFandoms();
  }, 100));
}

// ---------- Authors section ----------

function compareAuthors(a, b, sortKey) {
  if (sortKey === "reads")   return (b.ficsRead || 0) - (a.ficsRead || 0);
  if (sortKey === "penalty") return (a.manualPenalty || 0) - (b.manualPenalty || 0); // most negative first
  if (sortKey === "alpha")   return String(a.author).localeCompare(String(b.author));
  // default: affinity
  const aScore = (a.affinityScore || 0) + (a.manualPenalty || 0);
  const bScore = (b.affinityScore || 0) + (b.manualPenalty || 0);
  return bScore - aScore;
}

function renderAuthors() {
  const list = $("authors-list");
  list.innerHTML = "";

  setListCount("authors", state.authorAffinity.length);

  // Affinity list
  const q = state.filters.authors.trim().toLowerCase();
  let visible = state.authorAffinity.filter(a => !q || a.author.toLowerCase().includes(q));
  visible.sort((a, b) => compareAuthors(a, b, state.filters.authorSort));

  if (state.authorAffinity.length === 0) {
    $("authors-empty").hidden = false;
  } else {
    $("authors-empty").hidden = true;
  }

  for (const a of visible) {
    const row = document.createElement("div");
    row.className = "author-row";

    const name = document.createElement("div");
    name.className = "author-name";
    name.textContent = a.author;
    row.appendChild(name);

    const reads = document.createElement("div");
    reads.className = "author-stat";
    reads.innerHTML = `<span class="num">${a.ficsRead}</span> read`;
    row.appendChild(reads);

    const score = document.createElement("div");
    score.className = "author-stat";
    score.innerHTML = `affinity <span class="num">${a.affinityScore}</span>`;
    row.appendChild(score);

    const penalty = document.createElement("div");
    penalty.className = "author-stat penalty";
    penalty.innerHTML = a.manualPenalty
      ? `penalty <span class="num">${a.manualPenalty}</span>`
      : `<span style="color:var(--muted-2)">no penalty</span>`;
    row.appendChild(penalty);

    list.appendChild(row);
  }

  // Blocked authors
  const blockedList = $("blocked-authors-list");
  blockedList.innerHTML = "";

  setListCount("blocked-authors", state.blockedAuthors.length);

  const filteredBlocked = filterByName(state.blockedAuthors, state.filters.blockedAuthors);
  if (state.blockedAuthors.length === 0) {
    $("blocked-authors-empty").hidden = false;
  } else {
    $("blocked-authors-empty").hidden = true;
    for (const item of filteredBlocked) {
      blockedList.appendChild(renderBlockRow(item.value, {
        onRemove: async () => {
          await deleteBlockedAuthor(item.value);
          state.blockedAuthors = state.blockedAuthors.filter(x => x !== item);
          toast(`Unblocked "${item.value}"`);
          renderAuthors();
          renderOverview();
        }
      }));
    }
  }
}

function wireAuthorsSection() {
  $("filter-authors").addEventListener("input", debounce((e) => {
    state.filters.authors = e.target.value;
    renderAuthors();
  }, 100));

  $("sort-authors").addEventListener("change", (e) => {
    state.filters.authorSort = e.target.value;
    renderAuthors();
  });

  $("clear-affinity-btn").addEventListener("click", async () => {
    if (!confirm("Clear all author affinity data? Reading history and preferences are kept. The extension will rebuild affinity from scratch as you read.")) return;
    await clearAllAuthorAffinity();
    state.authorAffinity = [];
    toast("Author affinity cleared.");
    renderAuthors();
  });

  $("add-blocked-author-input").addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = e.target.value.trim();
    if (!v) return;
    if (state.blockedAuthors.some(x => x.value.toLowerCase() === v.toLowerCase())) {
      toast(`"${v}" is already blocked`, true);
      return;
    }
    await setBlockedAuthor(v);
    state.blockedAuthors.push({ value: v });
    state.blockedAuthors.sort((a, b) => a.value.localeCompare(b.value));
    e.target.value = "";
    toast(`Blocked "${v}"`);
    renderAuthors();
    renderOverview();
  });

  $("filter-blocked-authors").addEventListener("input", debounce((e) => {
    state.filters.blockedAuthors = e.target.value;
    renderAuthors();
  }, 100));
}

// ---------- Structural section ----------

function renderStructural() {
  $("min-words").value = state.structural.minWords == null ? "" : String(state.structural.minWords);
  $("max-words").value = state.structural.maxWords == null ? "" : String(state.structural.maxWords);
  $("complete-only").checked = !!state.structural.completeOnly;

  qsa(".rating-cb").forEach(cb => {
    cb.checked = state.structural.ratings.includes(cb.value);
  });

  qsa(".bs-choice").forEach(b => {
    b.classList.toggle("is-selected", b.dataset.style === state.browsingStyle);
  });
}

async function saveStructural() {
  await setStructuralPreferences({
    minWords: state.structural.minWords,
    maxWords: state.structural.maxWords,
    ratings: state.structural.ratings,
    completeOnly: state.structural.completeOnly
  });
  toast("Saved.");
}

async function saveBrowsingStyle() {
  if (!state.browsingStyle) return;
  // Match onboarding's exact shape: type "meta" (not "browsing_style") so
  // the type index isn't polluted with a new value.
  await dbPut("preferences", { id: "browsing_style", type: "meta", value: state.browsingStyle });
  toast(`Browsing style: ${state.browsingStyle === "tags-first" ? "Tags first" : "Fandoms first"}`);
}

function wireStructuralSection() {
  $("min-words").addEventListener("change", async (e) => {
    state.structural.minWords = e.target.value ? parseInt(e.target.value, 10) : null;
    await saveStructural();
  });

  $("max-words").addEventListener("change", async (e) => {
    state.structural.maxWords = e.target.value ? parseInt(e.target.value, 10) : null;
    await saveStructural();
  });

  $("complete-only").addEventListener("change", async (e) => {
    state.structural.completeOnly = !!e.target.checked;
    await saveStructural();
  });

  qsa(".rating-cb").forEach(cb => {
    cb.addEventListener("change", async () => {
      state.structural.ratings = qsa(".rating-cb:checked").map(c => c.value);
      await saveStructural();
    });
  });

  qsa(".bs-choice").forEach(btn => {
    btn.addEventListener("click", async () => {
      state.browsingStyle = btn.dataset.style;
      qsa(".bs-choice").forEach(b => b.classList.toggle("is-selected", b === btn));
      await saveBrowsingStyle();
      renderOverview();
    });
  });
}

// ---------- Type-to-confirm modal (used for Reset to defaults) ----------

function requireTypedConfirm({ title, body, word }) {
  return new Promise((resolve) => {
    const modal = $("confirm-modal");
    $("confirm-title").textContent = title;
    $("confirm-body").textContent = body;
    $("confirm-word").textContent = word;
    const input = $("confirm-input");
    const goBtn = $("confirm-go");
    const cancelBtn = $("confirm-cancel");
    input.value = "";
    goBtn.disabled = true;

    // Phase 13 R2: capture the trigger so focus can return there on close.
    const previouslyFocused = document.activeElement;

    const onInput = () => { goBtn.disabled = input.value !== word; };

    // Trap Tab inside the modal and let Esc cancel.
    const onKeydown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = [cancelBtn, input, goBtn].filter(el => !el.disabled);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    const cleanup = () => {
      input.removeEventListener("input", onInput);
      goBtn.removeEventListener("click", onGo);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("keydown", onKeydown);
      modal.hidden = true;
      if (previouslyFocused && typeof previouslyFocused.focus === "function" &&
          document.body.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
    const onGo = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };

    input.addEventListener("input", onInput);
    goBtn.addEventListener("click", onGo);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("keydown", onKeydown);
    modal.hidden = false;
    setTimeout(() => input.focus(), 30);
  });
}

// ---------- Reading history section ----------

const HISTORY_STATE = {
  ALL: "all",
  SAVE: "save_for_later",
  IN_PROGRESS: "reading_inprogress",
  CAUGHT_UP: "reading_caughtup",
  ASIDE: "set_aside"
};

let historyCache = []; // [{ ficId, ...record, _displayState }]

// Translates the raw `state` field + chapter/completion data into the four
// user-facing buckets the UI shows. Mirrors myreading.js's three-bucket
// logic plus a "set_aside" carve-out for autoPromoteBlocked records.
function classifyHistoryState(rec) {
  if (rec.state === "save_for_later") return HISTORY_STATE.SAVE;
  if (rec.state === "reading" && rec.autoPromoteBlocked) return HISTORY_STATE.ASIDE;
  // From here, rec.state is "reading" (or legacy with no state — treated as reading).
  const total = rec.chapterTotal;
  const max = rec.maxChapterRead || 0;
  if (total && max >= total) return HISTORY_STATE.CAUGHT_UP;
  return HISTORY_STATE.IN_PROGRESS;
}

function displayStateLabel(s) {
  switch (s) {
    case HISTORY_STATE.SAVE:        return "Save for later";
    case HISTORY_STATE.IN_PROGRESS: return "Reading";
    case HISTORY_STATE.CAUGHT_UP:   return "Caught up";
    case HISTORY_STATE.ASIDE:       return "Set aside";
    default: return "—";
  }
}

function displayStateBadgeClass(s) {
  switch (s) {
    case HISTORY_STATE.SAVE:        return "state-save";
    case HISTORY_STATE.IN_PROGRESS: return "state-reading";
    case HISTORY_STATE.CAUGHT_UP:   return "state-caughtup";
    case HISTORY_STATE.ASIDE:       return "state-aside";
    default: return "";
  }
}

async function loadHistory() {
  const all = await dbGetAll("history");
  historyCache = all.map(rec => {
    const r = ensureHistoryState({ ...rec });  // fills state for legacy records
    r._displayState = classifyHistoryState(r);
    return r;
  });
  // Newest-first by lastOpened.
  historyCache.sort((a, b) => String(b.lastOpened || "").localeCompare(String(a.lastOpened || "")));
}

function renderHistory() {
  const list = $("history-list");
  list.innerHTML = "";

  const stateFilter = state.filters.historyState;
  const q = state.filters.history.trim().toLowerCase();

  const visible = historyCache.filter(r => {
    if (stateFilter !== HISTORY_STATE.ALL && r._displayState !== stateFilter) return false;
    if (q) {
      const hay = `${r.title || ""} ${r.author || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  $("history-count-line").textContent =
    `${historyCache.length} total · ${visible.length} matching`;

  if (historyCache.length === 0) {
    $("history-empty").hidden = false;
  } else {
    $("history-empty").hidden = true;
  }

  for (const r of visible) {
    list.appendChild(renderHistoryRow(r));
  }
}

function renderHistoryRow(r) {
  const row = document.createElement("div");
  row.className = "history-row";

  const main = document.createElement("div");
  main.className = "history-main";

  const badge = document.createElement("span");
  badge.className = "state-badge " + displayStateBadgeClass(r._displayState);
  badge.textContent = displayStateLabel(r._displayState);
  main.appendChild(badge);

  const title = document.createElement("div");
  title.className = "history-title";
  title.textContent = r.title || "(no title)";
  main.appendChild(title);

  const author = document.createElement("div");
  author.className = "history-author";
  author.textContent = `by ${r.author || "Anonymous"}`;
  main.appendChild(author);

  const meta = document.createElement("div");
  meta.className = "history-meta";

  const lastOpened = r.lastOpened ? formatRelative(r.lastOpened) : "never opened";
  meta.appendChild(metaPiece("opened", lastOpened));

  const chCur = r.lastChapterRead ?? r.maxChapterRead;
  const chTot = r.chapterTotal;
  if (chCur != null || chTot != null) {
    meta.appendChild(metaPiece("chapter", `${chCur ?? "?"}/${chTot ?? "?"}`));
  }

  if (r.maxScrollOnChapter != null) {
    meta.appendChild(metaPiece("scroll", `${r.maxScrollOnChapter}%`));
  }

  if (r.totalReadingTimeMinutes) {
    meta.appendChild(metaPiece("read time", `${r.totalReadingTimeMinutes} min`));
  }

  main.appendChild(meta);
  row.appendChild(main);

  const actions = document.createElement("div");
  actions.className = "history-actions";
  const del = document.createElement("button");
  del.className = "pref-remove";
  del.type = "button";
  del.textContent = "Delete";
  del.addEventListener("click", async () => {
    if (!confirm(`Delete "${r.title || r.ficId}" from history?`)) return;
    try {
      await browser.runtime.sendMessage({ type: "HISTORY_DELETE", ficId: r.ficId });
      historyCache = historyCache.filter(x => x.ficId !== r.ficId);
      toast(`Deleted "${r.title || r.ficId}"`);
      renderHistory();
      renderOverview();
    } catch (e) {
      toast(`Delete failed: ${e.message}`, true);
    }
  });
  actions.appendChild(del);
  row.appendChild(actions);

  return row;
}

function metaPiece(label, value) {
  const span = document.createElement("span");
  span.innerHTML = `<span class="meta-key">${label}:</span> ${escapeHtml(value)}`;
  return span;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function wireHistorySection() {
  $("filter-history").addEventListener("input", debounce((e) => {
    state.filters.history = e.target.value;
    renderHistory();
  }, 100));

  $("filter-history-state").addEventListener("change", (e) => {
    state.filters.historyState = e.target.value;
    renderHistory();
  });

  $("clear-history-btn").addEventListener("click", async () => {
    const ok = await requireTypedConfirm({
      title: "Clear all reading history",
      body: "This wipes every entry — every fic you've opened. Your preferences and the fic cache are kept. This can't be undone.",
      word: "CLEAR"
    });
    if (!ok) return;
    await dbClear("history");
    historyCache = [];
    toast("Reading history cleared.");
    renderHistory();
    renderOverview();
  });
}

// ---------- Dislike history section ----------

const DISLIKE_DEFAULT_LIMIT = 100;
let dislikeShowingAll = false;

async function renderDislikeHistory() {
  const list = $("dislike-list");
  list.innerHTML = "";

  const all = await listDislikeHistory(dislikeShowingAll ? 100000 : DISLIKE_DEFAULT_LIMIT);
  const total = await dbCount("dislikeHistory").catch(() => all.length);

  $("dislike-count-line").textContent = dislikeShowingAll
    ? `${total} record${total === 1 ? "" : "s"} (all shown)`
    : `${total} record${total === 1 ? "" : "s"} total · showing ${Math.min(total, DISLIKE_DEFAULT_LIMIT)}`;

  $("dislike-empty").hidden = total > 0;
  $("dislike-load-all-btn").hidden = dislikeShowingAll || total <= DISLIKE_DEFAULT_LIMIT;

  for (const rec of all) {
    list.appendChild(renderDislikeRow(rec));
  }
}

function renderDislikeRow(rec) {
  const row = document.createElement("div");
  row.className = "dislike-row";

  const when = document.createElement("div");
  when.className = "dislike-when";
  when.textContent = rec.timestamp
    ? new Date(rec.timestamp).toLocaleString()
    : "(unknown when)";
  row.appendChild(when);

  const fic = document.createElement("div");
  fic.className = "dislike-fic";
  fic.textContent = rec.title || "(no title)";
  row.appendChild(fic);

  const author = document.createElement("div");
  author.className = "dislike-author";
  author.textContent = `by ${rec.author || "?"} · ficId ${rec.ficId}`;
  row.appendChild(author);

  // Reasons
  if (Array.isArray(rec.reasons) && rec.reasons.length > 0) {
    row.appendChild(buildDislikeListBlock("Reasons", rec.reasons,
      r => (window.formatDislikeReason ? window.formatDislikeReason(r) : JSON.stringify(r))));
  }

  // Changes
  if (Array.isArray(rec.changes) && rec.changes.length > 0) {
    row.appendChild(buildDislikeListBlock("Changes applied", rec.changes,
      c => (window.formatDislikeChange ? window.formatDislikeChange(c) : JSON.stringify(c))));
  } else {
    const note = document.createElement("p");
    note.className = "dislike-section";
    note.innerHTML = `<span class="dis-key">Changes</span>(no changes — log only)`;
    row.appendChild(note);
  }

  // Actions
  const actions = document.createElement("div");
  actions.className = "dislike-actions";

  const undo = document.createElement("button");
  undo.className = "pref-remove";
  undo.type = "button";
  if (rec.canUndo === false) {
    undo.textContent = "Cannot undo — preferences modified since";
    undo.disabled = true;
  } else {
    undo.textContent = "Undo";
    undo.addEventListener("click", async () => {
      try {
        if (!window.undoDislikeFromHistory) {
          toast("Undo helper not loaded — see console", true);
          return;
        }
        const res = await window.undoDislikeFromHistory(rec.id);
        if (res.ok) {
          toast(`Undone dislike #${rec.id}`);
          await loadAllState();
          renderPrefTags();
          renderBlockedTags();
          renderPrefFandoms();
          renderAuthors();
          renderOverview();
          await renderDislikeHistory();
        } else if (res.reason === "modified" || res.reason === "already_modified") {
          toast("Cannot undo — preferences modified since.", true);
          await renderDislikeHistory();
        } else {
          toast(`Undo failed: ${res.reason}`, true);
        }
      } catch (e) {
        toast(`Undo failed: ${e.message}`, true);
      }
    });
  }
  actions.appendChild(undo);

  const del = document.createElement("button");
  del.className = "pref-remove";
  del.type = "button";
  del.textContent = "Delete record";
  del.addEventListener("click", async () => {
    if (!confirm(`Delete dislike record #${rec.id}? The change itself stays in place — only the audit entry is removed.`)) return;
    try {
      await deleteDislikeRecord(rec.id);
      toast(`Deleted record #${rec.id}`);
      await renderDislikeHistory();
    } catch (e) {
      toast(`Delete failed: ${e.message}`, true);
    }
  });
  actions.appendChild(del);

  row.appendChild(actions);
  return row;
}

function buildDislikeListBlock(label, items, formatter) {
  const wrap = document.createElement("div");
  wrap.className = "dislike-section";
  const key = document.createElement("span");
  key.className = "dis-key";
  key.textContent = label;
  wrap.appendChild(key);
  const ul = document.createElement("ul");
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = formatter(item);
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
  return wrap;
}

function wireDislikeHistorySection() {
  $("dislike-load-all-btn").addEventListener("click", async () => {
    dislikeShowingAll = true;
    await renderDislikeHistory();
  });
}

// ---------- Cache section ----------

async function renderCacheSection() {
  const count = await dbCount("ficCache").catch(() => 0);
  $("cache-stat-count").textContent = count;

  const lastRefresh = await getMostRecentScrapedAt().catch(() => null);
  $("cache-stat-refresh").textContent = lastRefresh ? formatRelative(lastRefresh) : "—";

  // navigator.storage.estimate gives a coarse usage figure for the whole
  // origin (IndexedDB + Cache API + localStorage etc.). It's an
  // approximation — close enough for "is this a reasonable size?".
  let sizeText = "—";
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (typeof est.usage === "number") {
        sizeText = formatBytes(est.usage);
      }
    }
  } catch (e) {
    console.warn("[My AO3 Algorithm] storage.estimate failed:", e);
  }
  $("cache-stat-size").textContent = sizeText;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function wireCacheSection() {
  $("clear-cache-btn").addEventListener("click", async () => {
    const ok = await requireTypedConfirm({
      title: "Clear fic cache",
      body: "This wipes every cached fic. Your preferences, reading history, and author affinity are kept. The cache will rebuild as you browse AO3.",
      word: "CLEAR"
    });
    if (!ok) return;
    await dbClear("ficCache");
    toast("Cache cleared.");
    await renderCacheSection();
    renderOverview();
  });

  // Phase 12: manual refresh. Pulls top fandoms+tags and runs the subs sync.
  // Disabled while in flight; toast on completion with a count summary or a
  // friendly message for the logged-out / 429 cases.
  $("refresh-cache-btn").addEventListener("click", async () => {
    const btn = $("refresh-cache-btn");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Refreshing…";
    try {
      const reply = await browser.runtime.sendMessage({ type: "RUN_MANUAL_REFRESH" });
      if (reply && reply.reason === "logged_out") {
        toast("Sign into AO3 first — I can't fetch fresh listings without your login session.", true);
      } else if (reply && reply.ok) {
        const pull = reply.pull || {};
        if (pull.hit429) {
          toast("AO3 rate limit hit — wait a bit and try again.", true);
        } else {
          const newCount = pull.saved || 0;
          const found = pull.found || 0;
          toast(`Refreshed. Found ${found} fic${found === 1 ? "" : "s"}, cached ${newCount}.`);
        }
      } else {
        toast("Refresh didn't run — see console.", true);
      }
    } catch (e) {
      console.error("[My AO3 Algorithm] manual refresh failed:", e);
      toast(`Refresh failed: ${e.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
      await renderCacheSection();
      renderOverview();
    }
  });
}

// ---------- Settings section ----------

let cachedSettings = null;

async function loadSettingsRecord() {
  cachedSettings = (await getSettings()) || {};
}

function renderSettings() {
  const s = cachedSettings || {};
  $("set-scrape-delay").value           = String(s.scrapeDelaySeconds ?? 10);
  $("set-pull-interval").value          = String(s.scheduledPullIntervalHours ?? 8);
  $("set-pages-per-refresh").value      = String(s.pagesPerRefresh ?? 6);
  $("set-behavioral-enabled").checked   = !!s.behavioralSignalsEnabled;
  $("set-behavioral-threshold").value   = String(s.behavioralSignalsThreshold ?? 10);
  $("set-pause-scraping").checked       = !!s.scheduledPullsPaused;

  $("info-username").textContent = s.ao3Username || "(not detected — visit any logged-in AO3 page)";
  $("info-last-sync").textContent = s.subscriptionsLastSyncAt
    ? formatRelative(s.subscriptionsLastSyncAt)
    : "never synced";
}

async function saveSettings(patch) {
  cachedSettings = { ...(cachedSettings || {}), id: "main", ...patch };
  await dbPut("settings", cachedSettings);
  toast("Saved.");
}

function wireSettingsSection() {
  $("set-scrape-delay").addEventListener("change", (e) =>
    saveSettings({ scrapeDelaySeconds: parseInt(e.target.value, 10) }));

  $("set-pull-interval").addEventListener("change", async (e) => {
    await saveSettings({ scheduledPullIntervalHours: parseInt(e.target.value, 10) });
    // Phase 12: tell background to re-register the scheduled-pull alarm at
    // the new interval. Fire-and-forget — the alarm change isn't time-
    // critical and shouldn't block the toast.
    try { await browser.runtime.sendMessage({ type: "APPLY_SCHEDULED_PULL_ALARM" }); }
    catch {}
  });

  $("set-pages-per-refresh").addEventListener("change", (e) =>
    saveSettings({ pagesPerRefresh: parseInt(e.target.value, 10) }));

  $("set-pause-scraping").addEventListener("change", async (e) => {
    await saveSettings({ scheduledPullsPaused: !!e.target.checked });
    // No alarm re-register needed — the alarm fires either way; the listener
    // checks the pause flag at fire time and skips when on.
  });

  $("set-behavioral-enabled").addEventListener("change", (e) =>
    saveSettings({ behavioralSignalsEnabled: !!e.target.checked }));

  $("set-behavioral-threshold").addEventListener("change", (e) =>
    saveSettings({ behavioralSignalsThreshold: parseInt(e.target.value, 10) }));
}

// ---------- Backup & data section ----------

const BACKUP_SCHEMA_VERSION = 1;
const BACKUP_STORES = [
  "preferences", "history", "ficCache",
  "authorAffinity", "customRows", "settings", "dislikeHistory"
];

async function exportBackup() {
  const data = { _meta: {
    exportedAt: new Date().toISOString(),
    schemaVersion: BACKUP_SCHEMA_VERSION
  }};
  for (const store of BACKUP_STORES) {
    try {
      data[store] = await dbGetAll(store);
    } catch (e) {
      console.warn(`[backup] couldn't read ${store}:`, e);
      data[store] = [];
    }
  }
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const filename = `my-ao3-algorithm-backup-${dateStampForFilename()}.json`;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported to ${filename}`);
}

function dateStampForFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

async function importBackup(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    toast("Couldn't parse the file — is it a backup JSON?", true);
    return;
  }
  if (!data || typeof data !== "object" || !data._meta) {
    toast("File doesn't look like a backup.", true);
    return;
  }

  const ok = await requireTypedConfirm({
    title: "Replace all data with backup",
    body: `This wipes everything currently in the extension and replaces it with the contents of the file. Backup was exported on ${data._meta.exportedAt || "unknown date"}. This cannot be undone.`,
    word: "REPLACE"
  });
  if (!ok) return;

  try {
    for (const store of BACKUP_STORES) {
      await dbClear(store);
      const records = Array.isArray(data[store]) ? data[store] : [];
      for (const rec of records) {
        await dbPut(store, rec);
      }
    }
    toast("Backup restored. Reloading…");
    setTimeout(() => { window.location.reload(); }, 600);
  } catch (e) {
    console.error("[my-ao3-algorithm] import failed:", e);
    toast(`Import failed: ${e.message}`, true);
  }
}

async function resetEverything() {
  const ok = await requireTypedConfirm({
    title: "Reset everything",
    body: "This wipes preferences, reading history, fic cache, author affinity, dislike history, custom rows, and subscribed authors. Settings reset to defaults. You'll be sent back to onboarding. This cannot be undone.",
    word: "RESET"
  });
  if (!ok) return;

  try {
    await dbClear("preferences");
    await dbClear("history");
    await dbClear("ficCache");
    await dbClear("authorAffinity");
    await dbClear("customRows");
    await dbClear("dislikeHistory");
    await resetSettingsToDefaults();
    // localStorage holds preference-page state (last section, collapsed
    // map). Wipe so onboarding starts truly clean.
    try {
      localStorage.removeItem(STORAGE_KEY_LAST_SECTION);
      localStorage.removeItem(STORAGE_KEY_COLLAPSED);
    } catch {}
    toast("Reset complete. Sending you to onboarding…");
    setTimeout(() => { window.location.href = "onboarding.html"; }, 700);
  } catch (e) {
    console.error("[my-ao3-algorithm] reset failed:", e);
    toast(`Reset failed: ${e.message}`, true);
  }
}

function wireBackupSection() {
  $("export-btn").addEventListener("click", exportBackup);

  $("import-btn").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    $("import-status").textContent = `Selected: ${file.name}`;
    await importBackup(file);
    e.target.value = "";  // allow same file to be picked again
  });

  $("bookmarks-import-btn").addEventListener("click", runBookmarksImport);

  $("reset-btn").addEventListener("click", resetEverything);
}

// ---------- Phase 13 R4: AO3 bookmarks import ----------
//
// One-click import of the user's AO3 bookmarks as Save for Later entries.
// Heavy lifting lives in background.js so it survives the user closing this
// tab mid-run; this function just kicks it off, shows live progress, and
// surfaces a final toast.

let _bookmarksImportInFlight = false;
async function runBookmarksImport() {
  if (_bookmarksImportInFlight) return;
  const btn = $("bookmarks-import-btn");
  const status = $("bookmarks-import-status");
  const original = btn.textContent;
  _bookmarksImportInFlight = true;
  btn.disabled = true;
  btn.textContent = "Starting…";
  status.textContent = "";

  const progressListener = (msg) => {
    if (!msg || msg.type !== "PULL_PROGRESS" || msg.source !== "bookmarks_import") return;
    const imported = msg.imported || 0;
    const skipped = msg.skipped || 0;
    btn.textContent = `Scanning page ${msg.current}…`;
    status.textContent = `${imported} imported, ${skipped} already in history`;
  };
  browser.runtime.onMessage.addListener(progressListener);

  let reply = null;
  try {
    reply = await browser.runtime.sendMessage({ type: "IMPORT_AO3_BOOKMARKS" });
  } catch (e) {
    console.warn("[My AO3 Algorithm] bookmarks import failed:", e);
    toast(`Import failed: ${e.message}`);
  } finally {
    browser.runtime.onMessage.removeListener(progressListener);
    btn.textContent = original;
    btn.disabled = false;
    _bookmarksImportInFlight = false;
  }

  if (!reply) {
    status.textContent = "";
    return;
  }
  if (reply.reason === "in_flight") {
    toast("Another refresh is running — try again in a moment.");
    status.textContent = "";
    return;
  }
  if (reply.reason === "no_username") {
    toast("Visit any logged-in AO3 page first so the extension can detect your username.");
    status.textContent = "";
    return;
  }
  if (reply.reason === "logged_out") {
    toast("Sign into AO3 first to import bookmarks.");
    status.textContent = "";
    return;
  }
  if (!reply.ok) {
    toast("Import didn't run — see console.");
    status.textContent = "";
    return;
  }

  const imported = reply.imported || 0;
  const skipped = reply.skipped || 0;
  const pages = reply.pagesScanned || 0;
  const parts = [];
  if (imported > 0) parts.push(`Imported ${imported} bookmark${imported === 1 ? "" : "s"} as Save for Later`);
  else parts.push("No new bookmarks imported");
  if (skipped > 0) parts.push(`skipped ${skipped} already in your history`);
  if (reply.hit429) parts.push("stopped early on AO3 rate limit");
  if (reply.networkFail) parts.push("stopped early — couldn't reach AO3");
  if (reply.hitPageCap) parts.push(`hit ${pages}-page cap; click Import again to scan further`);
  toast(parts.join("; ") + ".");
  status.textContent = `${imported} imported, ${skipped} skipped, ${pages} page${pages === 1 ? "" : "s"} scanned.`;
}

// ---------- Phase 13 R2: keyboard shortcuts ----------
//
// `/` focuses the filter input on the active section (or the first ac-input
// when no filter input exists). `?` (Shift+/) toggles a small help overlay
// listing every shortcut. Both shortcuts are no-ops while the user is typing
// in another input or while a modal is open.

function _isTextEntryTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  return false;
}

function _isAnyModalOpen() {
  // Confirm modal is the only one Preferences shows. If any modal is open,
  // the global shortcuts should defer to it.
  const m = document.getElementById("confirm-modal");
  return m && !m.hidden;
}

function focusActiveSectionFilter() {
  const visibleSection = qs(".section[data-section]:not([hidden])");
  if (!visibleSection) return false;
  // Prefer a filter input; fall back to autocomplete-style add input.
  const target = visibleSection.querySelector(
    ".filter-input:not([hidden]), .ac-input:not([hidden])"
  );
  if (!target) return false;
  target.focus();
  target.select?.();
  return true;
}

function buildShortcutsOverlay() {
  if (document.getElementById("shortcuts-overlay")) return;
  const backdrop = document.createElement("div");
  backdrop.id = "shortcuts-overlay";
  backdrop.className = "modal-backdrop is-open";
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" tabindex="-1">
      <button class="modal-close" id="shortcuts-close" type="button" aria-label="Close">&times;</button>
      <h2 id="shortcuts-title">Keyboard shortcuts</h2>
      <dl class="shortcuts-list">
        <div class="shortcut-row"><dt><kbd>/</kbd></dt><dd>Focus the filter on the active section</dd></div>
        <div class="shortcut-row"><dt><kbd>?</kbd></dt><dd>Show this help</dd></div>
        <div class="shortcut-row"><dt><kbd>Esc</kbd></dt><dd>Close modals and dialogs</dd></div>
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

function setupKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (_isTextEntryTarget(document.activeElement)) return;
    if (_isAnyModalOpen()) return;
    if (document.getElementById("shortcuts-overlay")) return;  // help already open

    if (e.key === "/") {
      if (focusActiveSectionFilter()) e.preventDefault();
      return;
    }
    if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
      e.preventDefault();
      buildShortcutsOverlay();
    }
  });
}

// ---------- Boot ----------

(async function () {
  try {
    wireHeader();
    wireSidebar();
    wireCollapsibles();
    wireTagsSection();
    wireFandomsSection();
    wireAuthorsSection();
    wireStructuralSection();
    wireHistorySection();
    wireDislikeHistorySection();
    wireCacheSection();
    wireSettingsSection();
    wireBackupSection();

    await loadAllState();
    await loadHistory();
    await loadSettingsRecord();

    renderPrefTags();
    renderBlockedTags();
    renderPrefFandoms();
    renderAuthors();
    renderStructural();
    renderHistory();
    renderSettings();
    await renderOverview();
    await renderCacheSection();
    await renderDislikeHistory();

    // Seed collapsed state for each list. Default rule (>= 10 items →
    // collapsed) only applies when the user has never explicitly toggled
    // that list. Stored choices win over the default.
    applyDefaultCollapsed("pref-tags",        state.preferredTags.length);
    applyDefaultCollapsed("blocked-tags",     state.blockedTags.length);
    applyDefaultCollapsed("pref-fandoms",     state.preferredFandoms.length);
    applyDefaultCollapsed("authors",          state.authorAffinity.length);
    applyDefaultCollapsed("blocked-authors",  state.blockedAuthors.length);

    let last = "overview";
    try { last = localStorage.getItem(STORAGE_KEY_LAST_SECTION) || "overview"; } catch {}
    showSection(last);

    setupKeyboardShortcuts();

    $("page-subtitle").textContent = "Your taste profile, all in one place.";
  } catch (e) {
    console.error("[My AO3 Algorithm] Preferences boot failed:", e);
    $("page-subtitle").textContent = "Couldn't load your preferences — see console.";
  }
})();
