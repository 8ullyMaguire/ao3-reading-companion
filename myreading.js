// myreading.js — Phase 7e "My Reading" page.
//
// Reads readingHistory + ficCache, classifies every history record into one of
// four buckets, renders a lean card per fic with section-appropriate actions:
//
//   save_for_later → state === "save_for_later"
//   in_progress    → state === "reading", maxChapterRead < chaptersCurrent
//   caught_up      → state === "reading", maxChapterRead === chaptersCurrent,
//                    isComplete === false
//   read           → state === "reading", maxChapterRead === chaptersCurrent,
//                    isComplete === true
//
// Records with no ficCache entry fall back to whatever the history record itself
// stores (chapterTotal, chapters snapshot) and get a dashed-border "limited info"
// visual marker so the user knows we're showing less by design.
//
// Card actions:
//   Save for Later → "Start reading" (open AO3) + "Unsave"   (delete history)
//   In Progress    → "Continue reading" (open AO3 at current chapter) + "Set aside"
//   Caught Up      → "Open on AO3"
//   Read           → "Open on AO3" + "Archive" (delete history)

console.log("[My AO3 Algorithm] My Reading page loaded.");

const MAX_FANDOMS_INLINE = 3;

// ---------- Tiny utilities ----------

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ao3WorkBaseUrl(ficId) {
  return `https://archiveofourown.org/works/${encodeURIComponent(ficId)}`;
}

function ao3ChapterUrl(ficId, chapterId) {
  return `${ao3WorkBaseUrl(ficId)}/chapters/${encodeURIComponent(chapterId)}`;
}

// Static href for resume buttons. Direct chapter URL when chapter IDs are
// cached and the user has read past chapter 1; bare /works/[ficId] otherwise.
// The full-work view (?view_full_work=true) is no longer produced here — the
// click handler runs an on-demand fetch when chapter IDs are missing, then
// navigates directly to the chapter URL it just learned.
//
// The bare URL is what modifier-clicks (middle, ctrl, right-click "open in
// new tab") fall back to when no IDs are cached — suboptimal but functional
// (lands at chapter 1), and the next normal left-click will trigger the
// fetch and cache.
function ao3WorkUrl(ficId, chapter, fic) {
  const base = ao3WorkBaseUrl(ficId);
  if (!chapter || chapter < 1) return base;
  const ids = fic && Array.isArray(fic.chapterIds) ? fic.chapterIds : null;
  if (ids && ids[chapter - 1]) return ao3ChapterUrl(ficId, ids[chapter - 1]);
  return base;
}

function ao3UserUrl(username) {
  return `https://archiveofourown.org/users/${encodeURIComponent(username)}`;
}

function parseChaptersString(s) {
  // "5/?" → { current: 5, total: null }, "5/10" → { current: 5, total: 10 }.
  if (!s) return { current: null, total: null };
  const parts = String(s).split("/").map(p => p.trim());
  const current = parseInt(parts[0], 10);
  const total = parts[1] === "?" ? null : parseInt(parts[1], 10);
  return {
    current: Number.isFinite(current) ? current : null,
    total: Number.isFinite(total) ? total : null
  };
}

function formatToast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add("visible"));
  clearTimeout(t._timer);
  t._timer = setTimeout(() => {
    t.classList.remove("visible");
    setTimeout(() => { t.hidden = true; }, 350);
  }, 2500);
}

// ---------- Classification ----------

