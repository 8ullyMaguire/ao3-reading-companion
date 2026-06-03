// parsers.js — AO3 HTML parsers.
//
// Exports (via shared content-script scope):
//   parseBlurb(liElement)      — one <li class="work blurb"> on a listing page
//   parseFicPage(doc, path)    — the detailed meta on a single /works/NUMBER page
//   detectPageType(url)        — URL-pattern dispatch
//   isLoggedOut()              — quick logged-out check
//
// Every parse function returns an object matching ficCache (plus a few extra
// optional fields: authorPseud, coauthors, source). Throws on fatally malformed
// input; content.js catches per-item so one bad blurb doesn't kill the page.

"use strict";

// ---------- Small helpers ----------

function _text(el) {
  return el ? el.textContent.trim() : null;
}

function _parseIntLoose(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/[^\d]/g, "");
  return cleaned ? parseInt(cleaned, 10) : null;
}

function _tagList(container, selector) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(selector))
    .map(a => _text(a))
    .filter(Boolean);
}

function _usernameFromPseudHref(href) {
  // /users/janedoe/pseuds/writer_alias  ->  janedoe
  // /users/janedoe                       ->  janedoe
  if (!href) return null;
  const m = href.match(/^\/users\/([^\/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function _ratingCodeFromClasslist(classList) {
  for (const c of classList) {
    if (c.startsWith("rating-")) {
      switch (c.slice("rating-".length)) {
        case "general-audience":
        case "general-audiences":
        case "general":
          return "G";
        case "teen":
          return "T";
        case "mature":
          return "M";
        case "explicit":
          return "E";
        case "notrated":
        case "not-rated":
          return "Not Rated";
      }
    }
  }
  return null;
}

function _ratingFromText(t) {
  if (!t) return null;
  const low = t.toLowerCase();
  if (low.includes("general")) return "G";
  if (low.includes("teen")) return "T";
  if (low.includes("mature")) return "M";
  if (low.includes("explicit")) return "E";
  if (low.includes("not rated")) return "Not Rated";
  return t;
}

function _parseChapters(s) {
  // "5/?" -> { current:5, total:null, isComplete:false }
  // "5/5" -> complete
  if (!s) return { current: null, total: null, isComplete: null };
  const parts = s.split("/").map(x => x.trim());
  const current = _parseIntLoose(parts[0]);
  const total = parts[1] === "?" ? null : _parseIntLoose(parts[1]);
  const isComplete = total != null && current != null && current === total;
  return { current, total, isComplete };
}

function _isoFromDateText(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}

// ---------- Public: page detection ----------

function detectPageType(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "other";
  }
  const path = parsed.pathname;
  if (/^\/works\/\d+(\/|$)/.test(path)) return "fic";
  if (/^\/works\/search/.test(path)) return "search";
  if (/^\/works(\/?|\?|$)/.test(path)) return "works-listing";
  if (/^\/tags\/[^/]+\/works\/?$/.test(path)) return "tag-listing";
  if (/^\/bookmarks\/?$/.test(path)) return "bookmarks";
  if (/^\/users\/[^/]+\/bookmarks\/?$/.test(path)) return "user-bookmarks";
  if (/^\/users\/[^/]+\/works\/?$/.test(path)) return "user-works";
  if (/^\/users\/[^/]+\/pseuds\/[^/]+\/works\/?$/.test(path)) return "pseud-works";
  if (/^\/users\/[^/]+\/subscriptions\/?$/.test(path)) {
    // AO3 default tab is Works. The Users tab surfaces whom you subscribe to;
    // the Works tab is a feed of their recent output. We parse them differently.
    const type = (parsed.searchParams.get("type") || "works").toLowerCase();
    if (type === "users") return "subscriptions-users";
    if (type === "series") return "subscriptions-series";
    return "subscriptions-works";
  }
  if (/^\/collections\/[^/]+\/works\/?$/.test(path)) return "collection-works";
  return "other";
}

function isLoggedOut(doc) {
  const d = doc || document;
  // Logged-in users have a logout link in the greeting menu.
  return !d.querySelector('a[href^="/users/logout"]');
}

// ---------- Public: user + subscriptions parsers ----------

function parseLoggedInUsername(doc) {
  // AO3 renders a greeting nav with an anchor to /users/<username> when logged
  // in: <nav id="greeting"><a href="/users/USERNAME">Hi, USERNAME!</a>...</nav>
  // Extract the username from the first such anchor.
  const d = doc || document;
  const a = d.querySelector('nav#greeting a[href^="/users/"]');
  if (!a) return null;
  return _usernameFromPseudHref(a.getAttribute("href"));
}

// Extract chapter IDs from the chapter selector dropdown. Multi-chapter
// works render
//   <select id="selected_id"><option value="[chapterId]">N. Title</option>…</select>
// where option order matches chapter ordinal (1-indexed). Single-chapter
// works don't have this dropdown — returns null in that case.
//
// Used both by parseFicPage when scraping a normal fic page AND by the
// on-demand FETCH_CHAPTER_IDS path that runs when the My Reading dashboard
// needs IDs it doesn't yet have cached.
function parseChapterIdsFromDropdown(doc) {
  const d = doc || document;
  const chapterSelect = d.querySelector("select#selected_id");
  if (!chapterSelect) return null;
  const ids = Array.from(chapterSelect.querySelectorAll("option"))
    .map(opt => opt.getAttribute("value"))
    .filter(v => v && /^\d+$/.test(v));
  return ids.length > 0 ? ids : null;
}

// Extract chapter IDs from a full-work view (?view_full_work=true). On that
// view there's no <select id="selected_id"> dropdown, but each chapter's
// preface heading links to that chapter's individual URL — pull the IDs out
// of those hrefs. Returns an array of stringified chapter IDs in chapter
// order, or null if the page doesn't look like a multi-chapter full-work
// view. Used by content.js to opportunistically cache chapterIds when the
// user reads a fic via full-work view, so the next "Continue reading" can
// use the direct chapter URL.
function parseFullWorkChapterIds(doc) {
  const d = doc || document;
  // Each chapter section is a div with id="chapter-N" containing a preface
  // heading whose anchor points at /works/[ficId]/chapters/[chapterId].
  const chapterSections = Array.from(d.querySelectorAll('div[id^="chapter-"]'));
  if (chapterSections.length === 0) return null;

  const ids = [];
  for (const section of chapterSections) {
    const link = section.querySelector('.preface h3.title a[href*="/chapters/"]')
              || section.querySelector('h3.title a[href*="/chapters/"]')
              || section.querySelector('a[href*="/chapters/"]');
    if (!link) return null;  // unexpected layout — bail rather than save partial data
    const m = (link.getAttribute("href") || "").match(/\/chapters\/(\d+)/);
    if (!m) return null;
    ids.push(m[1]);
  }
  return ids.length > 0 ? ids : null;
}

function parseChapterOrdinal(doc, url) {
  // Resolve which chapter the user is viewing on a /works/ID or /works/ID/chapters/ID page.
  // Returns { current, total, isFullWork }:
  //   - Full-work view (URL lacks /chapters/, multi-chapter work): current=null, total known.
  //     We deliberately don't claim "current = total" here — user may have opened the
  //     full-work view and bounced before actually reading. The scroll signal catches
  //     completion without forcing a monotonic bump we can't walk back.
  //   - Single-chapter view: current = 1-based index of the <option selected> in
  //     #selected_id; total from the stats row.
  //   - One-chapter work: current=1, total=1 regardless of URL shape.
  const d = doc || document;
  const u = url || (d.defaultView && d.defaultView.location.href) || "";
  const stats = d.querySelector("dl.stats") ||
                (d.querySelector("dd.stats") && d.querySelector("dd.stats").querySelector("dl.stats"));
  const chaptersText = _text(stats && stats.querySelector("dd.chapters"));
  const parsed = _parseChapters(chaptersText);
  const total = parsed.total != null ? parsed.total : parsed.current;

  const hasChaptersPath = /\/chapters\/\d+/.test(u);
  const select = d.querySelector("#selected_id");

  if (!select) {
    // No chapter selector — either a one-chapter work or a full-work view on a
    // single-chapter fic. Treat as chapter 1.
    return { current: 1, total: total || 1, isFullWork: false };
  }

  if (!hasChaptersPath) {
    // Full-work view on a multi-chapter fic. We can't pin a single chapter.
    return { current: null, total, isFullWork: true };
  }

  const options = Array.from(select.querySelectorAll("option"));
  const selectedIdx = options.findIndex(o => o.hasAttribute("selected"));
  if (selectedIdx < 0) {
    return { current: null, total, isFullWork: false };
  }
  return { current: selectedIdx + 1, total: total || options.length, isFullWork: false };
}

function parseSubscriptionsUsers(doc) {
  // Page structure:
  //   <dl class="subscription index group">
  //     <dt><a href="/users/USERNAME">DISPLAY_PSEUD</a></dt>
  //     <dd>...unsubscribe form...</dd>
  //     ...
  //   </dl>
  // Each <dt> anchor gives us the username (from href) and the displayed
  // pseud (from text). For default pseuds these match; for custom pseuds the
  // link text may differ, so we keep both.
  const d = doc || document;
  const anchors = d.querySelectorAll("dl.subscription dt a[href^='/users/']");
  const out = [];
  const seen = new Set();
  for (const a of anchors) {
    const username = _usernameFromPseudHref(a.getAttribute("href"));
    if (!username) continue;
    if (seen.has(username.toLowerCase())) continue;
    seen.add(username.toLowerCase());
    const pseud = _text(a) || username;
    out.push({ username, pseud });
  }
  return out;
}

// ---------- parseBlurb — for .work.blurb / .bookmark.blurb ----------

function parseBlurb(li) {
  // Title + ficId: first non-author link in h4.heading
  const headingLink = li.querySelector("h4.heading a:not([rel='author'])");
  if (!headingLink) throw new Error("no heading link");
  const hrefMatch = (headingLink.getAttribute("href") || "").match(/\/works\/(\d+)/);
  if (!hrefMatch) throw new Error("heading link is not /works/ID");
  const ficId = hrefMatch[1];
  const title = _text(headingLink);

  // Authors
  const authorLinks = Array.from(li.querySelectorAll("h4.heading a[rel='author']"));
  let author = "Anonymous";
  let authorPseud = null;
  const coauthors = [];
  if (authorLinks.length > 0) {
    const primary = authorLinks[0];
    authorPseud = _text(primary);
    author = _usernameFromPseudHref(primary.getAttribute("href")) || authorPseud || "Anonymous";
    for (let i = 1; i < authorLinks.length; i++) {
      const u = _usernameFromPseudHref(authorLinks[i].getAttribute("href"));
      coauthors.push(u || _text(authorLinks[i]));
    }
  } else {
    const heading = li.querySelector("h4.heading");
    if (heading && /anonymous/i.test(heading.textContent)) author = "Anonymous";
  }

  // Fandoms
  const fandoms = _tagList(li.querySelector("h5.fandoms"), "a.tag");

  // Required-tags row: rating + completion marker
  const required = li.querySelector("ul.required-tags");
  let rating = null;
  if (required) {
    const ratingSpan = required.querySelector("span[class*='rating-']");
    if (ratingSpan) {
      rating = _ratingCodeFromClasslist(ratingSpan.classList) || _ratingFromText(_text(ratingSpan));
    }
  }

  // Full tag lists
  const tagsRoot = li.querySelector("ul.tags.commas") || li.querySelector("ul.tags");
  const warnings = _tagList(tagsRoot, "li.warnings a.tag");
  const relationships = _tagList(tagsRoot, "li.relationships a.tag");
  const characters = _tagList(tagsRoot, "li.characters a.tag");
  const freeformTags = _tagList(tagsRoot, "li.freeforms a.tag");

  // Summary
  const summary = _text(li.querySelector("blockquote.userstuff.summary"))
               || _text(li.querySelector("blockquote.userstuff"));

  // Stats
  const stats = li.querySelector("dl.stats");
  const wordCount = _parseIntLoose(_text(stats && stats.querySelector("dd.words")));
  const chaptersRaw = _text(stats && stats.querySelector("dd.chapters"));
  const { isComplete: chapComplete } = _parseChapters(chaptersRaw);
  const kudos = _parseIntLoose(_text(stats && stats.querySelector("dd.kudos")));
  const hits = _parseIntLoose(_text(stats && stats.querySelector("dd.hits")));
  const comments = _parseIntLoose(_text(stats && stats.querySelector("dd.comments")));
  const bookmarks = _parseIntLoose(_text(stats && stats.querySelector("dd.bookmarks")));

  // isComplete: prefer the required-tags marker, fall back to chapters string
  let isComplete = null;
  if (required) {
    if (required.querySelector("span.complete-yes")) isComplete = true;
    else if (required.querySelector("span.complete-no, span.iswip")) isComplete = false;
  }
  if (isComplete === null) isComplete = chapComplete;

  const lastUpdated = _isoFromDateText(_text(li.querySelector("p.datetime")));

  return {
    ficId,
    title,
    author,
    authorPseud,
    coauthors,
    summary,
    fandoms,
    relationships,
    characters,
    freeformTags,
    warnings,
    rating,
    wordCount,
    chapters: chaptersRaw,
    kudos,
    hits,
    comments,
    bookmarks,
    isComplete,
    lastUpdated,
    scrapedAt: new Date().toISOString(),
    source: "blurb"
  };
}

// ---------- parseFicPage — for /works/NUMBER and /works/NUMBER/chapters/... ----------

function parseFicPage(doc, pathname) {
  const ficIdMatch = (pathname || "").match(/\/works\/(\d+)/);
  if (!ficIdMatch) throw new Error("no ficId in path");
  const ficId = ficIdMatch[1];

  // Meta block — presence of this block implies we can see the work
  const meta = doc.querySelector("dl.work.meta.group")
            || doc.querySelector("dl.meta.group.work")
            || doc.querySelector("dl.work.meta");
  if (!meta) throw new Error("no work meta block (restricted / deleted / login-required?)");

  // Work preface: title, author, summary
  const preface = doc.querySelector("#workskin .preface.group")
               || doc.querySelector(".preface.group");

  const title = _text(preface && preface.querySelector("h2.title.heading"));

  // Author(s)
  const bylineLinks = Array.from(
    (preface ? preface.querySelectorAll("h3.byline a[rel='author']") : [])
  );
  let author = "Anonymous";
  let authorPseud = null;
  const coauthors = [];
  if (bylineLinks.length > 0) {
    const primary = bylineLinks[0];
    authorPseud = _text(primary);
    author = _usernameFromPseudHref(primary.getAttribute("href")) || authorPseud || "Anonymous";
    for (let i = 1; i < bylineLinks.length; i++) {
      const u = _usernameFromPseudHref(bylineLinks[i].getAttribute("href"));
      coauthors.push(u || _text(bylineLinks[i]));
    }
  } else if (preface) {
    const byline = preface.querySelector("h3.byline");
    if (byline && /anonymous/i.test(byline.textContent)) author = "Anonymous";
  }

  // Summary
  const summary = _text(preface && preface.querySelector(".summary blockquote.userstuff"));

  // Tags from the meta block
  const fandoms = _tagList(meta.querySelector("dd.fandom.tags"), "a.tag");
  const warnings = _tagList(meta.querySelector("dd.warning.tags"), "a.tag");
  const relationships = _tagList(meta.querySelector("dd.relationship.tags"), "a.tag");
  const characters = _tagList(meta.querySelector("dd.character.tags"), "a.tag");
  const freeformTags = _tagList(meta.querySelector("dd.freeform.tags"), "a.tag");

  // Rating
  const ratingText = _text(meta.querySelector("dd.rating.tags a.tag"));
  const rating = _ratingFromText(ratingText);

  // Stats (inner dl)
  const stats = meta.querySelector("dd.stats dl.stats") || meta.querySelector("dl.stats");
  const wordCount = _parseIntLoose(_text(stats && stats.querySelector("dd.words")));
  const chaptersRaw = _text(stats && stats.querySelector("dd.chapters"));
  const { isComplete: chapComplete } = _parseChapters(chaptersRaw);
  const kudos = _parseIntLoose(_text(stats && stats.querySelector("dd.kudos")));
  const hits = _parseIntLoose(_text(stats && stats.querySelector("dd.hits")));
  const comments = _parseIntLoose(_text(stats && stats.querySelector("dd.comments")));
  const bookmarks = _parseIntLoose(_text(stats && stats.querySelector("dd.bookmarks")));

  const updatedText = _text(stats && stats.querySelector("dd.status"));
  const publishedText = _text(stats && stats.querySelector("dd.published"));
  const lastUpdated = _isoFromDateText(updatedText || publishedText);

  const chapterIds = parseChapterIdsFromDropdown(doc);

  return {
    ficId,
    title,
    author,
    authorPseud,
    coauthors,
    summary,
    fandoms,
    relationships,
    characters,
    freeformTags,
    warnings,
    rating,
    wordCount,
    chapters: chaptersRaw,
    chapterIds,
    kudos,
    hits,
    comments,
    bookmarks,
    isComplete: chapComplete,
    lastUpdated,
    scrapedAt: new Date().toISOString(),
    source: "fic-page"
  };
}
