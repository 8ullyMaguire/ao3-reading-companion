// onboarding.js — drives the 9-screen first-run setup.
//
// Architecture:
//   - One in-memory `state` object holds everything in progress.
//   - On boot we read existing preferences from the database and pre-populate
//     the state, so re-running onboarding shows your current selections.
//   - Each "Continue" click writes that screen's data to the database
//     (save-as-you-go), then advances.
//   - Autocomplete fetches AO3 directly from this page (cross-origin allowed
//     by host_permissions in the manifest).
//   - Heavier work (fetching loved-fic pages, seeding the feed) is delegated
//     to background.js via runtime.sendMessage.

"use strict";

const TOTAL_SCREENS = 9;

const WEIGHTS = [
  { value: 1, label: "Light" },
  { value: 3, label: "Love" },
  { value: 5, label: "Must have" }
];

const state = {
  current: 1,
  loggedIn: null,
  data: {
    browsingStyle: null,
    fandoms: [],         // [{ value, weight, locked }]
    preferredTags: [],
    blockedTags: [],     // [{ value }]
    structural: { minWords: null, maxWords: null, ratings: ["G","T","M","E","Not Rated"], completeOnly: false },
    lovedFics: [],       // [{ url, status, ficId?, title?, author?, error? }]
    seedChoice: null
  }
};

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

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast" + (isError ? " error" : "");
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2400);
}

// ---------- Weight-to-label helpers ----------

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

// ---------- Screen navigation ----------

function showScreen(n) {
  state.current = n;
  qsa(".screen").forEach(s => {
    s.hidden = String(s.dataset.screen) !== String(n);
  });
  $("step-num").textContent = n;
  $("progress-fill").style.width = (n / TOTAL_SCREENS * 100) + "%";
  // Re-render any dynamic content for the screen we're showing
  refreshScreen(n);
  window.scrollTo(0, 0);
}

async function next() {
  try {
    await saveScreen(state.current);
    if (state.current < TOTAL_SCREENS) showScreen(state.current + 1);
  } catch (e) {
    console.error("Save failed:", e);
    toast(`Save failed: ${e.message}`, true);
  }
}

function back() {
  if (state.current > 1) showScreen(state.current - 1);
}

function skip() {
  // Skip = don't save, just advance
  if (state.current < TOTAL_SCREENS) showScreen(state.current + 1);
}

// ---------- Per-screen save ----------

async function saveScreen(n) {
  switch (n) {
    case 2:
      if (!state.data.browsingStyle) return; // shouldn't happen — Continue is disabled
      await dbPut("preferences", {
        id: "browsing_style",
        type: "meta",
        value: state.data.browsingStyle
      });
      break;

    case 3:
      await replacePreferencesByType("preferred_fandom", state.data.fandoms.map(f => ({
        id: `preferred_fandom:${f.value}`,
        type: "preferred_fandom",
        value: f.value,
        weight: f.weight,
        locked: !!f.locked
      })));
      break;

    case 4:
      await replacePreferencesByType("preferred_tag", state.data.preferredTags.map(t => ({
        id: `preferred_tag:${t.value}`,
        type: "preferred_tag",
        value: t.value,
        weight: t.weight,
        locked: !!t.locked
      })));
      break;

    case 5:
      await replacePreferencesByType("blocked_tag", state.data.blockedTags.map(t => ({
        id: `blocked_tag:${t.value}`,
        type: "blocked_tag",
        value: t.value
      })));
      break;

    case 6:
      await dbPut("preferences", {
        id: "structural",
        type: "structural",
        ...state.data.structural
      });
      break;

    case 7:
      // Loved fics already saved per-URL by the background handler. Nothing to do.
      break;

    case 8:
      // Seed choice not persisted (one-shot decision).
      break;
  }
}

// ---------- Refresh dynamic content ----------