// Returns { bucket, info } for a history record. `info` carries the derived
// numbers (chaptersCurrent, isComplete, etc.) so the renderer doesn't have to
// re-derive them.
function classify(historyRecord, ficByFicId) {
  const fic = ficByFicId.get(historyRecord.ficId) || null;
  const limitedInfo = !fic;

  // Chapters published — prefer the live cache, fall back to history's snapshot.
  let chaptersCurrent = null;
  let chaptersTotal = null;
  let chaptersDisplay = null;
  if (fic && fic.chapters) {
    const parsed = parseChaptersString(fic.chapters);
    chaptersCurrent = parsed.current;
    chaptersTotal = parsed.total;
    chaptersDisplay = fic.chapters;
  } else if (historyRecord.chapterTotal != null || historyRecord.lastChapterRead != null) {
    // History stores the user's seen-state, not the live chapter count, but
    // it's the best we have for cache-orphans. Don't pretend it's "current".
    chaptersCurrent = historyRecord.chapterTotal ?? historyRecord.lastChapterRead ?? null;
    chaptersTotal = historyRecord.chapterTotal ?? null;
    if (chaptersCurrent != null) {
      chaptersDisplay = `${chaptersCurrent}/${chaptersTotal ?? "?"}`;
    }
  }

  // isComplete: from cache when we have it; otherwise infer from "X/X" pattern
  // (definite total, current === total). Anything else: unknown → treat as not complete.
  let isComplete = null;
  if (fic && typeof fic.isComplete === "boolean") {
    isComplete = fic.isComplete;
  } else if (chaptersCurrent != null && chaptersTotal != null && chaptersCurrent === chaptersTotal) {
    isComplete = true;
  } else if (chaptersCurrent != null && chaptersTotal == null) {
    isComplete = false;
  }

  const maxRead = historyRecord.maxChapterRead || 0;

  let bucket;
  if (historyRecord.state === "save_for_later") {
    bucket = "save_for_later";
  } else {
    // state === "reading"
    if (chaptersCurrent != null && maxRead < chaptersCurrent) {
      bucket = "in_progress";
    } else if (chaptersCurrent != null && maxRead >= chaptersCurrent) {
      if (isComplete === true) bucket = "read";
      else bucket = "caught_up";
    } else {
      // chaptersCurrent unknown — best-effort default. If we have any
      // chapter progress, treat as in-progress. If isComplete is somehow
      // confidently true, treat as read.
      if (isComplete === true) bucket = "read";
      else bucket = "in_progress";
    }
  }

  return {
    bucket,
    info: {
      fic,
      limitedInfo,
      chaptersCurrent,
      chaptersTotal,
      chaptersDisplay,
      isComplete,
      maxRead
    }
  };
}

// ---------- Card rendering ----------

// Build the fandoms paragraph as a real DOM node and stash the raw fandom
// array on the element. Storing escaped HTML in data attributes and toggling
// via innerHTML would round-trip through a decode and re-encode any '<', which
// is a real XSS hazard if a fandom name ever contains markup-like text.
function buildFandomsEl(fandoms) {
  if (!Array.isArray(fandoms) || fandoms.length === 0) return null;
  const p = document.createElement("p");
  p.className = "mr-card-fandoms";
  p._fandoms = fandoms;
  paintFandoms(p, /* expanded */ false);
  return p;
}

function paintFandoms(p, expanded) {
  const fandoms = p._fandoms || [];
  const remaining = Math.max(0, fandoms.length - MAX_FANDOMS_INLINE);
  while (p.firstChild) p.removeChild(p.firstChild);

  const list = expanded ? fandoms : fandoms.slice(0, MAX_FANDOMS_INLINE);
  p.appendChild(document.createTextNode(list.join(" · ")));

  if (remaining > 0) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mr-card-fandoms-toggle";
    btn.dataset.action = "toggle-fandoms";
    btn.textContent = expanded ? "show fewer" : ` +${remaining} more`;
    p.appendChild(btn);
  }
  p.dataset.expanded = expanded ? "true" : "false";
}

