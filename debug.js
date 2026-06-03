// debug.js — wires up the debug console UI to the database layer in db.js.
// Phase 2 only. This page is for diagnostics: add records, view what's stored,
// delete individual records, and clear entire drawers.

const STORE_LIST = ["preferences", "history", "ficCache", "authorAffinity", "customRows", "settings", "dislikeHistory"];

function $(id) { return document.getElementById(id); }

function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast" + (isError ? " error" : "");
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2400);
}

function csv(s) {
  // turn "a, b ,c" into ["a","b","c"], drop empties
  return (s || "").split(",").map(x => x.trim()).filter(Boolean);
}

function fmt(record) {
  // pretty-print a record for the list, JSON-style but compact
  return JSON.stringify(record, null, 2);
}

// ---------- Render ----------

async function renderCounts() {
  const parts = [];
  for (const name of STORE_LIST) {
    const n = await dbCount(name);
    parts.push(`${name}: ${n}`);
    const span = $(`count-${name}`);
    if (span) span.textContent = `(${n})`;
  }
  // Phase 7d: Save for Later is a view over the history store filtered to
  // state="save_for_later"; count it separately for the section header.
  const histAll = await dbGetAll("history");
  const sflCount = histAll.filter(h => {
    ensureHistoryState(h);
    return h.state === "save_for_later";
  }).length;
  const sflSpan = $("count-saveForLater");
  if (sflSpan) sflSpan.textContent = `(${sflCount})`;
  $("counts").textContent = parts.join("  ·  ");
}

function makeRecordItem(storeName, key, body) {
  const li = document.createElement("li");
  const bodyDiv = document.createElement("div");
  bodyDiv.className = "record-body";
  bodyDiv.textContent = body;
  const btn = document.createElement("button");
  btn.className = "tiny";
  btn.textContent = "Delete";
  btn.addEventListener("click", async () => {
    try {
      await dbDelete(storeName, key);
      toast(`Deleted from ${storeName}`);
      await renderAll();
    } catch (e) {
      toast(`Delete failed: ${e.message}`, true);
    }
  });
  li.appendChild(bodyDiv);
  li.appendChild(btn);
  return li;
}

function emptyItem(text) {
  const li = document.createElement("li");
  li.className = "empty";
  li.textContent = text;
  return li;
}

async function renderList(storeName, listId, keyField) {
  const ul = $(listId);
  ul.innerHTML = "";
  const all = await dbGetAll(storeName);
  if (all.length === 0) {
    ul.appendChild(emptyItem("(no records)"));
    return;
  }
  for (const rec of all) {
    ul.appendChild(makeRecordItem(storeName, rec[keyField], fmt(rec)));
  }
}