function refreshScreen(n) {
  switch (n) {
    case 2: refreshScreen2(); break;
    case 3: renderChips("fandom-chips", state.data.fandoms, "fandom"); updateScreen3Hint(); break;
    case 4: renderChips("tag-chips", state.data.preferredTags, "tag"); updateScreen4Hint(); break;
    case 5: renderChips("block-chips", state.data.blockedTags, "block"); break;
    case 6: refreshScreen6(); break;
    case 7: refreshScreen7(); break;
    case 8: refreshScreen8(); break;
    case 9: refreshScreen9(); break;
  }
}

// ---------- Hearts widget ----------

function renderHearts(container, weight, onChange) {
  container.innerHTML = "";
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

// ---------- Chips (fandoms / tags / blocked) ----------

function renderChips(containerId, list, kind) {
  const container = $(containerId);
  container.innerHTML = "";
  for (const item of list) {
    const chip = document.createElement("div");
    chip.className = "chip";

    const name = document.createElement("span");
    name.className = "chip-name";
    name.textContent = item.value;
    chip.appendChild(name);

    if (kind !== "block") {
      const hearts = document.createElement("div");
      hearts.className = "hearts";
      renderHearts(hearts, item.weight, (w) => {
        item.weight = w;
        renderHearts(hearts, w, (w2) => {
          item.weight = w2;
          renderChips(containerId, list, kind);
        });
      });
      chip.appendChild(hearts);

      const lockLabel = document.createElement("label");
      lockLabel.className = "lock-toggle";
      const lockCb = document.createElement("input");
      lockCb.type = "checkbox";
      lockCb.checked = !!item.locked;
      lockCb.addEventListener("change", () => { item.locked = lockCb.checked; });
      lockLabel.appendChild(lockCb);
      lockLabel.appendChild(document.createTextNode(" lock"));
      chip.appendChild(lockLabel);
    }

    const remove = document.createElement("button");
    remove.className = "chip-remove";
    remove.type = "button";
    remove.title = "Remove";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      const idx = list.indexOf(item);
      if (idx >= 0) list.splice(idx, 1);
      renderChips(containerId, list, kind);
      if (kind === "fandom") updateScreen3Hint();
      if (kind === "tag") { updateScreen4Hint(); updateScreen4Continue(); }
    });
    chip.appendChild(remove);

    container.appendChild(chip);
  }
}

function updateScreen3Hint() {
  const n = state.data.fandoms.length;
  const hint = $("fandom-hint");
  if (n === 0) hint.textContent = "No fandoms picked yet. (Skip is fine if you browse by tag.)";
  else hint.textContent = `${n} fandom${n === 1 ? "" : "s"} picked.`;
}

function updateScreen4Hint() {
  const n = state.data.preferredTags.length;
  const hint = $("tag-hint");
  if (n < 3) hint.textContent = `${n}/3 picked. ${3 - n} more to continue.`;
  else hint.textContent = `${n} tags picked.`;
}

function updateScreen4Continue() {
  const btn = qs('.screen[data-screen="4"] button[data-action="next"]');
  if (btn) btn.disabled = state.data.preferredTags.length < 3;
}

// ---------- Autocomplete ----------

async function fetchAutocomplete(endpoint, term) {
  const url = `https://archiveofourown.org/autocomplete/${endpoint}?term=${encodeURIComponent(term)}`;
  // 15s timeout — autocomplete is interactive; a longer wait freezes the UX.
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
  // AO3 returns either JSON (an array of {id, name}) or newline-separated text.
  // Try JSON first, fall back to plain text.
  let items = [];
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data)) {
      items = data.map(x => (typeof x === "string" ? x : (x?.name ?? x?.id))).filter(Boolean);
    }
  } catch {
    items = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }
  // Some autocomplete endpoints append "(N)" counts — strip them.
  items = items.map(s => s.replace(/\s*\(\d+\)\s*$/, ""));
  // De-duplicate, preserving order.
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
      showError(`Couldn't reach AO3 (${e.message}). Try Enter to add raw.`);
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

// ---------- Screen 2: browsing style ----------