function renderStatusHtml(bucket, info, history) {
  if (bucket === "save_for_later") {
    // Chapter delta: chaptersAtSave (snapshot when saved) vs. live chapter count.
    const savedSnap = parseChaptersString(history.chaptersAtSave);
    const nowCurrent = info.chaptersCurrent;
    const nowTotal = info.chaptersTotal;
    if (savedSnap.current != null && nowCurrent != null) {
      const grew = nowCurrent > savedSnap.current;
      const same = nowCurrent === savedSnap.current;
      const oldStr = `${savedSnap.current}/${savedSnap.total ?? "?"}`;
      const newStr = `${nowCurrent}/${nowTotal ?? "?"}`;
      if (grew) {
        return `<span class="mr-status delta">
          <span class="delta-old">${escapeHtml(oldStr)}</span>
          <span class="delta-arrow">→</span>
          <span class="delta-new">${escapeHtml(newStr)}</span>
        </span>`;
      }
      if (same) {
        return `<span class="mr-status delta">
          <span class="delta-same">${escapeHtml(oldStr)} (no change)</span>
        </span>`;
      }
      // Shrank? (rare — fic edited, deleted chapters.) Show neutrally.
      return `<span class="mr-status delta">
        <span class="delta-old">${escapeHtml(oldStr)}</span>
        <span class="delta-arrow">→</span>
        <span>${escapeHtml(newStr)}</span>
      </span>`;
    }
    // Fallback: just show whatever chapter info we have.
    if (info.chaptersDisplay) {
      return `<span class="mr-status">${escapeHtml(info.chaptersDisplay)}</span>`;
    }
    return `<span class="mr-status">Saved</span>`;
  }

  if (bucket === "in_progress") {
    const ch = info.maxRead || 1;
    const total = info.chaptersTotal != null ? info.chaptersTotal : (info.chaptersCurrent != null ? info.chaptersCurrent : "?");
    const scrollPct = history.maxScrollOnChapter || 0;
    const scrollLabel = scrollPct > 0 ? ` · ${Math.round(scrollPct)}% through ch ${ch}` : "";
    return `<span class="mr-status in-progress">Chapter ${escapeHtml(String(ch))} of ${escapeHtml(String(total))}${escapeHtml(scrollLabel)}</span>`;
  }

  if (bucket === "caught_up") {
    const ch = info.chaptersCurrent != null ? info.chaptersCurrent : "?";
    const next = info.chaptersCurrent != null ? info.chaptersCurrent + 1 : "?";
    return `<span class="mr-status caught-up">Caught up — waiting for chapter ${escapeHtml(String(next))}</span>`;
  }

  if (bucket === "read") {
    const finished = history.lastOpened ? formatDate(history.lastOpened) : null;
    const label = finished ? `Completed · finished ${escapeHtml(finished)}` : `Completed`;
    return `<span class="mr-status read">${label}</span>`;
  }

  return "";
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return null;
  }
}

function renderActionsHtml(bucket, info, history) {
  const ficId = history.ficId;
  // Resume target: the chapter the user last read. For Save for Later
  // cards this also kicks in if the user previously read partway and then
  // chose to "set aside" — Start reading should still resume from progress,
  // not restart from chapter 1.
  const resumeAt = history.maxChapterRead && history.maxChapterRead > 0
    ? history.maxChapterRead
    : null;
  switch (bucket) {
    case "save_for_later":
      return `
        <div class="mr-card-actions">
          <a class="primary" data-action="resume" data-ficid="${escapeHtml(ficId)}" data-chapter="${resumeAt || ""}" href="${ao3WorkUrl(ficId, resumeAt, info)}" target="_blank" rel="noopener">Start reading</a>
          <button type="button" class="danger" data-action="unsave">Unsave</button>
        </div>
      `;
    case "in_progress":
      return `
        <div class="mr-card-actions">
          <a class="primary" data-action="resume" data-ficid="${escapeHtml(ficId)}" data-chapter="${resumeAt || ""}" href="${ao3WorkUrl(ficId, resumeAt, info)}" target="_blank" rel="noopener">Continue reading</a>
          <button type="button" data-action="set-aside">Set aside</button>
        </div>
      `;
    case "caught_up":
      return `
        <div class="mr-card-actions">
          <a href="${ao3WorkUrl(ficId)}" target="_blank" rel="noopener">Open on AO3</a>
        </div>
      `;
    case "read":
      return `
        <div class="mr-card-actions">
          <a href="${ao3WorkUrl(ficId)}" target="_blank" rel="noopener">Open on AO3</a>
          <button type="button" class="danger" data-action="archive">Archive</button>
        </div>
      `;
  }
  return "";
}