async function renderSaveForLater() {
  const ul = $("list-saveForLater");
  ul.innerHTML = "";
  const [histAll, ficAll] = await Promise.all([
    dbGetAll("history"),
    dbGetAll("ficCache")
  ]);
  const ficById = new Map(ficAll.map(f => [f.ficId, f]));

  const rows = histAll
    .map(h => ensureHistoryState(h))
    .filter(h => h.state === "save_for_later")
    .sort((a, b) => String(b.lastOpened || "").localeCompare(String(a.lastOpened || "")));

  if (rows.length === 0) {
    ul.appendChild(emptyItem("(no save_for_later records)"));
    return;
  }

  for (const rec of rows) {
    const fic = ficById.get(rec.ficId);
    const now = fic && fic.chapters ? fic.chapters : "(not cached)";
    const atSave = rec.chaptersAtSave || "(none)";
    const delta = `${atSave} → ${now}`;

    const li = document.createElement("li");
    const bodyDiv = document.createElement("div");
    bodyDiv.className = "record-body";
    const title = rec.title || "(no title)";
    const author = rec.author || "?";
    const blocked = rec.autoPromoteBlocked === true ? " [autoPromoteBlocked]" : "";
    bodyDiv.textContent =
      `${title}\nby ${author}\nficId: ${rec.ficId}\nchapters: ${delta}${blocked}\n` +
      `maxChapterRead: ${rec.maxChapterRead ?? "null"}, maxScrollOnChapter: ${rec.maxScrollOnChapter ?? "null"}, ` +
      `totalReadingTimeMinutes: ${rec.totalReadingTimeMinutes ?? 0}\nlastOpened: ${rec.lastOpened || "(never)"}`;

    const promoteBtn = document.createElement("button");
    promoteBtn.className = "tiny";
    promoteBtn.textContent = "Promote to reading";
    promoteBtn.addEventListener("click", async () => {
      try {
        const fresh = await dbGet("history", rec.ficId);
        if (!fresh) { toast("Record vanished — refreshing", true); await renderAll(); return; }
        fresh.state = "reading";
        fresh.autoPromoteBlocked = false;
        await dbPut("history", fresh);
        toast(`Promoted ${rec.ficId} to reading`);
        await renderAll();
      } catch (e) {
        toast(`Promote failed: ${e.message}`, true);
      }
    });

    const delBtn = document.createElement("button");
    delBtn.className = "tiny";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      try {
        await dbDelete("history", rec.ficId);
        toast(`Deleted history ${rec.ficId}`);
        await renderAll();
      } catch (e) {
        toast(`Delete failed: ${e.message}`, true);
      }
    });

    li.appendChild(bodyDiv);
    li.appendChild(promoteBtn);
    li.appendChild(delBtn);
    ul.appendChild(li);
  }
}

async function renderDislikeHistory() {
  const ul = $("list-dislikeHistory");
  ul.innerHTML = "";
  const recs = await listDislikeHistory(50);

  if (recs.length === 0) {
    ul.appendChild(emptyItem("(no dislike records yet)"));
    return;
  }

  for (const rec of recs) {
    const li = document.createElement("li");
    const bodyDiv = document.createElement("div");
    bodyDiv.className = "record-body";

    const when = rec.timestamp
      ? new Date(rec.timestamp).toLocaleString()
      : "(unknown when)";
    const reasonLines = (rec.reasons || [])
      .map(r => "  • " + (window.formatDislikeReason ? window.formatDislikeReason(r) : JSON.stringify(r)))
      .join("\n") || "  (no reasons)";
    const changeLines = (rec.changes || [])
      .map(c => "  → " + (window.formatDislikeChange ? window.formatDislikeChange(c) : JSON.stringify(c)))
      .join("\n") || "  (no changes applied — log only)";

    bodyDiv.textContent =
      `${rec.title || "(no title)"}\nby ${rec.author || "?"} · ficId ${rec.ficId}\n` +
      `When: ${when}\n` +
      `Reasons:\n${reasonLines}\n` +
      `Changes:\n${changeLines}\n` +
      `canUndo: ${rec.canUndo === false ? "no (preferences modified since)" : "yes"}`;

    const undoBtn = document.createElement("button");
    undoBtn.className = "tiny";
    if (rec.canUndo === false) {
      undoBtn.textContent = "Cannot undo";
      undoBtn.disabled = true;
    } else {
      undoBtn.textContent = "Undo";
      undoBtn.addEventListener("click", async () => {
        try {
          const res = await window.undoDislikeFromHistory(rec.id);
          if (res.ok) {
            toast(`Undone dislike #${rec.id}`);
          } else if (res.reason === "modified") {
            toast("Cannot undo — preferences modified since.", true);
          } else {
            toast(`Undo failed: ${res.reason}`, true);
          }
          await renderAll();
        } catch (e) {
          toast(`Undo failed: ${e.message}`, true);
        }
      });
    }

    const delBtn = document.createElement("button");
    delBtn.className = "tiny";
    delBtn.textContent = "Delete record";
    delBtn.addEventListener("click", async () => {
      try {
        await deleteDislikeRecord(rec.id);
        toast(`Deleted dislike record #${rec.id}`);
        await renderAll();
      } catch (e) {
        toast(`Delete failed: ${e.message}`, true);
      }
    });

    li.appendChild(bodyDiv);
    li.appendChild(undoBtn);
    li.appendChild(delBtn);
    ul.appendChild(li);
  }
}