function refreshScreen2() {
  qsa('.big-choice[data-style]').forEach(b => {
    b.classList.toggle("selected", b.dataset.style === state.data.browsingStyle);
  });
  const readout = $("style-readout");
  readout.textContent = state.data.browsingStyle
    ? `Selected: ${state.data.browsingStyle === "fandom-first" ? "Fandoms first" : "Tags first"}`
    : "";
  const next = qs('.screen[data-screen="2"] button[data-action="next"]');
  if (next) next.disabled = !state.data.browsingStyle;
}

function wireScreen2() {
  qsa('.big-choice[data-style]').forEach(b => {
    b.addEventListener("click", () => {
      state.data.browsingStyle = b.dataset.style;
      refreshScreen2();
    });
  });
}

// ---------- Screen 3: fandoms ----------

function addFandom(value) {
  const norm = value.trim();
  if (!norm) return;
  if (state.data.fandoms.some(f => f.value === norm)) {
    toast(`Already added: ${norm}`);
    return;
  }
  state.data.fandoms.push({ value: norm, weight: 3, locked: false });
  renderChips("fandom-chips", state.data.fandoms, "fandom");
  updateScreen3Hint();
}

function wireScreen3() {
  setupAutocomplete("fandom-search", "fandom-dropdown", "fandom", addFandom);
}

// ---------- Screen 4: preferred tags ----------

function addPreferredTag(value) {
  const norm = value.trim();
  if (!norm) return;
  if (state.data.preferredTags.some(t => t.value === norm)) {
    toast(`Already added: ${norm}`);
    return;
  }
  state.data.preferredTags.push({ value: norm, weight: 3, locked: false });
  renderChips("tag-chips", state.data.preferredTags, "tag");
  updateScreen4Hint();
  updateScreen4Continue();
}

function wireScreen4() {
  setupAutocomplete("tag-search", "tag-dropdown", "tag", addPreferredTag);

  qsa(".example-tag").forEach(btn => {
    btn.addEventListener("click", () => {
      const fill = btn.dataset.fill;
      $("tag-search").value = fill;
      // Trigger input event to fire autocomplete
      $("tag-search").dispatchEvent(new Event("input"));
      $("tag-search").focus();
    });
  });
}

// ---------- Screen 5: blocked tags ----------

function addBlockedTag(value) {
  const norm = value.trim();
  if (!norm) return;
  if (state.data.blockedTags.some(t => t.value === norm)) {
    toast(`Already added: ${norm}`);
    return;
  }
  state.data.blockedTags.push({ value: norm });
  renderChips("block-chips", state.data.blockedTags, "block");
}

function wireScreen5() {
  setupAutocomplete("block-search", "block-dropdown", "tag", addBlockedTag);
}

// ---------- Screen 6: structural ----------

function refreshScreen6() {
  $("min-words").value = state.data.structural.minWords ?? "";
  $("max-words").value = state.data.structural.maxWords ?? "";
  $("complete-only").checked = !!state.data.structural.completeOnly;
  qsa(".rating-cb").forEach(cb => {
    cb.checked = state.data.structural.ratings.includes(cb.value);
  });
}

function readScreen6IntoState() {
  state.data.structural.minWords = $("min-words").value ? parseInt($("min-words").value, 10) : null;
  state.data.structural.maxWords = $("max-words").value ? parseInt($("max-words").value, 10) : null;
  state.data.structural.ratings = qsa(".rating-cb:checked").map(cb => cb.value);
  state.data.structural.completeOnly = $("complete-only").checked;
}

function wireScreen6() {
  ["min-words", "max-words", "complete-only"].forEach(id => {
    $(id).addEventListener("change", readScreen6IntoState);
  });
  qsa(".rating-cb").forEach(cb => cb.addEventListener("change", readScreen6IntoState));
}

// ---------- Screen 7: loved fics ----------

function refreshScreen7() {
  renderLovedList();
}