function renderCard(history, bucket, info) {
  const card = document.createElement("article");
  card.className = "mr-card";
  if (info.limitedInfo) card.classList.add("limited-info");
  if (updatedFicIds && updatedFicIds.has(history.ficId)) card.classList.add("is-updated");
  card.dataset.ficId = history.ficId;
  card.dataset.bucket = bucket;

  const fic = info.fic;
  const title = (fic && fic.title) || history.title || "(untitled)";
  const authorRaw = (fic && fic.author) || history.author || null;
  const authorDisplay = (fic && (fic.authorPseud || fic.author)) || history.author || null;
  const fandoms = (fic && Array.isArray(fic.fandoms)) ? fic.fandoms : [];

  const titleHtml = `
    <h3 class="mr-card-title">
      <a href="${ao3WorkUrl(history.ficId)}" target="_blank" rel="noopener">${escapeHtml(title)}</a>
    </h3>
  `;

  const authorHtml = authorRaw
    ? `<p class="mr-card-author">by <a href="${ao3UserUrl(authorRaw)}" target="_blank" rel="noopener">${escapeHtml(authorDisplay)}</a></p>`
    : `<p class="mr-card-author">by <span>Anonymous</span></p>`;

  const statusHtml = renderStatusHtml(bucket, info, history);
  const actionsHtml = renderActionsHtml(bucket, info, history);
  const limitedHint = info.limitedInfo
    ? `<p class="mr-limited-hint">Limited info — this fic isn't in your cache yet.</p>`
    : "";

  card.innerHTML = titleHtml + authorHtml + statusHtml + limitedHint + actionsHtml;

  // Insert fandoms after the author paragraph (DOM-built, not innerHTML, to
  // keep arbitrary fandom-name text safe).
  const fandomsEl = buildFandomsEl(fandoms);
  if (fandomsEl) {
    const author = card.querySelector(".mr-card-author");
    if (author && author.nextSibling) {
      card.insertBefore(fandomsEl, author.nextSibling);
    } else {
      card.appendChild(fandomsEl);
    }
  }

  // Stash for action handlers.
  card._history = history;
  card._info = info;
  return card;
}

// ---------- Section rendering ----------

function renderSection(buckets) {
  const groups = {
    save_for_later: { containerId: "cards-save", emptyId: "empty-save", countId: "count-save" },
    in_progress:    { containerId: "cards-in-progress", emptyId: "empty-in-progress", countId: null },
    caught_up:      { containerId: "cards-caught-up", emptyId: "empty-caught-up", countId: null },
    read:           { containerId: "cards-read", emptyId: "empty-read", countId: "count-read" }
  };

  for (const [bucket, target] of Object.entries(groups)) {
    const container = document.getElementById(target.containerId);
    const empty = document.getElementById(target.emptyId);
    const records = buckets[bucket] || [];
    container.innerHTML = "";
    if (records.length === 0) {
      empty.hidden = false;
    } else {
      empty.hidden = true;
      for (const { history, info } of records) {
        container.appendChild(renderCard(history, bucket, info));
      }
    }
    if (target.countId) {
      const el = document.getElementById(target.countId);
      el.textContent = `${records.length}`;
    }
  }

  // Reading section count = in_progress + caught_up.
  const readingCount = (buckets.in_progress?.length || 0) + (buckets.caught_up?.length || 0);
  document.getElementById("count-reading").textContent = String(readingCount);

  const total = Object.values(buckets).reduce((sum, arr) => sum + arr.length, 0);
  const saveN = buckets.save_for_later?.length || 0;
  const readN = buckets.read?.length || 0;
  const sub = total === 0
    ? "Nothing here yet. Save a fic or start reading to fill this page."
    : `${total} fic${total === 1 ? "" : "s"} tracked · ${saveN} saved · ${readingCount} reading · ${readN} read`;
  document.getElementById("page-subtitle").textContent = sub;
}

// ---------- Sorting per bucket ----------