async function renderAll() {
  await renderCounts();
  await Promise.all([
    renderList("preferences",    "list-preferences",    "id"),
    renderList("history",        "list-history",        "ficId"),
    renderList("ficCache",       "list-ficCache",       "ficId"),
    renderList("authorAffinity", "list-authorAffinity", "author"),
    renderList("customRows",     "list-customRows",     "rowName"),
    renderList("settings",       "list-settings",       "id"),
    renderSaveForLater(),
    renderDislikeHistory()
  ]);
}

// ---------- Wiring ----------

function wirePreferences() {
  $("add-preferred-tag").addEventListener("click", async () => {
    const value = $("pt-value").value.trim();
    if (!value) return toast("Tag name required", true);
    const weight = parseInt($("pt-weight").value, 10);
    const locked = $("pt-locked").checked;
    await setPreferredTag(value, weight, locked);
    $("pt-value").value = "";
    toast(`Saved preferred_tag: ${value} (weight ${weight}${locked ? ", locked" : ""})`);
    await renderAll();
  });

  $("add-blocked-tag").addEventListener("click", async () => {
    const value = $("bt-value").value.trim();
    if (!value) return toast("Tag name required", true);
    await setBlockedTag(value);
    $("bt-value").value = "";
    toast(`Saved blocked_tag: ${value}`);
    await renderAll();
  });

  $("add-preferred-fandom").addEventListener("click", async () => {
    const value = $("pf-value").value.trim();
    if (!value) return toast("Fandom name required", true);
    const weight = parseInt($("pf-weight").value, 10);
    const locked = $("pf-locked").checked;
    await setPreferredFandom(value, weight, locked);
    $("pf-value").value = "";
    toast(`Saved preferred_fandom: ${value} (weight ${weight}${locked ? ", locked" : ""})`);
    await renderAll();
  });

  $("add-blocked-author").addEventListener("click", async () => {
    const value = $("ba-value").value.trim();
    if (!value) return toast("Author username required", true);
    await setBlockedAuthor(value);
    $("ba-value").value = "";
    toast(`Saved blocked_author: ${value}`);
    await renderAll();
  });

  $("set-structural").addEventListener("click", async () => {
    const minWords = $("sp-min").value ? parseInt($("sp-min").value, 10) : null;
    const maxWords = $("sp-max").value ? parseInt($("sp-max").value, 10) : null;
    const ratings = Array.from(document.querySelectorAll(".sp-rating:checked")).map(el => el.value);
    const completeOnly = $("sp-complete").checked;
    await setStructuralPreferences({ minWords, maxWords, ratings, completeOnly });
    toast("Saved structural preferences");
    await renderAll();
  });
}

function wireHistory() {
  $("add-history").addEventListener("click", async () => {
    const ficId = $("h-ficId").value.trim();
    if (!ficId) return toast("ficId required", true);
    const now = new Date().toISOString();
    const existing = await dbGet("history", ficId);
    const record = {
      ficId,
      title: $("h-title").value.trim() || null,
      author: $("h-author").value.trim() || null,
      firstOpened: existing ? existing.firstOpened : now,
      lastOpened: now,
      lastChapterRead: $("h-chapter").value ? parseInt($("h-chapter").value, 10) : null,
      scrollProgress: $("h-scroll").value ? parseInt($("h-scroll").value, 10) : null,
      readingTime: $("h-time").value ? parseInt($("h-time").value, 10) : null,
      userVerdict: $("h-verdict").value || null,
      dislikeReason: existing ? existing.dislikeReason : null
    };
    await dbPut("history", record);
    toast(`Saved history: ${ficId}`);
    await renderAll();
  });
}

