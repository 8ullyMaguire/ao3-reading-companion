// content.js — runs on every AO3 page.
// Detects the page type, calls the right parser, and sends results to the
// background script which does the actual database writes.
//
// Hard rule: passive only. No extra network requests, no interference with
// the page the user is reading. We just read the DOM.

"use strict";

(function scrape() {
  const LOG = (...args) => console.log("[My AO3 Algorithm]", ...args);
  const WARN = (...args) => console.warn("[My AO3 Algorithm]", ...args);
  const ERR = (...args) => console.error("[My AO3 Algorithm]", ...args);

  const url = window.location.href;
  const pageType = detectPageType(url);

  // Logged-out check — per design, extension is inactive when logged out.
  if (isLoggedOut(document)) {
    LOG(`inactive (logged out) on ${pageType} page`);
    return;
  }

  // Phase 7b: capture the logged-in username from any page's greeting nav so
  // background.js has it when the daily subscriptions sync fires. Fire-and-
  // forget — a stale username is harmless (sync will just fail and retry).
  try {
    const username = parseLoggedInUsername(document);
    if (username) {
      browser.runtime.sendMessage({ type: "SET_USERNAME", username }).catch(() => {});
    }
  } catch (e) {
    WARN("username capture failed:", e.message);
  }

  const result = {
    url,
    pageType,
    timestamp: new Date().toISOString(),
    fics: [],
    errors: [],
    skipped: 0
  };

  // ---- Subscriptions Users tab — not a fic list, just a roster of authors ----
  if (pageType === "subscriptions-users") {
    try {
      const users = parseSubscriptionsUsers(document);
      LOG(`subscriptions-users: parsed ${users.length} subscribed author(s)`);
      browser.runtime.sendMessage({
        type: "SUBSCRIBED_AUTHORS_SCRAPED",
        users,
        timestamp: result.timestamp
      }).catch(e => ERR("SUBSCRIBED_AUTHORS_SCRAPED sendMessage failed:", e));
    } catch (e) {
      ERR("parseSubscriptionsUsers failed:", e);
    }
    return;
  }

  // ---- Individual fic page ----
  if (pageType === "fic") {
    try {
      const fic = parseFicPage(document, window.location.pathname);
      if (fic) {
        result.fics.push(fic);
        LOG(`fic page: parsed "${fic.title}" (${fic.ficId}) by ${fic.author}`);
        // Phase 7c: attach the passive reading tracker. Event listeners keep the
        // tracker's closure alive after the IIFE returns.
        // Phase 7d: injectSaveButton shares a state-setter with the tracker so
        // the button label updates when the background auto-promotes.
        let setSaveButtonState = () => {};
        try {
          setSaveButtonState = injectSaveButton(fic);
        } catch (e) {
          WARN("save button injection failed:", e.message);
        }
        try {
          setupReadingTracker(fic, setSaveButtonState);
        } catch (e) {
          WARN("reading tracker setup failed:", e.message);
        }
      } else {
        result.errors.push("parseFicPage returned null");
      }
    } catch (e) {
      ERR("fic page parse failed:", e);
      result.errors.push(`fic-page: ${e.message}`);
    }
  }

  // ---- Listing-style blurbs (tag, fandom, bookmarks, user works, search, ...) ----
  const blurbs = document.querySelectorAll("li.work.blurb, li.bookmark.blurb");
  if (blurbs.length > 0) {
    LOG(`found ${blurbs.length} blurb(s) on ${pageType} page`);
    let idx = 0;
    for (const blurb of blurbs) {
      idx++;
      try {
        const fic = parseBlurb(blurb);
        if (fic) {
          result.fics.push(fic);
        } else {
          result.skipped++;
        }
      } catch (e) {
        WARN(`blurb #${idx} skipped:`, e.message);
        result.errors.push(`blurb #${idx}: ${e.message}`);
        result.skipped++;
      }
    }
  }

  // No fic content at all — bail without bothering the background script.
  if (result.fics.length === 0 && result.errors.length === 0) {
    LOG(`no fic content on ${pageType} page — nothing to cache`);
    return;
  }

  LOG(
    `scrape summary: ${result.fics.length} parsed, ` +
    `${result.skipped} skipped, ${result.errors.length} errors`
  );

  // Send to background for database write.
  browser.runtime.sendMessage({
    type: "PAGE_SCRAPED",
    payload: result
  }).then(
    (reply) => LOG(`background saved ${reply?.saved ?? "?"}/${result.fics.length}`),
    (e) => ERR("sendMessage failed:", e)
  );

  // ---- Phase 7c: passive reading tracker ----
  //
  // Runs on fic pages only. Observes whether the user is "actively reading"
  // (tab visible + focused + not idle) and reports three kinds of signals:
  //
  //   HISTORY_VISIT      — once on load, carries fic meta + chapter ordinal
  //   HISTORY_TIME_TICK  — every 60 s of reading time (fractional when flushed
  //                        early by a visibility/blur/unload event)
  //   HISTORY_SCROLL     — throttled to 500 ms on real scrolls; only resent when
  //                        the % changed by ≥5 since the last send
  //
  // Under-counting during sleep is fine (idle fires after 2 min of no activity
  // and time stops accruing). Over-counting is not, so nothing here treats
  // anything speculative as "read".
  function setupReadingTracker(fic, setSaveButtonState = () => {}) {
    if (!fic || !fic.ficId) return;

    const ficId = fic.ficId;
    const { current: chapterCurrent, total: chapterTotal, isFullWork } =
      parseChapterOrdinal(document, window.location.href);

    // Every handler reply from background now includes the record's current
    // state (Phase 7d). Push it through to the Save button so the label stays
    // truthful when an auto-promotion happens mid-read.
    function applyReply(reply) {
      if (reply && typeof reply === "object" && "state" in reply) {
        setSaveButtonState(reply.state);
      }
    }

    // Send the initial visit — background creates/updates the history record
    // before any tick or scroll arrives for this ficId.
    browser.runtime.sendMessage({
      type: "HISTORY_VISIT",
      ficId,
      title: fic.title,
      author: fic.author,
      chapters: fic.chapters || null,
      chapterCurrent,
      chapterTotal,
      isFullWork,
      timestamp: new Date().toISOString()
    }).then(applyReply, () => {});

    // ---- Scroll tracking (percent through the chapter's content area) ----
    let lastSentPct = -1;
    let scrollTimer = null;

    function computeScrollPercent() {
      // #workskin wraps the posted chapter text; fall back to document if AO3
      // ever renames the skin container.
      const content = document.querySelector("#workskin") || document.documentElement;
      const rect = content.getBoundingClientRect();
      const contentTop = rect.top + window.scrollY;
      const contentHeight = content.scrollHeight || rect.height || 1;
      const distance = Math.max(0, window.scrollY + window.innerHeight - contentTop);
      const pct = Math.round((distance / contentHeight) * 100);
      return Math.max(0, Math.min(100, pct));
    }

    function sendScroll() {
      const pct = computeScrollPercent();
      if (Math.abs(pct - lastSentPct) < 5) return;
      lastSentPct = pct;
      browser.runtime.sendMessage({
        type: "HISTORY_SCROLL",
        ficId,
        chapterCurrent,
        scrollPercent: pct,
        timestamp: new Date().toISOString()
      }).then(applyReply, () => {});
    }

    function onScroll() {
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        sendScroll();
      }, 500);
    }
    window.addEventListener("scroll", onScroll, { passive: true });

    // ---- Reading-time state machine ----
    const TICK_MS = 60_000;
    const IDLE_MS = 2 * 60_000;

    let readingSince = null;   // Date.now() when we started reading, null if not
    let accruedMs = 0;         // reading ms not yet flushed to background
    let idleTimer = null;
    let tickTimer = null;
    let isIdle = false;

    function isReading() {
      return document.visibilityState === "visible" && document.hasFocus() && !isIdle;
    }

    function startReading() {
      if (readingSince != null) return;
      readingSince = Date.now();
      if (!tickTimer) {
        tickTimer = setInterval(flushAccrued, TICK_MS);
      }
    }

    function stopReading() {
      if (readingSince != null) {
        accruedMs += Date.now() - readingSince;
        readingSince = null;
      }
      if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
      flushAccrued(true);
    }

    function flushAccrued(onStop = false) {
      // Move any in-progress run into accrued so we don't lose it on a partial flush.
      if (readingSince != null) {
        accruedMs += Date.now() - readingSince;
        readingSince = Date.now();
      }
      // Require at least 5 seconds before we bother sending — filters out
      // accidental flushes from flicker focus events.
      if (accruedMs < 5_000) {
        if (onStop) accruedMs = 0;
        return;
      }
      const minutes = accruedMs / 60_000;
      accruedMs = 0;
      browser.runtime.sendMessage({
        type: "HISTORY_TIME_TICK",
        ficId,
        minutes,
        timestamp: new Date().toISOString()
      }).then(applyReply, () => {});
    }

    function updateReadingState() {
      if (isReading()) {
        startReading();
      } else {
        stopReading();
      }
    }

    // ---- Idle detection ----
    function resetIdle() {
      if (isIdle) {
        isIdle = false;
        updateReadingState();
      }
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        isIdle = true;
        updateReadingState();
      }, IDLE_MS);
    }

    // Activity events that "count as awake" — the five signals AO3 readers
    // actually produce: moving the mouse, typing, scrolling, touching the
    // screen on mobile, or using a scroll wheel without moving the mouse.
    const activityEvents = ["mousemove", "keydown", "scroll", "touchstart", "wheel"];
    for (const evt of activityEvents) {
      window.addEventListener(evt, resetIdle, { passive: true });
    }

    // ---- Visibility / focus wiring ----
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        stopReading();
      } else {
        resetIdle();
        updateReadingState();
      }
    });
    window.addEventListener("focus", () => {
      resetIdle();
      updateReadingState();
    });
    window.addEventListener("blur", () => {
      stopReading();
    });
    window.addEventListener("beforeunload", () => {
      stopReading();
    });

    // Kick things off if the page is already visible + focused at load time.
    resetIdle();
    updateReadingState();

    // ---- Full-work view: chapter advancement + opportunistic chapter ID caching ----
    //
    // On the full-work view (?view_full_work=true), the URL doesn't pin a single
    // chapter — the page contains every chapter as <div id="chapter-N"> sections.
    // The plain VISIT and SCROLL flow can't update maxChapterRead in that case.
    //
    // Detection combines multiple signals because parseChapterOrdinal's
    // isFullWork relies on AO3 keeping the chapter dropdown visible on this view
    // (which it may or may not, depending on AO3 layout updates):
    //   - URL contains view_full_work=true
    //   - parseChapterOrdinal returned isFullWork
    //   - ≥2 <div id="chapter-N"> sections exist on the page (only possible in
    //     multi-chapter full-work view; normal chapter pages render one chapter)
    // Any one is enough to switch on the full-work tracker.
    //
    // Two things happen here:
    //   1) Extract every chapter's AO3 id from the per-chapter heading link and
    //      send it to background to populate ficCache.chapterIds. After that
    //      lands, the next "Continue reading" uses a direct /chapters/<id> URL
    //      and the user leaves full-work view permanently for this fic.
    //   2) IntersectionObserver watches each chapter section. When a section's
    //      heading is in the top 30% of the viewport, treat that chapter as
    //      the current one. Fire HISTORY_VISIT with the new chapterCurrent so
    //      the existing handler bumps maxChapterRead monotonically.
    const fullWorkSections = Array.from(document.querySelectorAll('div[id^="chapter-"]'));
    const isFullWorkUrl = /[?&]view_full_work=true\b/.test(window.location.href);
    const isFullWorkPage = isFullWork || isFullWorkUrl || fullWorkSections.length >= 2;

    if (isFullWorkPage) {
      // Cache chapter IDs once, up front. The parser reads per-chapter heading
      // links — which exist on the full-work view but not in the URL.
      try {
        const chapterIds = parseFullWorkChapterIds(document);
        if (chapterIds && chapterIds.length > 0) {
          browser.runtime.sendMessage({
            type: "CACHE_CHAPTER_IDS",
            ficId,
            chapterIds,
            timestamp: new Date().toISOString()
          }).then(
            (reply) => LOG(`full-work chapterIds cached: ${chapterIds.length} (${reply?.unchanged ? "no-op" : "saved"})`),
            () => {}
          );
        }
      } catch (e) {
        ERR("parseFullWorkChapterIds failed:", e);
      }

      // Chapter advancement via IntersectionObserver. Reuses the section list
      // already gathered for the detection check above.
      const sections = fullWorkSections;
      if (sections.length > 0) {
        const ordinalFor = (el) => {
          const m = (el.id || "").match(/^chapter-(\d+)$/);
          return m ? parseInt(m[1], 10) : null;
        };
        // Track which chapter sections are currently in the "reading zone"
        // (the top 30% of the viewport). The active chapter is the highest
        // ordinal among them — when the user scrolls down into chapter N+1,
        // both N and N+1 may briefly intersect; we want N+1.
        const intersecting = new Set();
        let lastReportedChapter = null;

        const reportChapter = (ord) => {
          if (ord == null || ord === lastReportedChapter) return;
          lastReportedChapter = ord;
          // Re-emit HISTORY_VISIT with the resolved chapterCurrent. The handler
          // is idempotent for a known fic and will advance maxChapterRead
          // monotonically. firstOpened is preserved by the visit handler's
          // _baseHistoryRecord merge, so this doesn't reset the record.
          browser.runtime.sendMessage({
            type: "HISTORY_VISIT",
            ficId,
            title: fic.title,
            author: fic.author,
            chapters: fic.chapters || null,
            chapterCurrent: ord,
            chapterTotal: chapterTotal,
            isFullWork: true,
            timestamp: new Date().toISOString()
          }).then(applyReply, () => {});
        };

        const onIntersect = (entries) => {
          for (const entry of entries) {
            const ord = ordinalFor(entry.target);
            if (ord == null) continue;
            if (entry.isIntersecting) {
              intersecting.add(ord);
            } else {
              intersecting.delete(ord);
            }
          }
          if (intersecting.size === 0) return;
          // Highest currently-visible chapter wins. Back-scrolling will set
          // lastChapterRead lower, but maxChapterRead stays monotonic.
          let max = -1;
          for (const ord of intersecting) if (ord > max) max = ord;
          reportChapter(max);
        };

        // rootMargin shrinks the bottom edge of the observation root so only
        // the top 30% of the viewport counts as "in the reading zone." A
        // chapter heading entering that zone means the user has scrolled to
        // (or near) the start of that chapter.
        const observer = new IntersectionObserver(onIntersect, {
          rootMargin: "0px 0px -70% 0px",
          threshold: 0
        });
        for (const section of sections) observer.observe(section);

        LOG(`full-work chapter tracker armed for ${ficId} (${sections.length} chapters)`);
      }
    }

    LOG(`reading tracker armed for ${ficId}` +
        (chapterCurrent != null ? ` (ch ${chapterCurrent}/${chapterTotal ?? "?"})` : ` (full-work view)`));
  }

  // ---- Phase 7d: in-page Save button ----
  //
  // Injects a small extension-branded bar right after AO3's h3.byline, above
  // the summary. One button on the right; its label reflects the current
  // history state:
  //   state = null             → "Save for later"   (create save_for_later)
  //   state = "save_for_later" → "Saved — unsave"   (delete the history record)
  //   state = "reading"        → "Set aside"        (back to save_for_later,
  //                                                 armed with autoPromoteBlocked)
  //
  // The branding label on the left ("My AO3 Algorithm") makes it unambiguous
  // that this is an extension UI, not something AO3 added. Styles are scoped
  // to `.maa-*` and injected inline so the bar coexists with whatever skin
  // or user styles the reader has configured.
  //
  // Returns a setState(state) function the reading tracker calls whenever the
  // background reports a state change (e.g. auto-promotion on scroll).
  function injectSaveButton(fic) {
    if (!fic || !fic.ficId) return () => {};

    const byline = document.querySelector("#workskin h3.byline, h3.byline");
    if (!byline) {
      WARN("save button: no h3.byline found, skipping injection");
      return () => {};
    }
    // Guard against double-injection if content.js somehow runs twice.
    if (byline.parentNode.querySelector(".maa-save-bar")) {
      return () => {};
    }

    // Scoped styles — inject once per page.
    if (!document.getElementById("maa-save-styles")) {
      const style = document.createElement("style");
      style.id = "maa-save-styles";
      style.textContent = `
        .maa-save-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin: 0.8em 0 1em 0;
          padding: 8px 12px;
          border: 1px solid #3a7bd5;
          border-left: 4px solid #3a7bd5;
          border-radius: 4px;
          background: rgba(58, 123, 213, 0.06);
          font-size: 0.9em;
          line-height: 1.2;
        }
        .maa-save-bar .maa-brand {
          color: #3a7bd5;
          font-weight: 600;
          letter-spacing: 0.02em;
          white-space: nowrap;
        }
        .maa-save-bar .maa-brand::before {
          content: "★ ";
        }
        .maa-save-bar .maa-save-btn {
          appearance: none;
          border: 1px solid #3a7bd5;
          background: #fff;
          color: #3a7bd5;
          padding: 6px 14px;
          border-radius: 3px;
          cursor: pointer;
          font: inherit;
          font-weight: 500;
          min-width: 140px;
          text-align: center;
          transition: background 0.25s ease, color 0.25s ease,
                      border-color 0.25s ease, opacity 0.3s ease;
        }
        .maa-save-bar .maa-save-btn:hover {
          background: #3a7bd5;
          color: #fff;
        }
        .maa-save-bar .maa-save-btn[disabled] {
          opacity: 0.6;
          cursor: wait;
        }
        .maa-save-bar .maa-save-btn[data-state="reading"] {
          border-color: #6b6b6b;
          color: #4a4a4a;
        }
        .maa-save-bar .maa-save-btn[data-state="reading"]:hover {
          background: #6b6b6b;
          color: #fff;
        }
        .maa-save-bar .maa-save-btn[data-state="save_for_later"] {
          background: #3a7bd5;
          color: #fff;
        }
        .maa-save-bar .maa-save-btn[data-state="save_for_later"]:hover {
          background: #fff;
          color: #3a7bd5;
        }
        .maa-save-bar .maa-save-btn.maa-flash,
        .maa-save-bar .maa-save-btn.maa-flash:hover {
          background: #2e8f4e;
          border-color: #2e8f4e;
          color: #fff;
        }
        .maa-save-bar .maa-read-btn[data-read="true"] {
          background: #2e8f4e;
          border-color: #2e8f4e;
          color: #fff;
          min-width: 150px;
        }
        .maa-save-bar .maa-read-btn[data-read="true"]:hover {
          background: #fff;
          color: #2e8f4e;
        }
        .maa-save-bar .maa-read-btn[disabled] {
          opacity: 0.6;
          cursor: wait;
        }
        .maa-toast {
          position: fixed;
          bottom: 24px;
          left: 50%;
          transform: translateX(-50%);
          background: rgba(35, 35, 38, 0.94);
          color: #fff;
          padding: 10px 18px;
          border-radius: 4px;
          font-size: 0.9em;
          line-height: 1.3;
          z-index: 2147483647;
          opacity: 0;
          transition: opacity 0.4s ease;
          max-width: 90vw;
          text-align: center;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
          pointer-events: none;
        }
        .maa-toast.maa-toast-visible {
          opacity: 1;
        }
      `;
      document.head.appendChild(style);
    }

    const bar = document.createElement("div");
    bar.className = "maa-save-bar";

    const brand = document.createElement("span");
    brand.className = "maa-brand";
    brand.textContent = "My AO3 Algorithm";
    bar.appendChild(brand);

    // Two buttons: "I've read this" (issue #1) and the save toggle. The read
    // button goes first because on a finished fic it is the one the reader
    // actually wants, and the save button on a completed work is a no-op.
    //
    // Marking read from the page matters as much as from the feed: it is the
    // moment the reader knows, and asking them to remember to click a card in
    // the feed later is how a "mark as read" feature goes unused.
    const readBtn = document.createElement("button");
    readBtn.className = "maa-save-btn maa-read-btn";
    readBtn.type = "button";
    readBtn.textContent = "I've read this";
    readBtn.setAttribute("data-read", "false");
    bar.appendChild(readBtn);

    const btn = document.createElement("button");
    btn.className = "maa-save-btn";
    btn.type = "button";
    btn.textContent = "Save for later";
    btn.setAttribute("data-state", "none");
    bar.appendChild(btn);

    byline.parentNode.insertBefore(bar, byline.nextSibling);

    // Read-button state. null = unknown, true/false = marked or not.
    let currentRead = null;

    function renderRead(read) {
      currentRead = read;
      const on = read === true;
      readBtn.textContent = on ? "Read ✓ — undo" : "I've read this";
      readBtn.setAttribute("data-read", on ? "true" : "false");
    }

    readBtn.addEventListener("click", async () => {
      if (readBtn.disabled) return;
      readBtn.disabled = true;
      const { total: chTotal } = parseChapterOrdinal(document, window.location.href);
      try {
        const reply = await browser.runtime.sendMessage({
          type: "MARK_READ",
          ficId: fic.ficId,
          title: fic.title,
          author: fic.author,
          chapterTotal: chTotal != null ? chTotal : null,
          // Toggle: clicking a marked-read button means "undo".
          read: currentRead !== true,
          timestamp: new Date().toISOString()
        });
        if (reply && reply.ok) {
          renderRead(reply.read);
          LOG(`mark read: ${reply.read ? "read" : "unread"} (${fic.ficId})`);
        } else {
          WARN("mark read failed:", reply);
        }
      } catch (e) {
        ERR("mark read sendMessage failed:", e);
      } finally {
        readBtn.disabled = false;
      }
    });

    // Ask the background whether this fic is already marked read, so the
    // button does not claim "I've read this" for a fic the reader finished
    // long ago. Silently wrong initial state is worse than no state.
    browser.runtime.sendMessage({ type: "GET_HISTORY_STATE", ficId: fic.ficId })
      .then(reply => { if (reply && reply.ok) renderRead(!!reply.markedReadAt); })
      .catch(() => { /* leave the default; the toggle still works */ });

    // Track the last state the background told us about. null = no history
    // record exists yet (so clicking saves).
    let currentState = null;

    function labelFor(state) {
      if (state === "save_for_later") return "Saved — unsave";
      if (state === "reading") return "Set aside";
      return "Save for later";
    }

    function render(state) {
      currentState = state || null;
      btn.textContent = labelFor(currentState);
      btn.setAttribute("data-state", currentState || "none");
    }

    // Set aside flash: the resting state after Set aside is "Saved — unsave"
    // (since the fic is now in save_for_later), but landing there silently
    // makes "Set aside" feel like it didn't register. So show "Set aside ✓"
    // for ~1.2s, then fade into the resting label.
    let flashTimers = [];
    function clearFlashTimers() {
      flashTimers.forEach(clearTimeout);
      flashTimers = [];
    }
    function flashSetAside(restingState) {
      clearFlashTimers();
      currentState = restingState || null;
      btn.setAttribute("data-state", currentState || "none");
      btn.classList.add("maa-flash");
      btn.textContent = "Set aside \u2713";
      flashTimers.push(setTimeout(() => {
        btn.style.opacity = "0";
        flashTimers.push(setTimeout(() => {
          btn.classList.remove("maa-flash");
          btn.textContent = labelFor(currentState);
          btn.style.opacity = "";
        }, 250));
      }, 1200));
    }

    function showSetAsideToast() {
      document.querySelectorAll(".maa-toast").forEach(t => t.remove());
      const toast = document.createElement("div");
      toast.className = "maa-toast";
      toast.textContent = "Set aside \u2014 won't auto-resume until you reopen this fic.";
      document.body.appendChild(toast);
      requestAnimationFrame(() => toast.classList.add("maa-toast-visible"));
      setTimeout(() => {
        toast.classList.remove("maa-toast-visible");
        setTimeout(() => toast.remove(), 500);
      }, 4500);
    }

    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const { current: ch, total: chTotal } = parseChapterOrdinal(document, window.location.href);
      try {
        const reply = await browser.runtime.sendMessage({
          type: "SAVE_TOGGLE",
          ficId: fic.ficId,
          title: fic.title,
          author: fic.author,
          chapters: fic.chapters || null,
          chapterCurrent: ch,
          chapterTotal: chTotal,
          timestamp: new Date().toISOString()
        });
        if (reply && reply.ok) {
          if (reply.action === "setAside") {
            flashSetAside(reply.state);
            if (reply.firstSetAside) showSetAsideToast();
          } else {
            clearFlashTimers();
            btn.classList.remove("maa-flash");
            btn.style.opacity = "";
            render(reply.state);
          }
          LOG(`save toggle: ${reply.action} (${fic.ficId})`);
        } else {
          WARN("save toggle failed:", reply);
        }
      } catch (e) {
        ERR("save toggle sendMessage failed:", e);
      } finally {
        btn.disabled = false;
      }
    });

    return (state) => {
      // Only update when it actually changes — avoids flicker from every tick.
      if (state === currentState) return;
      // If a flash is mid-flight, let it finish; the background-driven update
      // here is for auto-promotion ticks, not the just-clicked action.
      if (btn.classList.contains("maa-flash")) {
        currentState = state || null;
        btn.setAttribute("data-state", currentState || "none");
        return;
      }
      render(state);
    };
  }
})();
