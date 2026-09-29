// background.js
// Runs in the extension's background context. Responsibilities:
//   - Seed default settings on startup.
//   - Open onboarding the first time the extension is installed.
//   - Register the daily subscriptions-sync alarm (Phase 7b).
//   - Listen for messages from content scripts and the onboarding page:
//       PAGE_SCRAPED                — content.js sends parsed fics for caching
//       CHECK_AO3_LOGIN             — onboarding asks "is the user logged into AO3?"
//       FETCH_FIC                   — onboarding asks us to fetch a single fic by URL
//                                     (used for "loved fics" onboarding step)
//       SEED_FEED                   — onboarding asks us to fetch listing pages for the
//                                     top-weighted tags/fandoms, with delays between
//       SET_USERNAME                — content.js passes the logged-in AO3 username (Phase 7b)
//       SUBSCRIBED_AUTHORS_SCRAPED  — content.js sends a parsed Users-tab list (Phase 7b)
//       SYNC_SUBSCRIPTIONS          — feed.js "Sync now" button (Phase 7b)
//       HISTORY_VISIT               — content.js fires when a fic page loads (Phase 7c)
//       HISTORY_TIME_TICK           — content.js accrues active reading time (Phase 7c)
//       HISTORY_SCROLL              — content.js reports scroll % through chapter (Phase 7c)
//       SAVE_TOGGLE                 — content.js toggles save_for_later / reading / none (Phase 7d)

console.log("[My AO3 Algorithm] Background script loaded.");

const SUBS_SYNC_ALARM = "subscriptions-daily-sync";
const SUBS_SYNC_PERIOD_MINUTES = 60 * 24; // once per day

// Phase 12: scheduled-pull alarm. Period comes from settings.scheduledPullIntervalHours.
// Re-registered when the user changes the interval in Preferences.
const SCHEDULED_PULL_ALARM = "scheduled-pull";
const BACKOFF_429_WINDOW_MS = 24 * 60 * 60 * 1000;  // 24h backoff after a 429
const ONOPEN_STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000;  // on-open refreshes if >4h since last pull
const LOGIN_CHECK_TTL_MS = 10 * 60 * 1000;  // cache logged-in result for 10 min

// Module-scoped state (lives for the life of the background context).
let _loginCheckCache = { result: null, at: 0 };
// Shared in-flight guard for ALL background scraping jobs (scheduled pull,
// subs sync, future reading-update checker). They share the 10-sec politeness
// budget, so only one can run at a time. handleRunManualRefresh chains
// pull → subs sync serially — each acquires the guard, releases it, then the
// next can acquire.
let _backgroundJobInFlight = false;

// ---------- Startup ----------

(async () => {
  try {
    const { created } = await ensureDefaultSettings();
    console.log("[My AO3 Algorithm] Settings", created ? "seeded with defaults" : "already present");
  } catch (e) {
    console.error("[My AO3 Algorithm] ensureDefaultSettings failed:", e);
  }

  // Phase 7b: register the daily subscriptions sync alarm. browser.alarms
  // persists across browser restarts; create() is idempotent — if an alarm
  // with this name already exists it's replaced rather than duplicated.
  try {
    browser.alarms.create(SUBS_SYNC_ALARM, {
      delayInMinutes: 5,                 // first run 5 min after startup
      periodInMinutes: SUBS_SYNC_PERIOD_MINUTES
    });
    console.log("[My AO3 Algorithm] Subscriptions alarm registered (daily).");
  } catch (e) {
    console.error("[My AO3 Algorithm] alarms.create failed:", e);
  }

  // Phase 12: register the scheduled-pull alarm at the user's configured
  // interval. applyScheduledPullAlarm reads the current settings each time,
  // so we re-call it from the settings handler when the user changes the
  // interval to swap the alarm out.
  try {
    await applyScheduledPullAlarm();
  } catch (e) {
    console.error("[My AO3 Algorithm] scheduled-pull alarm registration failed:", e);
  }
})();

browser.runtime.onInstalled.addListener((details) => {
  // Only on fresh install — not on every dev-mode reload (those fire "update").
  if (details.reason === "install") {
    browser.tabs.create({ url: browser.runtime.getURL("onboarding.html") });
  }
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  // Phase 12: pause toggle gates BOTH alarms — when on, all background
  // scraping stops. Manual refresh and on-open refresh ignore the pause.
  let paused = false;
  try {
    const s = await getSettings();
    paused = !!(s && s.scheduledPullsPaused);
  } catch {}

  if (alarm.name === SUBS_SYNC_ALARM) {
    if (paused) {
      console.log("[My AO3 Algorithm] subs-sync alarm: skipped (paused)");
      return;
    }
    runSubscriptionsSync({ source: "alarm" }).catch(e =>
      console.error("[My AO3 Algorithm] scheduled subscriptions sync failed:", e)
    );
  } else if (alarm.name === SCHEDULED_PULL_ALARM) {
    if (paused) {
      console.log("[My AO3 Algorithm] scheduled-pull alarm: skipped (paused)");
      return;
    }
    runScheduledPull({ source: "alarm" }).catch(e =>
      console.error("[My AO3 Algorithm] scheduled pull failed:", e)
    );
  }
});

// ---------- Helpers shared by handlers ----------