function wireFicCache() {
  $("add-fic").addEventListener("click", async () => {
    const ficId = $("f-ficId").value.trim();
    if (!ficId) return toast("ficId required", true);
    const now = new Date().toISOString();
    const record = {
      ficId,
      title: $("f-title").value.trim() || null,
      author: $("f-author").value.trim() || null,
      summary: $("f-summary").value.trim() || null,
      fandoms: csv($("f-fandoms").value),
      relationships: csv($("f-relationships").value),
      characters: csv($("f-characters").value),
      freeformTags: csv($("f-freeform").value),
      warnings: csv($("f-warnings").value),
      rating: $("f-rating").value || null,
      wordCount: $("f-words").value ? parseInt($("f-words").value, 10) : null,
      chapters: $("f-chapters").value.trim() || null,
      kudos: $("f-kudos").value ? parseInt($("f-kudos").value, 10) : null,
      hits: $("f-hits").value ? parseInt($("f-hits").value, 10) : null,
      comments: $("f-comments").value ? parseInt($("f-comments").value, 10) : null,
      bookmarks: $("f-bookmarks").value ? parseInt($("f-bookmarks").value, 10) : null,
      isComplete: $("f-complete").checked,
      lastUpdated: now,
      scrapedAt: now
    };
    await dbPut("ficCache", record);
    toast(`Saved fic ${ficId}`);
    await renderAll();
  });
}

function wireAuthorAffinity() {
  $("add-affinity").addEventListener("click", async () => {
    const author = $("aa-author").value.trim();
    if (!author) return toast("Author required", true);
    const record = {
      author,
      ficsRead: $("aa-read").value ? parseInt($("aa-read").value, 10) : 0,
      ficsCompleted: $("aa-completed").value ? parseInt($("aa-completed").value, 10) : 0,
      averageReadingTime: $("aa-time").value ? parseInt($("aa-time").value, 10) : null,
      affinityScore: $("aa-score").value ? parseFloat($("aa-score").value) : 0,
      negativeTagCombos: csv($("aa-negcombos").value)
    };
    await dbPut("authorAffinity", record);
    toast(`Saved author affinity: ${author}`);
    await renderAll();
  });
}

function wireCustomRows() {
  $("add-row").addEventListener("click", async () => {
    const rowName = $("cr-name").value.trim();
    if (!rowName) return toast("rowName required", true);
    const record = {
      rowName,
      includeTags: csv($("cr-include").value),
      excludeTags: csv($("cr-exclude").value),
      minWords: $("cr-min").value ? parseInt($("cr-min").value, 10) : null,
      maxWords: $("cr-max").value ? parseInt($("cr-max").value, 10) : null,
      ratings: csv($("cr-ratings").value),
      completeOnly: $("cr-complete").checked,
      sortBy: $("cr-sort").value,
      position: $("cr-position").value ? parseInt($("cr-position").value, 10) : 0
    };
    await dbPut("customRows", record);
    toast(`Saved custom row: ${rowName}`);
    await renderAll();
  });
}

async function loadSettingsIntoForm() {
  const s = await getSettings();
  if (!s) return;
  $("s-delay").value = s.scrapeDelaySeconds ?? "";
  $("s-pull").value = s.scheduledPullIntervalHours ?? "";
  $("s-bsthreshold").value = s.behavioralSignalsThreshold ?? "";
  $("s-retention").value = s.historyRetentionDays ?? "";
  $("s-theme").value = s.theme || "dark";
  $("s-backoff").checked = !!s.backoffOn429;
  $("s-bsenabled").checked = !!s.behavioralSignalsEnabled;
}

function wireSettings() {
  $("save-settings").addEventListener("click", async () => {
    const record = {
      id: "main",
      scrapeDelaySeconds: $("s-delay").value ? parseInt($("s-delay").value, 10) : 10,
      scheduledPullIntervalHours: $("s-pull").value ? parseInt($("s-pull").value, 10) : 8,
      behavioralSignalsThreshold: $("s-bsthreshold").value ? parseInt($("s-bsthreshold").value, 10) : 10,
      historyRetentionDays: $("s-retention").value ? parseInt($("s-retention").value, 10) : null,
      theme: $("s-theme").value,
      backoffOn429: $("s-backoff").checked,
      behavioralSignalsEnabled: $("s-bsenabled").checked
    };
    await dbPut("settings", record);
    toast("Settings saved");
    await renderAll();
  });
}