function sortBuckets(buckets) {
  const byLastOpenedDesc = (a, b) => {
    const ta = a.history.lastOpened || "";
    const tb = b.history.lastOpened || "";
    return tb.localeCompare(ta);
  };
  buckets.save_for_later.sort(byLastOpenedDesc);
  buckets.in_progress.sort(byLastOpenedDesc);
  buckets.read.sort(byLastOpenedDesc);
  // Caught Up: most recent updates first → sort by chaptersCurrent desc, then lastOpened desc.
  buckets.caught_up.sort((a, b) => {
    const ca = a.info.chaptersCurrent || 0;
    const cb = b.info.chaptersCurrent || 0;
    if (cb !== ca) return cb - ca;
    return byLastOpenedDesc(a, b);
  });
}

// ---------- Load + classify all records ----------

async function loadAndRender() {
  const historyRecs = await dbGetAll("history");
  // Phase 7d migration parity — ensures every record has a state field even
  // if the underlying record predates 7d. Not persisted here; the next
  // VISIT/TICK on that fic will write it back.
  for (const h of historyRecs) ensureHistoryState(h);

  const ficRecs = await dbGetAll("ficCache");
  const ficByFicId = new Map(ficRecs.map(f => [f.ficId, f]));

  const buckets = {
    save_for_later: [],
    in_progress: [],
    caught_up: [],
    read: []
  };

  for (const h of historyRecs) {
    const { bucket, info } = classify(h, ficByFicId);
    buckets[bucket].push({ history: h, info });
  }

  sortBuckets(buckets);
  renderSection(buckets);
}

// ---------- Action handlers ----------

async function handleAction(action, card) {
  const history = card._history;
  const info = card._info;
  if (!history) return;

  const button = card.querySelector(`[data-action="${action}"]`);
  if (button) button.disabled = true;

  try {
    if (action === "unsave") {
      // SAVE_TOGGLE on a save_for_later record deletes it (existing branch).
      await browser.runtime.sendMessage({
        type: "SAVE_TOGGLE",
        ficId: history.ficId,
        title: history.title,
        author: history.author,
        chapters: (info.fic && info.fic.chapters) || history.chaptersAtSave || null,
        chapterCurrent: history.lastChapterRead ?? null,
        chapterTotal: history.chapterTotal ?? null,
        timestamp: new Date().toISOString()
      });
      formatToast("Removed from Save for Later");
    } else if (action === "set-aside") {
      // SAVE_TOGGLE on a reading record flips to save_for_later +
      // autoPromoteBlocked. Re-render lets the user see the move silently.
      await browser.runtime.sendMessage({
        type: "SAVE_TOGGLE",
        ficId: history.ficId,
        title: history.title,
        author: history.author,
        chapters: (info.fic && info.fic.chapters) || `${info.chaptersCurrent ?? "?"}/${info.chaptersTotal ?? "?"}`,
        chapterCurrent: history.lastChapterRead ?? null,
        chapterTotal: history.chapterTotal ?? null,
        timestamp: new Date().toISOString()
      });
      formatToast("Set aside");
    } else if (action === "archive") {
      await browser.runtime.sendMessage({
        type: "HISTORY_DELETE",
        ficId: history.ficId
      });
      formatToast("Archived");
    } else {
      return;
    }
    await loadAndRender();
  } catch (e) {
    console.error("[My AO3 Algorithm] action failed:", action, e);
    formatToast("Action failed — see console");
    if (button) button.disabled = false;
  }
}

// ---------- Resume click flow ----------
//
// Start Reading / Continue Reading on a card. Always clears the
// autoPromoteBlocked flag for the fic so the next visit can auto-promote
// from save_for_later → reading once thresholds are met.
//
// If the anchor's static href already points at a direct chapter URL
// (chapter IDs were cached at render time), native navigation handles it
// — modifier-clicks (middle-click, ctrl-click, right-click → "open in new
// tab") all continue to work. We just fire the autoPromoteBlocked clear
// alongside.
//
// If the static href is the bare /works/[ficId] URL (no chapter IDs cached
// yet), a modifier-click still gets that bare URL — suboptimal but
// functional, lands at chapter 1. A normal left-click without modifiers
// triggers the on-demand path: preventDefault, swap the anchor text to
// "Preparing…", fetch chapter IDs from background, then window.open the
// resolved direct chapter URL. Firefox's transient user activation covers
// the typical 1–2s fetch; if window.open is blocked anyway, fall back to
// a clickable toast.
function isModifierClick(e) {
  return e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey;
}