function renderLovedList() {
  const list = $("loved-list");
  list.innerHTML = "";
  for (const item of state.data.lovedFics) {
    const li = document.createElement("li");
    li.className = item.status;
    let body;
    if (item.status === "success") {
      body = `${escapeHtml(item.title || "(no title)")} <span class="hint">— by ${escapeHtml(item.author || "?")}</span>`;
    } else if (item.status === "failed") {
      body = `<strong>Failed:</strong> ${escapeHtml(item.url)} <span class="hint">${escapeHtml(item.error || "")}</span>`;
    } else {
      body = `<em>Fetching…</em> ${escapeHtml(item.url)}`;
    }
    li.innerHTML = body;
    list.appendChild(li);
  }
}

async function addLovedUrls() {
  const raw = $("loved-urls").value;
  const urls = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (urls.length === 0) {
    toast("Paste some AO3 fic URLs first", true);
    return;
  }
  $("loved-urls").value = "";
  $("loved-status").textContent = `Fetching ${urls.length}…`;

  for (const url of urls) {
    if (!/\/works\/\d+/.test(url)) {
      state.data.lovedFics.push({ url, status: "failed", error: "Not an AO3 work URL" });
      renderLovedList();
      continue;
    }
    const idx = state.data.lovedFics.length;
    state.data.lovedFics.push({ url, status: "pending" });
    renderLovedList();
    try {
      const reply = await browser.runtime.sendMessage({ type: "FETCH_FIC", url, markLoved: true });
      if (reply?.ok) {
        state.data.lovedFics[idx] = {
          url,
          status: "success",
          ficId: reply.fic.ficId,
          title: reply.fic.title,
          author: reply.fic.author
        };
      } else {
        state.data.lovedFics[idx] = { url, status: "failed", error: reply?.error || "Unknown error" };
      }
    } catch (e) {
      state.data.lovedFics[idx] = { url, status: "failed", error: e.message };
    }
    renderLovedList();
  }
  $("loved-status").textContent = "Done.";
}

function wireScreen7() {
  $("add-loved-btn").addEventListener("click", addLovedUrls);
}

// ---------- Screen 8: seed the feed ----------

function refreshScreen8() {
  qsa('.big-choice[data-seed]').forEach(b => {
    b.classList.toggle("selected", b.dataset.seed === state.data.seedChoice);
  });
  const next = $("screen8-next");
  next.disabled = state.data.seedChoice == null && state.data.seedChoice !== "browse";
  // Always allow continuing once a choice is made (or once a fetch finishes)
  if (state.data.seedChoice === "browse") next.disabled = false;
  if (state.data.seedChoice === "fetch") {
    // Only enable when fetch reports done or error
    const sp = state.data._seedDone;
    next.disabled = !sp;
  }
}

function startSeed() {
  $("seed-progress").hidden = false;
  $("seed-message").textContent = "Starting…";
  $("seed-fill").style.width = "0%";
  state.data._seedDone = false;
  refreshScreen8();
  browser.runtime.sendMessage({
    type: "SEED_FEED",
    payload: { browsingStyle: state.data.browsingStyle }
  }).catch(e => {
    console.error("SEED_FEED message failed:", e);
    toast(`Seed failed: ${e.message}`, true);
  });
}

function updateSeedProgress(p) {
  if (!p) return;
  if (p.status === "fetching") {
    $("seed-message").textContent = `Fetching ${p.current} of ${p.total}: "${p.term}"…`;
    $("seed-fill").style.width = ((p.current - 1) / p.total * 100) + "%";
  } else if (p.status === "done") {
    $("seed-message").textContent = `Done. Cached fics from your top ${p.total} picks.`;
    $("seed-fill").style.width = "100%";
    state.data._seedDone = true;
    refreshScreen8();
    toast("Feed seeded ✓");
  } else if (p.status === "error") {
    $("seed-message").textContent = `Couldn't seed: ${p.message}`;
    state.data._seedDone = true;
    refreshScreen8();
  }
}