function wireClearButtons() {
  document.querySelectorAll("[data-clear]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const store = btn.dataset.clear;
      const ok = confirm(`Clear ALL records in "${store}"? This cannot be undone.`);
      if (!ok) return;
      await dbClear(store);
      if (store === "settings") {
        // re-seed defaults so the app keeps working
        await ensureDefaultSettings();
        await loadSettingsIntoForm();
        toast(`Cleared ${store} and re-seeded defaults`);
      } else {
        toast(`Cleared ${store}`);
      }
      await renderAll();
    });
  });
}

function wireHeaderButtons() {
  $("reload-all").addEventListener("click", async () => {
    await renderAll();
    await loadSettingsIntoForm();
    toast("Reloaded");
  });
  $("reset-settings").addEventListener("click", async () => {
    if (!confirm("Reset all settings to factory defaults?")) return;
    await resetSettingsToDefaults();
    await loadSettingsIntoForm();
    toast("Settings reset to defaults");
    await renderAll();
  });
}

// ---------- Last scrape panel ----------

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderLastScrape(scrape) {
  const el = $("last-scrape");
  if (!scrape) {
    el.textContent = "No scrape recorded yet. Browse AO3 (logged in) to populate.";
    return;
  }
  const parseErrs = scrape.parseErrors || [];
  const saveErrs = scrape.saveErrors || [];
  const totalErrs = parseErrs.length + saveErrs.length;
  const savedClass = scrape.saved === scrape.found && scrape.found > 0 ? "good" : (scrape.saved > 0 ? "" : "bad");

  let html = "";
  html += `<span class="label">URL:</span> ${escapeHtml(scrape.url)}\n`;
  html += `<span class="label">Page type:</span> ${escapeHtml(scrape.pageType)}\n`;
  html += `<span class="label">Scraped at:</span> ${escapeHtml(scrape.timestamp)}\n`;
  html += `<span class="label">Found:</span> ${scrape.found} fic(s)\n`;
  html += `<span class="label">Saved:</span> <span class="${savedClass}">${scrape.saved} / ${scrape.found}</span>\n`;
  html += `<span class="label">Skipped:</span> ${scrape.skipped}\n`;
  html += `<span class="label">Errors:</span> <span class="${totalErrs ? "bad" : ""}">${parseErrs.length} parse, ${saveErrs.length} save</span>\n`;

  if (parseErrs.length) {
    html += `\n<strong>Parse errors:</strong>\n`;
    for (const e of parseErrs) {
      html += `<span class="error-row">  • ${escapeHtml(e)}</span>\n`;
    }
  }
  if (saveErrs.length) {
    html += `\n<strong>Save errors:</strong>\n`;
    for (const e of saveErrs) {
      html += `<span class="error-row">  • ${escapeHtml(e)}</span>\n`;
    }
  }

  if (scrape.titles && scrape.titles.length) {
    html += `\n<div class="fic-list"><strong>Fics captured (${scrape.titles.length}):</strong>\n`;
    for (const t of scrape.titles) {
      const src = t.source ? ` [${t.source}]` : "";
      html += `<span class="fic-row">  ${escapeHtml(t.ficId)} — ${escapeHtml(t.title || "(no title)")} by ${escapeHtml(t.author || "?")}${escapeHtml(src)}</span>\n`;
    }
    html += `</div>`;
  }
  el.innerHTML = html;
}

async function loadAndRenderLastScrape() {
  try {
    const { lastScrape } = await browser.storage.local.get("lastScrape");
    renderLastScrape(lastScrape);
  } catch (e) {
    console.error("loadAndRenderLastScrape failed:", e);
  }
}

function wireStorageListener() {
  // Auto-update when the background script records a new scrape.
  if (browser.storage && browser.storage.onChanged) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.lastScrape) {
        renderLastScrape(changes.lastScrape.newValue);
        renderCounts(); // keep ficCache count fresh too
        renderList("ficCache", "list-ficCache", "ficId");
      }
    });
  }
}

// ---------- Scoring test panel ----------