function clearAutopromoteBlock(ficId) {
  if (!ficId) return;
  browser.runtime.sendMessage({
    type: "CLEAR_AUTOPROMOTE_BLOCK",
    ficId,
    timestamp: new Date().toISOString()
  }).then(() => {}, () => {});
}

function handleResumeClick(e, anchor) {
  const ficId = anchor.dataset.ficid;
  if (!ficId) return;

  // Always clear the flag (fire-and-forget), regardless of click type.
  clearAutopromoteBlock(ficId);

  // Modifier-clicks: let the browser do its native thing with the static
  // href. If chapter IDs are cached, the href is already a direct chapter
  // URL. If not, the user gets the bare URL (chapter 1) — acceptable.
  if (isModifierClick(e)) return;

  // If the static href is already a direct chapter URL, native navigation
  // handles it; nothing to fetch.
  if ((anchor.getAttribute("href") || "").includes("/chapters/")) return;

  // No resume target (or chapter 1): bare /works/[ficId] is functionally
  // the same as a chapter-1 direct URL — both land on chapter 1 in normal
  // per-chapter view and the existing tracker works as designed. Skip the
  // fetch entirely for these clicks; native navigation handles them.
  const chapter = parseInt(anchor.dataset.chapter, 10) || null;
  if (!chapter || chapter < 2) return;

  // Multi-chapter resume target without cached IDs: do the on-demand fetch.
  e.preventDefault();
  resumeViaOnDemandFetch(anchor, ficId, chapter);
}

async function resumeViaOnDemandFetch(anchor, ficId, chapter) {
  const originalText = anchor.textContent;
  anchor.textContent = "Preparing…";
  anchor.classList.add("preparing");
  // Visually disable the anchor so a quick second click doesn't double-fire.
  anchor.style.pointerEvents = "none";

  function restore() {
    anchor.textContent = originalText;
    anchor.classList.remove("preparing");
    anchor.style.pointerEvents = "";
  }

  // openTarget: open URL in a new tab using window.open. If the popup
  // blocker fires (window.open returns null), surface a clickable toast
  // so the user can complete the action manually.
  function openTarget(url) {
    const win = window.open(url, "_blank", "noopener");
    if (win) return true;
    showOpenInNewTabToast(url);
    return false;
  }

  try {
    const reply = await browser.runtime.sendMessage({
      type: "FETCH_CHAPTER_IDS",
      ficId
    });

    if (reply && reply.ok && Array.isArray(reply.chapterIds) && reply.chapterIds.length > 0) {
      const ids = reply.chapterIds;
      const idx = chapter && chapter > 0 ? Math.min(chapter, ids.length) - 1 : 0;
      openTarget(`https://archiveofourown.org/works/${encodeURIComponent(ficId)}/chapters/${encodeURIComponent(ids[idx])}`);
    } else if (reply && reply.ok && reply.singleChapter) {
      // No dropdown → single-chapter fic. Bare URL is correct.
      openTarget(`https://archiveofourown.org/works/${encodeURIComponent(ficId)}`);
    } else {
      formatToast("Couldn't load chapter info — opening fic anyway");
      openTarget(`https://archiveofourown.org/works/${encodeURIComponent(ficId)}`);
    }
  } catch (err) {
    console.error("[My AO3 Algorithm] resume fetch failed:", err);
    formatToast("Couldn't load chapter info — opening fic anyway");
    openTarget(`https://archiveofourown.org/works/${encodeURIComponent(ficId)}`);
  } finally {
    restore();
    // After a successful fetch, the cache now has chapter IDs. Re-render
    // so subsequent clicks use the static direct chapter URL (no fetch).
    loadAndRender().catch(e => console.warn("re-render after resume failed:", e));
  }
}