// AO3's tag URLs replace "/" with "*s*" inside the tag name.
// Other special characters are URL-encoded normally.
function ao3TagUrl(tag) {
  const slashReplaced = tag.replace(/\//g, "*s*");
  const encoded = encodeURIComponent(slashReplaced).replace(/%2A/g, "*");
  return `https://archiveofourown.org/tags/${encoded}/works`;
}

// Phase 13: every AO3 fetch gets a hard timeout so a hung connection can't
// stall an alarm-driven job for minutes. 30s comfortably covers AO3's
// slow-but-alive responses without leaving the browser holding the bag if
// the site is genuinely down.
const AO3_FETCH_TIMEOUT_MS = 30000;

async function _fetchWithTimeout(url, opts = {}, timeoutMs = AO3_FETCH_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchAndParseDoc(url) {
  const resp = await _fetchWithTimeout(url, {
    credentials: "include",
    headers: { "Accept": "text/html" }
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  const html = await resp.text();
  return new DOMParser().parseFromString(html, "text/html");
}

// Some ficCache fields are populated only by parseFicPage (the per-fic
// detailed parser); blurb-page parses don't see them. Without merging,
// a later blurb scrape overwriting the same ficId would wipe these
// fields. upsertFicCache preserves them when the new record is missing
// the value — they don't change between scrapes anyway, so re-fetching
// per-fic info just to repopulate would waste requests.
const FIC_CACHE_PRESERVE_FIELDS = ["chapterIds"];

async function upsertFicCache(fic) {
  const existing = await dbGet("ficCache", fic.ficId);
  if (existing) {
    for (const key of FIC_CACHE_PRESERVE_FIELDS) {
      if (existing[key] != null && fic[key] == null) {
        fic[key] = existing[key];
      }
    }
  }
  return dbPut("ficCache", fic);
}

// ---------- Message handlers ----------

async function handlePageScraped(message) {
  const payload = message.payload || {};
  const fics = Array.isArray(payload.fics) ? payload.fics : [];
  let saved = 0;
  const saveErrors = [];

  for (const fic of fics) {
    try {
      await upsertFicCache(fic);
      saved++;
    } catch (e) {
      saveErrors.push(`${fic.ficId || "?"}: ${e.message}`);
    }
  }

  const summary = {
    url: payload.url,
    pageType: payload.pageType,
    timestamp: payload.timestamp,
    found: fics.length,
    saved,
    skipped: payload.skipped || 0,
    parseErrors: payload.errors || [],
    saveErrors,
    titles: fics.slice(0, 50).map(f => ({
      ficId: f.ficId, title: f.title, author: f.author, source: f.source
    }))
  };

  try { await browser.storage.local.set({ lastScrape: summary }); }
  catch (e) { console.error("[My AO3 Algorithm] storage.local.set failed:", e); }

  console.log(
    `[My AO3 Algorithm] ${payload.pageType}: cached ${saved}/${fics.length}` +
    (saveErrors.length ? ` (${saveErrors.length} save errors)` : "") +
    ((payload.errors || []).length ? ` (${payload.errors.length} parse errors)` : "")
  );

  return { saved, found: fics.length };
}

async function handleCheckLogin() {
  try {
    const doc = await fetchAndParseDoc("https://archiveofourown.org/");
    const loggedIn = !isLoggedOut(doc);
    return { loggedIn };
  } catch (e) {
    console.error("[My AO3 Algorithm] CHECK_AO3_LOGIN failed:", e);
    return { loggedIn: null, error: e.message };
  }
}

async function handleFetchFic(message) {
  const url = message.url;
  if (!url || !/\/works\/\d+/.test(url)) {
    return { ok: false, error: "Not an AO3 work URL" };
  }
  try {
    const doc = await fetchAndParseDoc(url);
    const pathname = new URL(url).pathname;
    const fic = parseFicPage(doc, pathname);
    await upsertFicCache(fic);

    // For onboarding "loved fics", also create/update a history record
    // marked userVerdict: "loved". Phase 7d: loved fics start in state="reading"
    // since the user explicitly flagged them as favorites — no save_for_later
    // ambiguity there.
    if (message.markLoved) {
      const now = new Date().toISOString();
      const existing = await dbGet("history", fic.ficId);
      await dbPut("history", {
        ficId: fic.ficId,
        title: fic.title,
        author: fic.author,
        firstOpened: existing ? existing.firstOpened : now,
        lastOpened: now,
        lastChapterRead: existing ? existing.lastChapterRead : null,
        maxChapterRead: existing ? (existing.maxChapterRead || null) : null,
        chapterTotal: existing ? (existing.chapterTotal || null) : null,
        scrollProgressOnLastChapter: existing ? (existing.scrollProgressOnLastChapter || null) : null,
        maxScrollOnChapter: existing ? (existing.maxScrollOnChapter || null) : null,
        totalReadingTimeMinutes: existing ? (existing.totalReadingTimeMinutes || 0) : 0,
        state: "reading",
        autoPromoteBlocked: false,
        chaptersAtSave: existing ? (existing.chaptersAtSave || null) : null,
        userVerdict: "loved",
        dislikeReason: existing ? existing.dislikeReason : null
      });
    }

    return {
      ok: true,
      fic: { ficId: fic.ficId, title: fic.title, author: fic.author, fandoms: fic.fandoms }
    };
  } catch (e) {
    console.error("[My AO3 Algorithm] FETCH_FIC failed for", url, e);
    return { ok: false, error: e.message };
  }
}

async function handleSeedFeed(message) {
  // Don't await — kick off in background, return immediately so the
  // onboarding page can subscribe to seedProgress via storage.onChanged.
  runSeedFeed(message.payload || {}).catch(e => {
    console.error("[My AO3 Algorithm] runSeedFeed crashed:", e);
    browser.storage.local.set({
      seedProgress: { status: "error", message: e.message }
    });
  });
  return { started: true };
}

async function runSeedFeed({ browsingStyle, delaySeconds }) {
  const type = browsingStyle === "fandom-first" ? "preferred_fandom" : "preferred_tag";
  const prefs = await getPreferencesByType(type);
  prefs.sort((a, b) => (b.weight || 0) - (a.weight || 0));
  const top = prefs.slice(0, 3);

  if (top.length === 0) {
    await browser.storage.local.set({
      seedProgress: { status: "error", message: `No ${type.replace("_", " ")} records found.` }
    });
    return;
  }

  const settings = await getSettings();
  const delayMs = (delaySeconds ?? settings?.scrapeDelaySeconds ?? 10) * 1000;

  for (let i = 0; i < top.length; i++) {
    const term = top[i].value;
    await browser.storage.local.set({
      seedProgress: { status: "fetching", current: i + 1, total: top.length, term }
    });

    try {
      const url = ao3TagUrl(term);
      const doc = await fetchAndParseDoc(url);
      const blurbs = doc.querySelectorAll("li.work.blurb, li.bookmark.blurb");
      let saved = 0;
      let skipped = 0;
      for (const blurb of blurbs) {
        try {
          const fic = parseBlurb(blurb);
          await upsertFicCache(fic);
          saved++;
        } catch {
          skipped++;
        }
      }
      console.log(`[Seed] "${term}": cached ${saved}/${blurbs.length} (${skipped} skipped)`);
    } catch (e) {
      console.error(`[Seed] "${term}" failed:`, e);
    }

    if (i < top.length - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  await browser.storage.local.set({
    seedProgress: { status: "done", current: top.length, total: top.length }
  });
}

// ---------- Phase 7b: username + subscriptions sync ----------

async function handleSetUsername(message) {
  const username = (message.username || "").trim();
  if (!username) return { ok: false, reason: "empty" };
  try {
    const settings = (await getSettings()) || {};
    if (settings.ao3Username === username) return { ok: true, changed: false };
    settings.ao3Username = username;
    await dbPut("settings", settings);
    console.log(`[My AO3 Algorithm] captured ao3Username="${username}"`);
    return { ok: true, changed: true };
  } catch (e) {
    console.error("[My AO3 Algorithm] SET_USERNAME failed:", e);
    return { ok: false, error: e.message };
  }
}

async function handleSubscribedAuthorsScraped(message) {
  const users = Array.isArray(message.users) ? message.users : [];
  try {
    const summary = await syncSubscribedAuthors(users);
    const settings = (await getSettings()) || {};
    settings.subscriptionsLastSyncAt = summary.syncedAt;
    await dbPut("settings", settings);
    console.log(
      `[My AO3 Algorithm] subs-users: ${summary.total} total ` +
      `(+${summary.added} new, ~${summary.updated} seen again, -${summary.removed} gone)`
    );
    return { ok: true, ...summary };
  } catch (e) {
    console.error("[My AO3 Algorithm] SUBSCRIBED_AUTHORS_SCRAPED failed:", e);
    return { ok: false, error: e.message };
  }
}

async function runSubscriptionsSync({ source } = {}) {
  // Two-step: fetch the Users tab to refresh the subscribed-author list, then
  // fetch the Works tab to top up ficCache with recent works from those
  // authors. The Works-tab scrape is best-effort — if it fails we still keep
  // the new author list.

  // Shared guard: bail if another background job is mid-flight (scheduled
  // pull, another subs sync, future reading-update checker).
  if (_backgroundJobInFlight) {
    return { ok: false, reason: "in_flight", source };
  }

  const settings = (await getSettings()) || {};
  const username = settings.ao3Username;
  if (!username) {
    console.log(`[subs-sync ${source || "manual"}] skipped: no ao3Username captured yet`);
    return { ok: false, reason: "no_username" };
  }

  // Fail fast if the user is logged out — AO3 returns a login page and the
  // scrape would be meaningless.
  try {
    const loginDoc = await fetchAndParseDoc("https://archiveofourown.org/");
    if (isLoggedOut(loginDoc)) {
      console.log(`[subs-sync ${source || "manual"}] skipped: logged out`);
      return { ok: false, reason: "logged_out" };
    }
  } catch (e) {
    console.warn(`[subs-sync ${source || "manual"}] login probe failed, will try anyway:`, e.message);
  }

  _backgroundJobInFlight = true;
  const delayMs = (settings.scrapeDelaySeconds ?? 10) * 1000;
  const report = { source: source || "manual", username };

  try {

  // ---- Step 1: Users tab ----
  const usersUrl = `https://archiveofourown.org/users/${encodeURIComponent(username)}/subscriptions?type=users`;
  try {
    const doc = await fetchAndParseDoc(usersUrl);
    const users = parseSubscriptionsUsers(doc);
    const summary = await syncSubscribedAuthors(users);
    const s = (await getSettings()) || {};
    s.subscriptionsLastSyncAt = summary.syncedAt;
    await dbPut("settings", s);
    report.users = summary;
    console.log(
      `[subs-sync ${report.source}] users tab: ${summary.total} total ` +
      `(+${summary.added}, ~${summary.updated}, -${summary.removed})`
    );
  } catch (e) {
    console.error(`[subs-sync ${report.source}] users tab failed:`, e);
    report.usersError = e.message;
  }

  // ---- Step 2: Works tab (after spacing delay) ----
  await new Promise(r => setTimeout(r, delayMs));
  const worksUrl = `https://archiveofourown.org/users/${encodeURIComponent(username)}/subscriptions?type=works`;
  try {
    const doc = await fetchAndParseDoc(worksUrl);
    const blurbs = doc.querySelectorAll("li.work.blurb, li.bookmark.blurb");
    let saved = 0, skipped = 0;
    for (const blurb of blurbs) {
      try {
        const fic = parseBlurb(blurb);
        await upsertFicCache(fic);
        saved++;
      } catch {
        skipped++;
      }
    }
    report.works = { found: blurbs.length, saved, skipped };
    console.log(`[subs-sync ${report.source}] works tab: cached ${saved}/${blurbs.length} (${skipped} skipped)`);
  } catch (e) {
    console.error(`[subs-sync ${report.source}] works tab failed:`, e);
    report.worksError = e.message;
  }

  report.ok = true;
  return report;
  } finally {
    _backgroundJobInFlight = false;
  }
}

async function handleSyncSubscriptions() {
  return runSubscriptionsSync({ source: "manual" });
}

// ---------- Phase 12: scheduled pulls + manual + on-open refresh ----------
//
// One core: runScheduledPull picks the user's top fandoms and tags by weight,
// fetches each tag-listing page with the politeness delay between requests,
// upserts results into ficCache, and returns a summary. Three callers share
// it — the alarm (source="alarm"), the feed page on first open if the cache
// is stale (source="onopen"), and the Preferences "Refresh now" button
// (source="manual"). Manual additionally runs the subscriptions sync.

async function applyScheduledPullAlarm() {
  // Read interval from settings, then (re)create the alarm. Idempotent —
  // alarms.create replaces an alarm of the same name. Called at startup
  // and whenever the user changes scheduledPullIntervalHours in Preferences.
  const settings = (await getSettings()) || {};
  const hours = Number(settings.scheduledPullIntervalHours) || 8;
  await browser.alarms.clear(SCHEDULED_PULL_ALARM).catch(() => {});
  browser.alarms.create(SCHEDULED_PULL_ALARM, {
    delayInMinutes: Math.max(5, hours * 30),  // first run after half an interval, never less than 5 min
    periodInMinutes: hours * 60
  });
  console.log(`[My AO3 Algorithm] Scheduled-pull alarm set: every ${hours}h`);
}

function _isInBackoff(settings) {
  const at = settings && settings.backoffOn429At;
  if (!at) return false;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return false;
  return (Date.now() - ms) < BACKOFF_429_WINDOW_MS;
}

async function _setBackoffOn429() {
  try {
    const s = (await getSettings()) || {};
    s.backoffOn429At = new Date().toISOString();
    s.backoffOn429 = true;
    await dbPut("settings", s);
  } catch (e) {
    console.warn("[My AO3 Algorithm] couldn't set backoff flag:", e);
  }
}

async function _checkLoggedInCached() {
  // Fetching the AO3 homepage to check the logout link is ~50KB; cache the
  // result for LOGIN_CHECK_TTL_MS so back-to-back pulls don't re-fetch.
  const now = Date.now();
  if (_loginCheckCache.result !== null && (now - _loginCheckCache.at) < LOGIN_CHECK_TTL_MS) {
    return _loginCheckCache.result;
  }
  try {
    const doc = await fetchAndParseDoc("https://archiveofourown.org/");
    const loggedIn = !isLoggedOut(doc);
    _loginCheckCache = { result: loggedIn, at: now };
    return loggedIn;
  } catch (e) {
    // Network error — be conservative and treat as logged-out so we don't
    // fire a bunch of failing fetches.
    console.warn("[My AO3 Algorithm] login check failed:", e.message);
    return null;
  }
}

async function _selectScheduledPullTargets(cap) {
  // Top-N targets across preferred fandoms + tags, weighted by the user's
  // heart picks (5 > 3 > 1). Tiebreak: fandoms before tags (broader landing
  // pages = more fics per fetch), then alphabetical for stability.
  //
  // At cap=3 (on-open) we get the user's top 3 priorities. At cap=20 (deep
  // manual pull) we dip well into mid-weight items, giving broader coverage
  // when subsequent pulls of the same top-3 produce diminishing returns.
  const [fandoms, tags] = await Promise.all([
    getPreferencesByType("preferred_fandom"),
    getPreferencesByType("preferred_tag")
  ]);
  const combined = [
    ...fandoms.map(p => ({ kind: "fandom", value: p.value, weight: p.weight || 0 })),
    ...tags.map(p => ({ kind: "tag", value: p.value, weight: p.weight || 0 }))
  ];
  combined.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    if (a.kind !== b.kind) return a.kind === "fandom" ? -1 : 1;
    return String(a.value).localeCompare(String(b.value));
  });
  return combined.slice(0, cap);
}

async function _scrapeOneTarget(target) {
  // Returns { saved, found, status } where status is "ok" | "rate_limited" |
  // "error". Used by the pull loop to decide whether to bail.
  const url = ao3TagUrl(target.value);
  let resp;
  try {
    resp = await _fetchWithTimeout(url, { credentials: "include", headers: { "Accept": "text/html" } });
  } catch (e) {
    return { saved: 0, found: 0, status: "error", error: e.name === "AbortError" ? "timeout" : e.message };
  }
  if (resp.status === 429) {
    return { saved: 0, found: 0, status: "rate_limited" };
  }
  if (!resp.ok) {
    return { saved: 0, found: 0, status: "error", error: `HTTP ${resp.status}` };
  }
  let doc;
  try {
    const html = await resp.text();
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch (e) {
    return { saved: 0, found: 0, status: "error", error: e.message };
  }
  const blurbs = doc.querySelectorAll("li.work.blurb, li.bookmark.blurb");
  let saved = 0;
  for (const blurb of blurbs) {
    try {
      const fic = parseBlurb(blurb);
      await upsertFicCache(fic);
      saved++;
    } catch {}
  }
  return { saved, found: blurbs.length, status: "ok" };
}

async function runScheduledPull({ source = "alarm", cap = null } = {}) {
  // Shared in-flight guard — if any background scraping job is already
  // running (scheduled pull, subs sync, future reading-update checker),
  // skip rather than double-fetch. They share the 10-sec politeness budget.
  if (_backgroundJobInFlight) {
    return { ok: false, reason: "in_flight", source };
  }

  const settings = (await getSettings()) || {};
  const isManual = source === "manual";
  // Resolve the page budget. Explicit cap wins (on-open passes 3 to stay
  // fast); otherwise use the user-configured pagesPerRefresh.
  const effectiveCap = cap != null ? cap : _resolvePagesPerRefresh(settings);

  // Backoff: scheduled and on-open respect the flag; manual ignores it
  // (user explicitly asked).
  if (!isManual && _isInBackoff(settings)) {
    return { ok: false, reason: "backoff_active", source };
  }

  // Logged-out gate — ALL sources skip the listing scrape, but manual returns
  // a distinct reason so the UI can toast appropriately.
  const loggedIn = await _checkLoggedInCached();
  if (loggedIn === false) {
    return { ok: false, reason: "logged_out", source };
  }

  const targets = await _selectScheduledPullTargets(effectiveCap);
  if (targets.length === 0) {
    return { ok: false, reason: "no_targets", source };
  }

  _backgroundJobInFlight = true;
  const delayMs = (settings.scrapeDelaySeconds ?? 10) * 1000;
  const report = { source, targets: targets.length, saved: 0, found: 0, errors: [], hit429: false };

  try {
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      // Broadcast progress before each fetch so the feed's "Get more" button
      // (or any other listener) can show "Getting more… 4 of 20". The receiver
      // may not exist (no feed page open); ignore the inevitable rejection.
      _broadcastPullProgress({ source, current: i + 1, total: targets.length, target: t });
      const result = await _scrapeOneTarget(t);
      if (result.status === "rate_limited") {
        await _setBackoffOn429();
        report.hit429 = true;
        report.errors.push(`429 on ${t.kind} "${t.value}"`);
        break;  // stop the rest of the pull
      }
      if (result.status === "error") {
        report.errors.push(`${t.kind} "${t.value}": ${result.error || "unknown"}`);
      } else {
        report.saved += result.saved;
        report.found += result.found;
      }
      if (i < targets.length - 1) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    // Stamp the completion time so the on-open staleness check has data.
    try {
      const s = (await getSettings()) || {};
      s.lastScheduledPull = new Date().toISOString();
      await dbPut("settings", s);
    } catch {}
    report.ok = true;
    return report;
  } finally {
    _backgroundJobInFlight = false;
  }
}

function _broadcastPullProgress(payload) {
  // Fire-and-forget. If no extension page has a runtime.onMessage listener
  // registered, sendMessage rejects with "Could not establish connection";
  // that's expected and harmless.
  try {
    browser.runtime.sendMessage({ type: "PULL_PROGRESS", ...payload }).catch(() => {});
  } catch {}
}

function _resolvePagesPerRefresh(settings) {
  const v = Number(settings && settings.pagesPerRefresh);
  const allowed = [3, 6, 10, 15, 20];
  return allowed.includes(v) ? v : 6;
}

async function handleRunOnOpenRefresh() {
  // Called from feed.js init() — fire-and-forget from the page's perspective,
  // but we still await here so the response shape carries the result for the
  // page to decide whether to show "refreshed" UI.
  const settings = (await getSettings()) || {};
  const last = settings.lastScheduledPull ? Date.parse(settings.lastScheduledPull) : 0;
  if (last && (Date.now() - last) < ONOPEN_STALE_THRESHOLD_MS) {
    return { ok: false, reason: "fresh_enough" };
  }
  return runScheduledPull({ source: "onopen", cap: 3 });
}

async function handleRunManualRefresh() {
  // Manual ignores both the pause toggle and the 429-backoff window — the
  // user explicitly asked. Runs the pull then the subs sync. Cap comes from
  // the pagesPerRefresh setting (3/6/10/15/20).
  const pull = await runScheduledPull({ source: "manual" });
  if (pull && pull.reason === "logged_out") {
    return { ok: false, reason: "logged_out" };
  }
  let subs = null;
  try {
    subs = await runSubscriptionsSync({ source: "manual" });
  } catch (e) {
    console.warn("[My AO3 Algorithm] manual refresh subs sync failed:", e);
  }
  return { ok: true, pull, subs };
}

async function handleApplyScheduledPullAlarm() {
  // Called by Preferences when the user changes the interval or pause toggle.
  await applyScheduledPullAlarm();
  return { ok: true };
}

// ---------- Phase 12 Round 2: reading-list update check ----------
//
// User-triggered from the My Reading page. Fetches each active reading WIP
// in turn, diffs the resulting cache entry against the pre-fetch snapshot,
// reports which fics gained chapters or flipped to complete.
//
// Eligibility (all must hold):
//   - history.state === "reading"
//   - fic exists in ficCache (else we have no chapter data anyway)
//   - fic isn't already complete
//   - history.lastOpened within the last 90 days
//   - fic.scrapedAt is older than READING_CHECK_RECENT_MS (or absent), so
//     repeat clicks naturally advance through the user's reading list in
//     batches of READING_CHECK_CAP instead of re-checking the same 25
//
// Sorted by lastOpened desc, capped at READING_CHECK_CAP (25). Honors the
// shared in-flight guard and scrapeDelaySeconds spacing.

const READING_CHECK_CAP = 25;
const READING_CHECK_LAST_OPENED_MS = 90 * 24 * 60 * 60 * 1000;
const READING_CHECK_RECENT_MS = 60 * 60 * 1000;  // skip fics scraped within last hour

async function _collectActiveReadingFics() {
  // Returns the eligibility list, sorted by lastOpened desc, NOT yet capped.
  // The caller decides whether to cap (the check itself does, but the count
  // handler reports the full eligible total).
  const [history, settings] = await Promise.all([
    dbGetAll("history"),
    getSettings()
  ]);
  void settings;  // reserved for future tunables; currently no per-user knobs
  const cutoffLastOpened = Date.now() - READING_CHECK_LAST_OPENED_MS;
  const cutoffScrapedAt  = Date.now() - READING_CHECK_RECENT_MS;

  const eligible = [];
  for (const h of history) {
    if (!h || h.state !== "reading") continue;
    const lastOpenedMs = h.lastOpened ? Date.parse(h.lastOpened) : 0;
    if (!Number.isFinite(lastOpenedMs) || lastOpenedMs < cutoffLastOpened) continue;

    const fic = await dbGet("ficCache", h.ficId);
    if (!fic) continue;                    // no cache = nothing to diff against
    if (fic.isComplete === true) continue; // already done — nothing to check

    const scrapedAtMs = fic.scrapedAt ? Date.parse(fic.scrapedAt) : 0;
    if (Number.isFinite(scrapedAtMs) && scrapedAtMs > cutoffScrapedAt) continue;

    eligible.push({ history: h, fic });
  }
  eligible.sort((a, b) =>
    Date.parse(b.history.lastOpened) - Date.parse(a.history.lastOpened)
  );
  return eligible;
}

async function handleCountActiveReadingFics() {
  // Cheap empty-state check fired by My Reading on page load. Returns the
  // eligible count so the page can disable the button when zero.
  try {
    const eligible = await _collectActiveReadingFics();
    return { ok: true, eligible: eligible.length, cap: READING_CHECK_CAP };
  } catch (e) {
    console.error("[My AO3 Algorithm] COUNT_ACTIVE_READING_FICS failed:", e);
    return { ok: false, error: e.message };
  }
}

async function handleRunReadingUpdateCheck() {
  return runReadingUpdateCheck();
}

async function runReadingUpdateCheck() {
  // Shared in-flight guard with scheduled pull + subs sync — they share the
  // 10-sec politeness budget, so only one can run at a time.
  if (_backgroundJobInFlight) {
    return { ok: false, reason: "in_flight" };
  }

  const loggedIn = await _checkLoggedInCached();
  if (loggedIn === false) {
    return { ok: false, reason: "logged_out" };
  }

  const eligible = await _collectActiveReadingFics();
  if (eligible.length === 0) {
    return { ok: true, eligibleTotal: 0, checked: 0, failures: 0, updatedFicIds: [], updatedTitles: [], hitCap: false, hit429: false };
  }

  const eligibleTotal = eligible.length;
  const batch = eligible.slice(0, READING_CHECK_CAP);
  const hitCap = eligibleTotal > READING_CHECK_CAP;

  _backgroundJobInFlight = true;
  const settings = (await getSettings()) || {};
  const delayMs = (settings.scrapeDelaySeconds ?? 10) * 1000;
  const updatedFicIds = [];
  const updatedTitles = [];
  let checked = 0;
  let failures = 0;
  let hit429 = false;

  try {
    for (let i = 0; i < batch.length; i++) {
      const { history: h, fic: oldFic } = batch[i];

      // Broadcast progress before each fetch. My Reading filters by
      // source==="update_check" to drive its live button text.
      _broadcastPullProgress({
        source: "update_check",
        current: i + 1,
        total: batch.length,
        target: { kind: "fic", value: h.ficId }
      });

      const url = `https://archiveofourown.org/works/${encodeURIComponent(h.ficId)}`;
      let resp;
      try {
        resp = await _fetchWithTimeout(url, { credentials: "include", headers: { "Accept": "text/html" } });
      } catch (e) {
        console.warn(`[update-check] fetch failed for ${h.ficId}:`, e.name === "AbortError" ? "timeout" : e.message);
        failures++;
        if (i < batch.length - 1) await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      if (resp.status === 429) {
        await _setBackoffOn429();
        hit429 = true;
        break;
      }
      if (!resp.ok) {
        console.warn(`[update-check] HTTP ${resp.status} for ${h.ficId}`);
        failures++;
        if (i < batch.length - 1) await new Promise(r => setTimeout(r, delayMs));
        continue;
      }

      let newFic;
      try {
        const html = await resp.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        newFic = parseFicPage(doc, `/works/${h.ficId}`);
      } catch (e) {
        console.warn(`[update-check] parse failed for ${h.ficId}:`, e.message);
        failures++;
        if (i < batch.length - 1) await new Promise(r => setTimeout(r, delayMs));
        continue;
      }

      await upsertFicCache(newFic);
      checked++;

      // Diff: chapters published went up, OR isComplete flipped false→true.
      const oldChap = _parseChapters(oldFic.chapters || "").current;
      const newChap = _parseChapters(newFic.chapters || "").current;
      const chapterAdvanced = Number.isFinite(newChap) && Number.isFinite(oldChap) && newChap > oldChap;
      const flippedComplete = oldFic.isComplete !== true && newFic.isComplete === true;
      if (chapterAdvanced || flippedComplete) {
        updatedFicIds.push(h.ficId);
        updatedTitles.push(newFic.title || h.title || h.ficId);
      }

      if (i < batch.length - 1) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  } finally {
    _backgroundJobInFlight = false;
  }

  return {
    ok: true,
    eligibleTotal,
    checked,
    failures,
    updatedFicIds,
    updatedTitles,
    hitCap,
    hit429
  };
}

// ---------- Phase 13 Round 4: AO3 bookmarks importer ----------
//
// User-triggered from Preferences > Backup. Walks the user's AO3
// /bookmarks pages, parses each blurb, upserts the fic into ficCache, and
// for any bookmark whose ficId isn't already in history, seeds a
// save_for_later history record. Fics already in history (whatever state)
// are left alone — we never overwrite existing state.
//
// Politeness: 30s timeout per fetch, scrapeDelaySeconds between pages,
// 429 stops the run and arms the standard backoff window. Hard cap of
// BOOKMARKS_IMPORT_PAGE_CAP pages per run; if reached, the toast tells
// the user to click again to continue.

const BOOKMARKS_IMPORT_PAGE_CAP = 50;

async function handleRunBookmarksImport() {
  return runBookmarksImport();
}

async function runBookmarksImport() {
  if (_backgroundJobInFlight) {
    return { ok: false, reason: "in_flight" };
  }

  const settings = (await getSettings()) || {};
  const username = settings.ao3Username;
  if (!username) {
    return { ok: false, reason: "no_username" };
  }

  const loggedIn = await _checkLoggedInCached();
  if (loggedIn === false) {
    return { ok: false, reason: "logged_out" };
  }

  _backgroundJobInFlight = true;
  const delayMs = (settings.scrapeDelaySeconds ?? 10) * 1000;

  let imported = 0;
  let skipped = 0;
  let pagesScanned = 0;
  let totalBlurbs = 0;
  let hit429 = false;
  let networkFail = false;
  let hitPageCap = false;
  let stoppedReason = null;

  try {
    for (let page = 1; page <= BOOKMARKS_IMPORT_PAGE_CAP; page++) {
      _broadcastPullProgress({
        source: "bookmarks_import",
        current: page,
        total: null,
        imported,
        skipped,
        target: { kind: "bookmarks_page", value: page }
      });

      const url = `https://archiveofourown.org/users/${encodeURIComponent(username)}/bookmarks?page=${page}`;
      let resp;
      try {
        resp = await _fetchWithTimeout(url, {
          credentials: "include",
          headers: { "Accept": "text/html" }
        });
      } catch (e) {
        console.warn(`[bookmarks-import] fetch failed for page ${page}:`,
          e.name === "AbortError" ? "timeout" : e.message);
        networkFail = true;
        stoppedReason = "network";
        break;
      }
      if (resp.status === 429) {
        await _setBackoffOn429();
        hit429 = true;
        stoppedReason = "rate_limit";
        break;
      }
      if (!resp.ok) {
        console.warn(`[bookmarks-import] HTTP ${resp.status} on page ${page}`);
        networkFail = true;
        stoppedReason = "network";
        break;
      }

      let doc;
      try {
        const html = await resp.text();
        doc = new DOMParser().parseFromString(html, "text/html");
      } catch (e) {
        console.warn(`[bookmarks-import] parse failed on page ${page}:`, e.message);
        networkFail = true;
        stoppedReason = "parse";
        break;
      }

      // Defense in depth: session may have expired mid-run.
      if (isLoggedOut(doc)) {
        stoppedReason = "logged_out";
        return { ok: false, reason: "logged_out", imported, skipped, pagesScanned };
      }

      const blurbs = doc.querySelectorAll("li.bookmark.blurb, li.work.blurb");
      pagesScanned++;
      if (blurbs.length === 0) {
        stoppedReason = "no_blurbs";
        break;
      }

      for (const blurb of blurbs) {
        totalBlurbs++;
        let fic;
        try {
          fic = parseBlurb(blurb);
        } catch {
          // External-link bookmarks and deleted works land here — just skip.
          continue;
        }
        if (!fic || !fic.ficId) continue;

        // Cache the fic so the feed can score it.
        try { await upsertFicCache(fic); } catch {}

        // Don't touch existing history records — the user may have read or
        // explicitly saved/aside-d this fic and we never overwrite state.
        const existing = await dbGet("history", fic.ficId);
        if (existing) {
          skipped++;
          continue;
        }

        const now = new Date().toISOString();
        const record = _baseHistoryRecord(fic.ficId, null);
        record.title = fic.title || null;
        record.author = fic.author || null;
        record.firstOpened = now;
        record.lastOpened = now;
        record.state = "save_for_later";
        record.autoPromoteBlocked = false;
        record.chaptersAtSave = fic.chapters || null;
        record.chapterTotal = (() => {
          const m = (fic.chapters || "").match(/\/(\d+)$/);
          return m ? parseInt(m[1], 10) : null;
        })();
        try { await dbPut("history", record); imported++; } catch (e) {
          console.warn(`[bookmarks-import] put failed for ${fic.ficId}:`, e.message);
        }
      }

      // Stop when there's no next-page link. AO3 marks the next pagination
      // link with rel="next"; absence means we're on the last page.
      const nextLink = doc.querySelector("ol.pagination a[rel='next']");
      if (!nextLink) {
        stoppedReason = "end_of_pages";
        break;
      }

      // Hit the cap on this iteration? Note it, since the loop terminates
      // naturally after this body without an explicit break.
      if (page === BOOKMARKS_IMPORT_PAGE_CAP) {
        hitPageCap = true;
        stoppedReason = "page_cap";
        break;
      }

      // Politeness delay before the next page fetch.
      await new Promise(r => setTimeout(r, delayMs));
    }
  } finally {
    _backgroundJobInFlight = false;
  }

  return {
    ok: true,
    imported,
    skipped,
    pagesScanned,
    totalBlurbs,
    hit429,
    networkFail,
    hitPageCap,
    stoppedReason
  };
}

// ---------- Phase 7c: passive reading-history tracking ----------
//
// History records (keyPath: ficId) accumulate passively as the user reads AO3
// fic pages. Content.js sends three messages — VISIT (on load), TIME_TICK
// (per minute of active reading), and SCROLL (as the reader scrolls). Each
// handler upserts the record, preserving fields the message didn't touch.
//
// Schema (all fields optional after the key):
//   ficId, title, author                 — identity
//   firstOpened, lastOpened              — ISO timestamps
//   lastChapterRead                      — most recent chapter ordinal viewed
//   maxChapterRead                       — monotonic: never decreases
//   chapterTotal                         — captured from the page's stats row
//   scrollProgressOnLastChapter          — latest % observed on lastChapterRead
//   maxScrollOnChapter                   — max % on the current chapter;
//                                          resets when maxChapterRead advances
//   totalReadingTimeMinutes              — running sum of active-reading ticks
//   userVerdict, dislikeReason           — onboarding-loved flag + future UI
//
// Phase 7d adds three fields:
//   state                ("save_for_later" | "reading") — see db.js / ensureHistoryState
//   autoPromoteBlocked   bool; set by "Set aside" button, cleared on next VISIT
//   chaptersAtSave       raw "N/M" string captured when entering save_for_later,
//                        used by the debug console to show "1/5 → 1/7" deltas

function _baseHistoryRecord(ficId, existing) {
  return {
    ficId,
    title: existing?.title || null,
    author: existing?.author || null,
    firstOpened: existing?.firstOpened || null,
    lastOpened: existing?.lastOpened || null,
    lastChapterRead: existing?.lastChapterRead || null,
    maxChapterRead: existing?.maxChapterRead || null,
    chapterTotal: existing?.chapterTotal || null,
    scrollProgressOnLastChapter: existing?.scrollProgressOnLastChapter || null,
    maxScrollOnChapter: existing?.maxScrollOnChapter || null,
    totalReadingTimeMinutes: existing?.totalReadingTimeMinutes || 0,
    state: existing?.state || null,
    autoPromoteBlocked: existing?.autoPromoteBlocked === true,
    chaptersAtSave: existing?.chaptersAtSave || null,
    userVerdict: existing?.userVerdict || null,
    dislikeReason: existing?.dislikeReason || null
  };
}

// Centralized auto-promote check. Returns true if the record's state was
// changed (caller is responsible for persisting). Respects autoPromoteBlocked,
// which is toggled on by the explicit "Set aside" button to stop a just-saved
// fic from instantly bouncing back to "reading".
function _maybeAutoPromote(record) {
  if (!record) return false;
  if (record.state !== "save_for_later") return false;
  if (record.autoPromoteBlocked === true) return false;
  const scrollHit = (record.maxScrollOnChapter || 0) > AUTO_PROMOTE_SCROLL_PCT;
  const timeHit = (record.totalReadingTimeMinutes || 0) >= AUTO_PROMOTE_MINUTES;
  if (scrollHit || timeHit) {
    record.state = "reading";
    return true;
  }
  return false;
}

async function handleHistoryVisit(message) {
  const ficId = message.ficId;
  if (!ficId) return { ok: false, reason: "no_ficId" };
  const existing = await dbGet("history", ficId);
  const now = message.timestamp || new Date().toISOString();
  const isNew = !existing;
  const record = _baseHistoryRecord(ficId, existing);

  record.title = message.title || record.title;
  record.author = message.author || record.author;
  record.firstOpened = record.firstOpened || now;
  record.lastOpened = now;

  // Chapter bookkeeping: we only advance maxChapterRead if the visit gives us
  // a concrete chapter number. Full-work view returns null, which means "can't
  // confirm a specific chapter" — we deliberately don't bump the max in that
  // case (over-counting is not acceptable per Phase 7c design).
  const prevMax = record.maxChapterRead || 0;
  if (message.chapterCurrent != null) {
    record.lastChapterRead = message.chapterCurrent;
    if (message.chapterCurrent > prevMax) {
      record.maxChapterRead = message.chapterCurrent;
      // Moving to a new chapter: the "current chapter" scroll state resets.
      record.scrollProgressOnLastChapter = 0;
      record.maxScrollOnChapter = 0;
    } else if (message.chapterCurrent < prevMax) {
      // Re-reading an earlier chapter — don't touch max scroll, which is
      // pinned to the chapter they're furthest into. Reset the "last" scroll
      // since the value tracked was for a different chapter.
      record.scrollProgressOnLastChapter = 0;
    }
  }
  if (message.chapterTotal != null) {
    record.chapterTotal = message.chapterTotal;
  }

  // Phase 7d state handling.
  // - New records default to save_for_later and snapshot the chapter string
  //   so the debug console can show "1/5 → 1/7" deltas later.
  // - Existing records get their state inferred if missing (legacy migration),
  //   then autoPromoteBlocked is cleared — a fresh visit means "I came back
  //   to read this", so the 'Set aside' block from a prior session ends here.
  // - A new visit can itself auto-promote (e.g. the initial scroll=0 message
  //   doesn't promote, but re-opening a fic the user previously read most of
  //   will — maxScrollOnChapter carries over when they stay on the same chapter).
  if (isNew) {
    record.state = "save_for_later";
    record.autoPromoteBlocked = false;
    record.chaptersAtSave = message.chapters || null;
  } else {
    ensureHistoryState(record);
    record.autoPromoteBlocked = false;
  }
  _maybeAutoPromote(record);

  await dbPut("history", record);
  return { ok: true, state: record.state };
}

async function handleHistoryTimeTick(message) {
  const ficId = message.ficId;
  if (!ficId) return { ok: false, reason: "no_ficId" };
  const existing = await dbGet("history", ficId);
  if (!existing) {
    // Visit message hasn't landed yet — drop the tick rather than seeding a
    // record without the fic's metadata.
    return { ok: false, reason: "no_visit_yet" };
  }
  const minutes = Number(message.minutes) || 0;
  if (minutes <= 0) return { ok: true, total: existing.totalReadingTimeMinutes || 0, state: existing.state };

  existing.totalReadingTimeMinutes = Math.round(
    ((existing.totalReadingTimeMinutes || 0) + minutes) * 100
  ) / 100;
  existing.lastOpened = message.timestamp || existing.lastOpened;
  ensureHistoryState(existing);
  _maybeAutoPromote(existing);
  await dbPut("history", existing);
  return { ok: true, total: existing.totalReadingTimeMinutes, state: existing.state };
}

async function handleHistoryScroll(message) {
  const ficId = message.ficId;
  if (!ficId) return { ok: false, reason: "no_ficId" };
  const existing = await dbGet("history", ficId);
  if (!existing) return { ok: false, reason: "no_visit_yet" };

  const pct = Math.max(0, Math.min(100, Math.round(Number(message.scrollPercent) || 0)));

  // If the scroll report is for a chapter the visit handler hasn't recorded
  // yet (race condition between fast scroll and visit dispatch), we fall back
  // to treating it as the current chapter.
  const ch = message.chapterCurrent;
  if (ch != null && existing.lastChapterRead != null && ch !== existing.lastChapterRead) {
    // Scroll arrived for a different chapter than the visit last recorded —
    // ignore it. The next visit will re-anchor.
    return { ok: false, reason: "chapter_mismatch", state: existing.state };
  }

  existing.scrollProgressOnLastChapter = pct;
  existing.maxScrollOnChapter = Math.max(existing.maxScrollOnChapter || 0, pct);
  existing.lastOpened = message.timestamp || existing.lastOpened;
  ensureHistoryState(existing);
  _maybeAutoPromote(existing);
  await dbPut("history", existing);
  return { ok: true, state: existing.state };
}

// ---------- Phase 7d: explicit Save button ----------
//
// Three-way toggle driven by the in-page button:
//   - no record yet           → create a save_for_later record + snapshot chapters
//   - state === save_for_later → unsave: delete the record entirely
//   - state === reading        → "Set aside": flip to save_for_later, arm
//                                autoPromoteBlocked so the current session
//                                doesn't immediately re-promote, re-snapshot
//                                chaptersAtSave to "now"
//
// Unsave deletes rather than archives because save_for_later records carry
// ~zero meaningful progress data, and deleting lets Your Authors re-include
// the fic naturally (it filters by "is in history at all").

async function handleSaveToggle(message) {
  const ficId = message.ficId;
  if (!ficId) return { ok: false, reason: "no_ficId" };
  const existing = await dbGet("history", ficId);
  const now = message.timestamp || new Date().toISOString();

  if (!existing) {
    const record = _baseHistoryRecord(ficId, null);
    record.title = message.title || null;
    record.author = message.author || null;
    record.firstOpened = now;
    record.lastOpened = now;
    record.lastChapterRead = message.chapterCurrent != null ? message.chapterCurrent : null;
    record.maxChapterRead = message.chapterCurrent != null ? message.chapterCurrent : null;
    record.chapterTotal = message.chapterTotal != null ? message.chapterTotal : null;
    record.state = "save_for_later";
    record.autoPromoteBlocked = false;
    record.chaptersAtSave = message.chapters || null;
    await dbPut("history", record);
    return { ok: true, action: "saved", state: "save_for_later" };
  }

  ensureHistoryState(existing);

  if (existing.state === "save_for_later") {
    await dbDelete("history", ficId);
    return { ok: true, action: "unsaved", state: null };
  }

  // state === "reading" → Set aside.
  existing.state = "save_for_later";
  existing.autoPromoteBlocked = true;
  existing.chaptersAtSave = message.chapters || existing.chaptersAtSave || null;
  existing.lastOpened = now;
  await dbPut("history", existing);

  // First-time-ever Set aside? Flip the flag so the in-page hint toast
  // appears exactly once across the user's whole history with the extension.
  let firstSetAside = false;
  const settings = (await getSettings()) || {};
  if (!settings.hasSeenSetAsideExplanation) {
    settings.id = "main";
    settings.hasSeenSetAsideExplanation = true;
    await dbPut("settings", settings);
    firstSetAside = true;
  }

  return { ok: true, action: "setAside", state: "save_for_later", firstSetAside };
}

// Phase 7e: hard-delete a history record. Used by the My Reading page for
// the "Archive" action on Read cards. Same end-state as Unsave on a
// save_for_later card, but exposed as its own message so callers don't have
// to first set state to save_for_later just to trigger the delete branch.
async function handleHistoryDelete(message) {
  const ficId = message?.ficId;
  if (!ficId) return { ok: false, reason: "no_ficId" };
  await dbDelete("history", ficId);
  return { ok: true, ficId };
}

// Fired by the My Reading dashboard when the user explicitly clicks
// Start Reading / Continue Reading on a card. Clears the autoPromoteBlocked
// flag for that fic so that the existing scroll/time auto-promote logic
// can move the record from save_for_later → reading once the user gets
// past the thresholds. Without this, a fic the user previously "Set
// aside" stays stuck in save_for_later even after they explicitly chose
// to resume reading. Belt-and-suspenders with handleHistoryVisit's own
// flag-clear; this fires on click, so it lands before the fic page's
// content script even loads.
async function handleClearAutopromoteBlock(message) {
  const ficId = message?.ficId;
  if (!ficId) return { ok: false, reason: "no_ficId" };
  const existing = await dbGet("history", ficId);
  if (!existing) return { ok: false, reason: "no_record" };
  if (existing.autoPromoteBlocked !== true) return { ok: true, unchanged: true };
  existing.autoPromoteBlocked = false;
  await dbPut("history", existing);
  return { ok: true };
}

// On-demand chapter ID fetch. The My Reading dashboard fires this when
// the user clicks Start/Continue Reading on a fic without cached chapter
// IDs — without those IDs we can't build a direct /chapters/[id] URL,
// and the previous fallback (?view_full_work=true) broke per-chapter
// scroll tracking and auto-promote. We fetch the bare /works/[ficId]
// page (which carries the chapter dropdown), parse the IDs, cache them,
// and return them so the dashboard can navigate to the right chapter.
//
// Returns one of:
//   { ok: true, chapterIds: [...] }      — multi-chapter, IDs cached
//   { ok: true, chapterIds: null,
//     singleChapter: true }              — fic has no chapter dropdown
//   { ok: false, reason: "fetch_failed", error }  — network / AO3 error
async function handleFetchChapterIds(message) {
  const ficId = message?.ficId;
  if (!ficId || !/^\d+$/.test(String(ficId))) {
    return { ok: false, reason: "bad_ficId" };
  }
  const url = `https://archiveofourown.org/works/${encodeURIComponent(ficId)}`;
  try {
    const doc = await fetchAndParseDoc(url);
    const chapterIds = parseChapterIdsFromDropdown(doc);
    if (!chapterIds || chapterIds.length === 0) {
      // Single-chapter fic — no dropdown is correct. Don't error; let the
      // dashboard navigate to the bare URL silently.
      return { ok: true, chapterIds: null, singleChapter: true };
    }
    // Merge IDs into ficCache. Don't downgrade a longer cached list with a
    // shorter one (defends against partial extractions).
    const existing = await dbGet("ficCache", ficId);
    if (existing) {
      const priorLen = Array.isArray(existing.chapterIds) ? existing.chapterIds.length : 0;
      if (chapterIds.length > priorLen) {
        existing.chapterIds = chapterIds.map(String);
        await dbPut("ficCache", existing);
      }
    }
    // No existing record means the fic isn't in the user's cache yet — that's
    // fine. We still return the IDs so the dashboard can route correctly; a
    // PAGE_SCRAPED message will create the record next time the user actually
    // visits the fic page.
    return { ok: true, chapterIds: chapterIds.map(String) };
  } catch (e) {
    console.error(`[My AO3 Algorithm] FETCH_CHAPTER_IDS failed for ${ficId}:`, e);
    return { ok: false, reason: "fetch_failed", error: e.message };
  }
}

// Opportunistic chapter-IDs update from content.js. Fired when the user
// is reading a fic via the full-work view (?view_full_work=true), where
// per-chapter heading links carry the IDs that the dropdown-based parser
// can't see. After this lands, the next "Continue reading" click for
// this fic uses the direct /chapters/[chapterId] URL instead of falling
// back to full-work view — and the URL-based chapter tracker takes over.
async function handleCacheChapterIds(message) {
  const ficId = message?.ficId;
  const chapterIds = message?.chapterIds;
  if (!ficId) return { ok: false, reason: "no_ficId" };
  if (!Array.isArray(chapterIds) || chapterIds.length === 0) {
    return { ok: false, reason: "no_chapterIds" };
  }
  const existing = await dbGet("ficCache", ficId);
  if (!existing) {
    // We could seed a stub record, but it'd lack the meta the parser
    // would have populated. Better to wait for a normal scrape — the
    // user is on the fic page right now, so the content script's
    // PAGE_SCRAPED message will create the record imminently.
    return { ok: false, reason: "no_cache_yet" };
  }
  // Don't downgrade a longer cached list with a shorter one — guard
  // against partial/buggy extractions overwriting good data.
  const priorLen = Array.isArray(existing.chapterIds) ? existing.chapterIds.length : 0;
  if (priorLen >= chapterIds.length) {
    return { ok: true, unchanged: true };
  }
  existing.chapterIds = chapterIds.map(String);
  await dbPut("ficCache", existing);
  return { ok: true, count: chapterIds.length };
}

// ---------- Mark as read (issue #1) ----------
//
// "I've read this" is not a new category. myreading.js already derives a
// "read" bucket from chapter progress: state === "reading" AND
// maxChapterRead >= chaptersCurrent. So marking a fic read means completing
// its progress, not inventing a `state: "read"`.
//
// That matters, because a new state value would be silently rewritten.
// ensureHistoryState (db.js:335) only preserves "save_for_later" and
// "reading"; anything else falls through to its legacy inference and comes
// back as "save_for_later". A "read" state would therefore undo itself on the
// next visit, and fresh_chapters (feed.js:142) tests `state !== "reading"`, so
// it would also stop showing new chapters for a fic the reader had finished.
// Setting progress is both simpler and the thing the rest of the code already
// understands.
//
// `unread` reverses it by restoring the previously recorded progress, so the
// button is a real toggle and not a one-way door. Stashing the old value on
// the record is what makes that possible without inventing a second field
// that could drift from maxChapterRead.

// Marking read from a card for a fic with NO history record is the common
// case, not an edge case: the feed recommends fics the reader has not opened
// here, which is the whole point of it. So the record has to be created, and
// it must be created from the fic's cached metadata rather than a page visit —
// there is no page visit, and FETCH_FIC would be a network round-trip to AO3
// for something the feed already has in ficCache.
async function handleMarkRead(message) {
  const ficId = message.ficId;
  if (!ficId) return { ok: false, reason: "no_ficId" };
  const now = message.timestamp || new Date().toISOString();
  let existing = await dbGet("history", ficId);

  if (!existing) {
    const cached = await dbGet("ficCache", ficId);
    const chapters = message.chapterTotal != null
      ? message.chapterTotal
      : parseChaptersSnapshot(cached && cached.chapters)?.total ?? null;
    if (chapters == null) {
      // Without a chapter count we cannot claim progress, and claiming 1 on a
      // 40-chapter fic displays as "read" in My Reading while being a lie.
      return { ok: false, reason: "unknown_chapter_count" };
    }
    existing = _baseHistoryRecord(ficId, null);
    existing.title = message.title || (cached && cached.title) || null;
    existing.author = message.author || (cached && cached.author) || null;
    existing.firstOpened = now;
    existing.chapterTotal = chapters;
  }

  const markRead = message.read !== false;

  if (markRead) {
    // A fic with no known chapter count is completed as far as we can tell:
    // claim the total if we have it, otherwise the last chapter we know of.
    // Claiming chapter 1 on a 40-chapter fic would be a lie that displays.
    const total = message.chapterTotal != null
      ? message.chapterTotal
      : (existing.chapterTotal != null ? existing.chapterTotal : null);

    if (existing.markedReadAt == null) {
      // Stash the real progress so "mark unread" can put it back.
      existing.progressBeforeMarkRead = existing.maxChapterRead || null;
    }
    existing.maxChapterRead = total != null ? total : Math.max(existing.maxChapterRead || 0, 1);
    existing.chapterTotal = total;
    existing.markedReadAt = now;
    // Afic marked read is by definition in progress-or-done, not parked.
    if (existing.state === "save_for_later") existing.state = "reading";
  } else {
    existing.maxChapterRead = existing.progressBeforeMarkRead != null
      ? existing.progressBeforeMarkRead
      : null;
    existing.progressBeforeMarkRead = null;
    existing.markedReadAt = null;
  }

  ensureHistoryState(existing);
  await dbPut("history", existing);
  return {
    ok: true,
    read: markRead,
    state: existing.state,
    maxChapterRead: existing.maxChapterRead,
    chapterTotal: existing.chapterTotal
  };
}

// Read-only peek at one history record. Exists so the in-page button can start
// in the right state instead of claiming "I've read this" for a fic finished
// long ago. Read-only on purpose: a page asking "what is the state" should not
// be able to create a record, or every fic page view would add a history entry
// for a fic the reader only glanced at — which would then hide it from the
// feed forever.
async function handleGetHistoryState(message) {
  const ficId = message.ficId;
  if (!ficId) return { ok: false, reason: "no_ficId" };
  const existing = await dbGet("history", ficId);
  if (!existing) return { ok: true, exists: false, state: null, markedReadAt: null };
  ensureHistoryState(existing);
  return {
    ok: true,
    exists: true,
    state: existing.state,
    markedReadAt: existing.markedReadAt || null,
    maxChapterRead: existing.maxChapterRead || null,
    chapterTotal: existing.chapterTotal || null
  };
}

// ---------- Dispatcher ----------

const handlers = {
  PAGE_SCRAPED: handlePageScraped,
  CHECK_AO3_LOGIN: handleCheckLogin,
  FETCH_FIC: handleFetchFic,
  SEED_FEED: handleSeedFeed,
  SET_USERNAME: handleSetUsername,
  SUBSCRIBED_AUTHORS_SCRAPED: handleSubscribedAuthorsScraped,
  SYNC_SUBSCRIPTIONS: handleSyncSubscriptions,
  HISTORY_VISIT: handleHistoryVisit,
  HISTORY_TIME_TICK: handleHistoryTimeTick,
  HISTORY_SCROLL: handleHistoryScroll,
  SAVE_TOGGLE: handleSaveToggle,
  MARK_READ: handleMarkRead,
  GET_HISTORY_STATE: handleGetHistoryState,
  HISTORY_DELETE: handleHistoryDelete,
  CACHE_CHAPTER_IDS: handleCacheChapterIds,
  FETCH_CHAPTER_IDS: handleFetchChapterIds,
  CLEAR_AUTOPROMOTE_BLOCK: handleClearAutopromoteBlock,
  RUN_ONOPEN_REFRESH: handleRunOnOpenRefresh,
  RUN_MANUAL_REFRESH: handleRunManualRefresh,
  APPLY_SCHEDULED_PULL_ALARM: handleApplyScheduledPullAlarm,
  COUNT_ACTIVE_READING_FICS: handleCountActiveReadingFics,
  RUN_READING_UPDATE_CHECK: handleRunReadingUpdateCheck,
  IMPORT_AO3_BOOKMARKS: handleRunBookmarksImport
};

browser.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object" || !message.type) return;
  const handler = handlers[message.type];
  if (!handler) return;
  // Returning a Promise tells Firefox to forward the resolved value as the reply.
  return handler(message);
});