function _signClass(n) {
  if (n > 0) return "bd-pos";
  if (n < 0) return "bd-neg";
  return "bd-zero";
}

function _formatBreakdown(breakdown) {
  if (!breakdown.passed) {
    return `<span class="bd-key">REJECTED:</span> <span class="bd-neg">${escapeHtml(breakdown.rejectedReason)}</span>`;
  }

  const lines = [];
  const tm = breakdown.tagMatches;
  const tagMatchedStr = tm.matched.length ? tm.matched.join(", ") : "(none)";
  lines.push(`<span class="bd-key">tagMatches:</span>     <span class="${_signClass(tm.applied)}">${tm.applied}</span>  <span class="bd-key">(raw ${tm.raw}, matched: ${escapeHtml(tagMatchedStr)})</span>`);

  const fm = breakdown.fandomMatches;
  const fandomMatchedStr = fm.matched.length ? fm.matched.join(", ") : "(none)";
  lines.push(`<span class="bd-key">fandomMatches:</span>  <span class="${_signClass(fm.applied)}">${fm.applied}</span>  <span class="bd-key">(raw ${fm.raw}, matched: ${escapeHtml(fandomMatchedStr)})</span>`);

  const bs = breakdown.browsingStyle;
  const bsLine = bs.boostedField
    ? `${bs.multiplier}× on ${bs.boostedField} (mode: ${bs.mode})`
    : `none (mode: ${bs.mode || "unset"})`;
  lines.push(`<span class="bd-key">browsingStyle:</span>  <span class="bd-key">${escapeHtml(bsLine)}</span>`);

  const aa = breakdown.authorAffinity;
  lines.push(`<span class="bd-key">authorAffinity:</span> <span class="${_signClass(aa.score)}">${aa.score}</span>  <span class="bd-key">(reads: ${aa.reads})</span>`);

  const pop = breakdown.popularity;
  lines.push(`<span class="bd-key">popularity:</span>     <span class="${_signClass(pop.score)}">${pop.score}</span>  <span class="bd-key">(kudos: ${pop.kudos})</span>`);

  const fr = breakdown.freshness;
  lines.push(`<span class="bd-key">freshness:</span>      <span class="${_signClass(fr.score)}">${fr.score}</span>  <span class="bd-key">(${fr.state})</span>`);

  const j = breakdown.jitter;
  lines.push(`<span class="bd-key">jitter:</span>         <span class="${_signClass(j.score)}">${j.score}</span>  <span class="bd-key">(range ±${j.range})</span>`);

  const beh = breakdown.behavioral;
  lines.push(`<span class="bd-key">behavioral:</span>     <span class="${_signClass(beh.score)}">${beh.score}</span>  <span class="bd-key">(${beh.enabled ? "enabled" : "stub/disabled"})</span>`);

  lines.push(`<span class="bd-total">total: <span class="${_signClass(breakdown.total)}">${breakdown.total}</span></span>`);
  return lines.join("\n");
}

function renderScoreRow(rank, item, isRejected = false) {
  const details = document.createElement("details");
  details.className = "score-row" + (isRejected ? " rejected" : "");

  const summary = document.createElement("summary");
  const title = item.fic.title || "(no title)";
  const author = item.fic.author || "?";
  const ficId = item.fic.ficId;
  const scoreStr = isRejected ? "—" : item.score;
  summary.innerHTML =
    `<span class="rank">${rank}</span>` +
    `<span class="score-num">${scoreStr}</span>` +
    `<span class="title-line">${escapeHtml(title)} <span class="by">by ${escapeHtml(author)}</span><span class="ficid">[${escapeHtml(ficId)}]</span></span>`;
  details.appendChild(summary);

  const bd = document.createElement("div");
  bd.className = "score-breakdown";
  bd.innerHTML = _formatBreakdown(item.breakdown);
  details.appendChild(bd);

  return details;
}