// Fallback toast for when window.open is blocked. Gives the user a
// clickable link so they can still complete the action with one extra
// tap. Rare in Firefox (transient user activation comfortably covers a
// ~1–2s fetch) but possible on slow networks.
function showOpenInNewTabToast(url) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.innerHTML = "";
  const span = document.createElement("span");
  span.textContent = "Popup blocked — ";
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "click to open";
  link.style.color = "var(--accent)";
  link.style.textDecoration = "underline";
  t.appendChild(span);
  t.appendChild(link);
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add("visible"));
  clearTimeout(t._timer);
  t._timer = setTimeout(() => {
    t.hidden = true;
    t.classList.remove("visible");
    t.textContent = "";
  }, 8000);
}

// ---------- Wiring ----------

document.addEventListener("click", (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;

  // Fandom collapse toggle.
  const fandomToggle = target.closest('[data-action="toggle-fandoms"]');
  if (fandomToggle) {
    const p = fandomToggle.closest(".mr-card-fandoms");
    if (p) {
      const expanded = p.dataset.expanded === "true";
      paintFandoms(p, !expanded);
    }
    return;
  }

  // Card-level actions.
  const actionBtn = target.closest("[data-action]");
  if (actionBtn) {
    const action = actionBtn.dataset.action;
    if (["unsave", "set-aside", "archive"].includes(action)) {
      const card = actionBtn.closest(".mr-card");
      if (card) handleAction(action, card);
    } else if (action === "resume") {
      handleResumeClick(e, actionBtn);
    }
  }
});

document.getElementById("nav-feed").addEventListener("click", () => {
  window.location.href = "feed.html";
});
document.getElementById("nav-rerun").addEventListener("click", () => {
  window.location.href = "onboarding.html";
});
document.getElementById("nav-preferences").addEventListener("click", () => {
  window.location.href = "preferences.html";
});
document.getElementById("nav-debug").addEventListener("click", () => {
  window.location.href = "debug.html";
});
document.getElementById("nav-check-updates").addEventListener("click", runUpdateCheck);

// ---------- Phase 12 Round 2: reading-list update check ----------
//
// In-memory set of ficIds that gained chapters during the current page
// session. Render functions read this to add the .is-updated class. Cleared
// on page reload (matches the "session-only" highlight design).
const updatedFicIds = new Set();

let _updateCheckInFlight = false;

async function refreshUpdateButtonState() {
  // Called on boot and after each successful check. Disables the button when
  // there's nothing eligible to refresh.
  const btn = document.getElementById("nav-check-updates");
  if (!btn) return;
  try {
    const reply = await browser.runtime.sendMessage({ type: "COUNT_ACTIVE_READING_FICS" });
    const eligible = (reply && reply.eligible) || 0;
    if (eligible === 0) {
      btn.disabled = true;
      btn.title = "Nothing to check — no active WIPs in last 90 days (or all recently refreshed).";
    } else {
      btn.disabled = false;
      const cap = (reply && reply.cap) || 25;
      btn.title = eligible > cap
        ? `Check ${cap} of ${eligible} active WIPs for new chapters. Click again to check more.`
        : `Check your ${eligible} active WIP${eligible === 1 ? "" : "s"} for new chapters.`;
    }
  } catch (e) {
    console.warn("[My AO3 Algorithm] update-check count failed:", e);
  }
}