function wireScreen8() {
  qsa('.big-choice[data-seed]').forEach(b => {
    b.addEventListener("click", () => {
      state.data.seedChoice = b.dataset.seed;
      if (b.dataset.seed === "fetch") {
        if (!state.loggedIn) {
          toast("Logged out — skipping fetch. Pick 'I'll browse first'.", true);
          state.data.seedChoice = "browse";
        } else {
          startSeed();
        }
      } else {
        $("seed-progress").hidden = true;
      }
      refreshScreen8();
    });
  });

  if (browser.storage && browser.storage.onChanged) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.seedProgress) {
        updateSeedProgress(changes.seedProgress.newValue);
      }
    });
  }
}

// ---------- Screen 9: done ----------

async function refreshScreen9() {
  const summary = $("done-summary");
  const fandoms = await getPreferencesByType("preferred_fandom");
  const tags = await getPreferencesByType("preferred_tag");
  const blocked = await getPreferencesByType("blocked_tag");
  const cacheCount = await dbCount("ficCache");
  const histCount = await dbCount("history");
  summary.innerHTML = `
    <div><strong>${fandoms.length}</strong> preferred fandoms saved</div>
    <div><strong>${tags.length}</strong> preferred tags saved</div>
    <div><strong>${blocked.length}</strong> blocked tags saved</div>
    <div><strong>${cacheCount}</strong> fics already in your cache</div>
    <div><strong>${histCount}</strong> fics in your reading history</div>
  `;
}

async function wireScreen9() {
  $("open-feed").addEventListener("click", async () => {
    await dbPut("preferences", {
      id: "onboarding",
      type: "meta",
      completed: true,
      completedAt: new Date().toISOString()
    });
    browser.tabs.create({ url: browser.runtime.getURL("feed.html") });
    window.close();
  });
}

// ---------- Generic action wiring ----------

function wireActions() {
  qsa('button[data-action="next"]').forEach(b => b.addEventListener("click", next));
  qsa('button[data-action="back"]').forEach(b => b.addEventListener("click", back));
  qsa('button[data-action="skip"]').forEach(b => b.addEventListener("click", skip));
}

// ---------- Load existing prefs into state on init ----------

async function loadStateFromDB() {
  const browsingStyleRec = await dbGet("preferences", "browsing_style");
  if (browsingStyleRec) state.data.browsingStyle = browsingStyleRec.value;

  const fandoms = await getPreferencesByType("preferred_fandom");
  state.data.fandoms = fandoms.map(f => ({ value: f.value, weight: f.weight ?? 3, locked: !!f.locked }));

  const tags = await getPreferencesByType("preferred_tag");
  state.data.preferredTags = tags.map(t => ({ value: t.value, weight: t.weight ?? 3, locked: !!t.locked }));

  const blocked = await getPreferencesByType("blocked_tag");
  state.data.blockedTags = blocked.map(t => ({ value: t.value }));

  const structural = await dbGet("preferences", "structural");
  if (structural) {
    state.data.structural = {
      minWords: structural.minWords ?? null,
      maxWords: structural.maxWords ?? null,
      ratings: structural.ratings ?? ["G","T","M","E","Not Rated"],
      completeOnly: !!structural.completeOnly
    };
  }
}

// ---------- Boot ----------

(async function init() {
  try {
    await openDB();
    await ensureDefaultSettings();
    await loadStateFromDB();

    wireActions();
    wireScreen2();
    wireScreen3();
    wireScreen4();
    wireScreen5();
    wireScreen6();
    wireScreen7();
    wireScreen8();
    await wireScreen9();

    // Asynchronously check AO3 login state — don't block the UI.
    browser.runtime.sendMessage({ type: "CHECK_AO3_LOGIN" }).then(reply => {
      state.loggedIn = !!reply?.loggedIn;
      if (!state.loggedIn) $("logout-banner").hidden = false;
    }).catch(() => { state.loggedIn = null; });

    showScreen(1);
  } catch (e) {
    console.error("Onboarding init failed:", e);
    toast(`Init failed: ${e.message}`, true);
  }
})();