function renderScoreResults(payload, opts = {}) {
  const { results, rejected, stats } = payload;
  const showRejected = !!opts.showRejected;
  const limit = opts.limit ?? 20;

  const stEl = $("score-stats");
  stEl.innerHTML =
    `<span class="stat-label">Cached fics:</span> ${stats.total}  ·  ` +
    `<span class="stat-label">Kept:</span> <span class="stat-good">${stats.kept}</span>  ·  ` +
    `<span class="stat-label">Rejected (hard filter):</span> <span class="${stats.rejected ? "stat-bad" : "stat-label"}">${stats.rejected}</span>  ·  ` +
    `<span class="stat-label">Time:</span> ${stats.ms} ms`;

  const out = $("score-results");
  out.innerHTML = "";

  if (results.length === 0 && rejected.length === 0) {
    const empty = document.createElement("div");
    empty.style.padding = "16px";
    empty.style.color = "var(--muted)";
    empty.textContent = "No fics in cache. Browse AO3 (or run setup with seed-feed) to populate.";
    out.appendChild(empty);
    return;
  }

  const top = results.slice(0, limit);
  top.forEach((item, i) => out.appendChild(renderScoreRow(i + 1, item)));

  if (showRejected && rejected.length) {
    const sep = document.createElement("div");
    sep.style.cssText = "padding:8px 12px;color:var(--muted);font-size:12px;border-top:1px solid var(--border);background:var(--panel-2);";
    sep.textContent = `— Rejected by hard filter (${rejected.length}) —`;
    out.appendChild(sep);
    rejected.slice(0, limit).forEach((item, i) =>
      out.appendChild(renderScoreRow(i + 1, item, true))
    );
  }
}

function renderSingleScore(item) {
  const out = $("score-results");
  out.innerHTML = "";
  $("score-stats").innerHTML =
    `<span class="stat-label">Single fic scored:</span> ${escapeHtml(item.fic.ficId)} — ` +
    `<span class="${item.breakdown.passed ? "stat-good" : "stat-bad"}">` +
    `${item.breakdown.passed ? "passed" : "rejected"}</span>`;
  out.appendChild(renderScoreRow(1, item, !item.breakdown.passed));
  // Open it by default for convenience.
  out.querySelector("details").open = true;
}

function wireScoring() {
  $("score-all-btn").addEventListener("click", async () => {
    try {
      $("score-stats").textContent = "Scoring…";
      const rowType = $("score-rowtype").value;
      const showRejected = $("score-show-rejected").checked;
      const payload = await scoreAllCachedFics(rowType);
      renderScoreResults(payload, { showRejected, limit: 20 });
      toast(`Scored ${payload.stats.total} fics in ${payload.stats.ms} ms`);
    } catch (e) {
      console.error("Scoring failed:", e);
      toast(`Scoring failed: ${e.message}`, true);
      $("score-stats").innerHTML = `<span class="stat-bad">Error: ${escapeHtml(e.message)}</span>`;
    }
  });

  $("score-one-btn").addEventListener("click", async () => {
    const ficId = $("score-one-id").value.trim();
    if (!ficId) return toast("Enter a ficId first", true);
    try {
      const rowType = $("score-rowtype").value;
      const item = await scoreOneCachedFic(ficId, rowType);
      if (!item) {
        toast(`ficId ${ficId} not in cache`, true);
        $("score-stats").innerHTML = `<span class="stat-bad">ficId ${escapeHtml(ficId)} not found in ficCache.</span>`;
        $("score-results").innerHTML = "";
        return;
      }
      renderSingleScore(item);
    } catch (e) {
      console.error("Single score failed:", e);
      toast(`Score failed: ${e.message}`, true);
    }
  });
}

// ---------- Boot ----------

(async function init() {
  try {
    await openDB();
    await ensureDefaultSettings();
    wirePreferences();
    wireHistory();
    wireFicCache();
    wireAuthorAffinity();
    wireCustomRows();
    wireSettings();
    wireClearButtons();
    wireHeaderButtons();
    wireStorageListener();
    wireScoring();
    await loadSettingsIntoForm();
    await loadAndRenderLastScrape();
    await renderAll();
  } catch (e) {
    console.error("Debug init failed:", e);
    toast(`Init failed: ${e.message}`, true);
  }
})();