async function runUpdateCheck() {
  if (_updateCheckInFlight) return;
  const btn = document.getElementById("nav-check-updates");
  const original = btn.textContent;
  _updateCheckInFlight = true;
  btn.disabled = true;
  btn.textContent = "Checking…";

  const progressListener = (msg) => {
    if (!msg || msg.type !== "PULL_PROGRESS" || msg.source !== "update_check") return;
    btn.textContent = `Checking ${msg.current} of ${msg.total}…`;
  };
  browser.runtime.onMessage.addListener(progressListener);

  let reply = null;
  try {
    reply = await browser.runtime.sendMessage({ type: "RUN_READING_UPDATE_CHECK" });
  } catch (e) {
    console.warn("[My AO3 Algorithm] update check failed:", e);
    formatToast(`Check for updates failed: ${e.message}`);
  } finally {
    browser.runtime.onMessage.removeListener(progressListener);
    btn.textContent = original;
    _updateCheckInFlight = false;
  }

  if (!reply) {
    await refreshUpdateButtonState();
    return;
  }
  if (reply.reason === "logged_out") {
    formatToast("Sign into AO3 first to check for updates.");
    await refreshUpdateButtonState();
    return;
  }
  if (reply.reason === "in_flight") {
    formatToast("Another refresh is running — try again in a moment.");
    await refreshUpdateButtonState();
    return;
  }
  if (!reply.ok) {
    formatToast("Check for updates didn't run — see console.");
    await refreshUpdateButtonState();
    return;
  }
  if (reply.hit429) {
    formatToast("AO3 rate limit hit — wait a bit and try again.");
    await refreshUpdateButtonState();
    return;
  }

  const updated = (reply.updatedFicIds || []).length;
  const titles  = reply.updatedTitles || [];
  const failures = reply.failures || 0;
  if (updated === 0) {
    // If every attempted fetch failed, that's an AO3-down situation, not "no
    // chapters found." Surface it plainly so the user knows their cache wasn't
    // actually compared against anything.
    if (reply.checked === 0 && failures > 0) {
      formatToast("Couldn't reach AO3 right now — try again in a bit.");
    } else if (reply.checked === 0) {
      formatToast("Nothing to check right now.");
    } else {
      formatToast("No new chapters found.");
    }
  } else {
    const preview = titles.slice(0, 3).join(", ");
    const overflow = titles.length > 3 ? ` + ${titles.length - 3} more` : "";
    const capNote = reply.hitCap ? " Click again to check more if needed." : "";
    formatToast(`Found updates for ${updated} fic${updated === 1 ? "" : "s"}: ${preview}${overflow}.${capNote}`);
  }

  // Stash IDs and re-render so cards pick up the .is-updated class.
  for (const ficId of (reply.updatedFicIds || [])) updatedFicIds.add(ficId);
  await loadAndRender();
  await refreshUpdateButtonState();
}

// ---------- Phase 13 R2: keyboard shortcuts ----------
//
// `c` triggers the Check-for-updates button (parity with clicking it). `?`
// opens a cheatsheet listing every shortcut. Both defer to text-entry
// targets so they don't fire while the user is typing.

function _isTextEntryTargetMR(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  return false;
}

function buildMRShortcutsOverlay() {
  if (document.getElementById("shortcuts-overlay")) return;
  const backdrop = document.createElement("div");
  backdrop.id = "shortcuts-overlay";
  backdrop.className = "modal-backdrop is-open";
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" tabindex="-1">
      <button class="modal-close" id="shortcuts-close" type="button" aria-label="Close">&times;</button>
      <h2 id="shortcuts-title">Keyboard shortcuts</h2>
      <dl class="shortcuts-list">
        <div class="shortcut-row"><dt><kbd>c</kbd></dt><dd>Check active reading fics for new chapters</dd></div>
        <div class="shortcut-row"><dt><kbd>?</kbd></dt><dd>Show this help</dd></div>
        <div class="shortcut-row"><dt><kbd>Esc</kbd></dt><dd>Close this dialog</dd></div>
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

function setupMRKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (_isTextEntryTargetMR(document.activeElement)) return;
    if (document.getElementById("shortcuts-overlay")) return;
    if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
      e.preventDefault();
      buildMRShortcutsOverlay();
      return;
    }
    if (e.key === "c" || e.key === "C") {
      const btn = document.getElementById("nav-check-updates");
      if (btn && !btn.disabled) {
        e.preventDefault();
        btn.click();
      }
    }
  });
}

// ---------- Boot ----------

(async function () {
  try {
    await loadAndRender();
    await refreshUpdateButtonState();
    setupMRKeyboardShortcuts();
  } catch (e) {
    console.error("[My AO3 Algorithm] My Reading boot failed:", e);
    document.getElementById("page-subtitle").textContent = "Couldn't load your reading data — see console.";
  }
})();
