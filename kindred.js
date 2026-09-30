// kindred.js — the recommendation source, and the taste queue back to it.
//
// No DOM, no IndexedDB, no chrome.*: every function here is testable in plain
// node, which is the only reason the fallback table below can be pinned by
// tests at all. The feed wires this in; it does not own any of it.
//
// WIRE PROTOCOL, not a shared module, and the licence is why.
//
//   ao3-reading-companion  MIT   (Copyright (c) 2026 DisastrousClass)
//   kindred                AGPL-3.0
//
// MIT code calling an AGPL service over HTTP is fine — separate works, no code
// copied. The reverse is not: a kindred symbol pasted into this extension would
// infect an MIT work that is a public clone. So the boundary is enforced by
// tools/check-license-asymmetry.mjs, which fails on any kindred symbol
// appearing in this file. That check is the licence constraint; this comment
// is only the explanation of it.

// How long to wait before giving up on a kindred that is not answering.
//
// 30s is long enough for a cold instance on a slow disk and short enough that
// the feed does not feel hung. Above ~45s a user has already clicked away, and
// the local path — which is instant — is the better experience than a spinner.
const TIMEOUT_MS = 30_000;

// How many items to ask for. The feed shows TOP_N rows of this width, so
// asking for exactly TOP_N leaves no room for the read-history filter that runs
// afterwards. Ask for more and let the filter take its cut.
const DEFAULT_N = 40;

// The default base URL.
//
// Local first, and that is a considered default rather than a cautious one: a
// recommender that can see a full reading history is exactly the thing you do
// not point at a host you do not control. A public instance is opt-in, set in
// preferences, and the same posture as the opt-in permission in §4.5 of the
// spec.
const DEFAULT_BASE_URL = "http://127.0.0.1:8010";

// Every way a kindred call can fail, and what to call it.
//
// A reason is a stable string, not prose, because the feed turns it into a
// message and tests assert on it. The important split is `empty` vs
// `unreachable`: a reachable kindred with no matches is a cold instance that
// has not learned anything yet, which needs a different fix from a server that
// is not running, and a user who is told "unreachable" when the truth is
// "nothing to say yet" will go debug the wrong thing.
const REASONS = {
  TIMEOUT: "timeout",
  UNREACHABLE: "unreachable",
  NOT_SUPPORTED: "not-supported", // 404: an older self-hosted kindred
  MALFORMED: "malformed", // not JSON, or items is not an array
  EMPTY: "empty", // reachable, no error, nothing to say
  OK: null
};

// A one-line explanation per reason, for the feed header.
//
// Silent degradation is the failure this whole file is written against. A user
// whose feed quietly fell back to local ranking has no way to notice, and a
// flat feed looks like a broken recommender rather than an unreachable server.
// Every fallback path therefore carries a reason into the UI.
const SOURCE_NOTES = {
  [REASONS.UNREACHABLE]:
    "kindred is not answering — showing local ranking. Is it running?",
  [REASONS.NOT_SUPPORTED]:
    "this kindred does not have the recommendation API — showing local ranking.",
  [REASONS.MALFORMED]:
    "kindred sent something this extension cannot read — showing local ranking.",
  [REASONS.EMPTY]:
    "kindred has no recommendations for you yet — showing local ranking. " +
    "It needs a few comparisons before it can rank anything.",
  [REASONS.TIMEOUT]:
    "kindred took too long to answer — showing local ranking.",
  "http-error": "kindred returned an error — showing local ranking."
};

// Build the request URL. Exported so a test can assert the query shape without
// stubbing fetch at all.
function buildUrl(base, seeds, n) {
  const url = new URL("/api/v1/recommend", base);
  // A comma-separated list, which is what the endpoint takes. Seeds are
  // `kindred_seed:work:<id>`, opaque strings produced elsewhere — this function
  // does not parse them and must not, because a seed this extension cannot
  // interpret is still a valid seed to pass through.
  url.searchParams.set("seeds", seeds.join(","));
  url.searchParams.set("n", String(n || DEFAULT_N));
  return url.toString();
}

// Ask kindred for recommendations.
//
// RETURNS A VALUE, NEVER THROWS. Every failure is `{ok: false, reason}`, which
// is what makes "fallback must be total" implementable as one branch at the
// call site instead of a try/catch at every call site. Six ways this can fail
// and all six are enumerated in REASONS; a new one needs a new reason string
// and a test, and `Object.keys(REASONS)` is asserted complete by a test.
async function fetchRecommendations(base, seeds, n, opts) {
  const options = opts || {};
  const timeoutMs = options.timeoutMs || TIMEOUT_MS;
  const doFetch = options.fetch || globalThis.fetch;
  const baseUrl = base || DEFAULT_BASE_URL;

  if (!Array.isArray(seeds) || seeds.length === 0) {
    // Not a failure of kindred — a failure to ask. Distinct from `empty`:
    // this one is decided locally and does not deserve a "check your server"
    // message.
    return { ok: false, reason: "no-seeds", note: null, items: [], degraded: [] };
  }

  let url;
  try {
    url = buildUrl(baseUrl, seeds, n);
  } catch {
    // A malformed base URL. Worth its own reason: the user typed it, so the
    // note tells them where.
    return {
      ok: false,
      reason: "bad-url",
      note: `kindred's address is not a valid URL: ${baseUrl}`,
      items: [],
      degraded: []
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await doFetch(url, { signal: controller.signal });
  } catch (e) {
    // AbortError is our own timeout; everything else is the host failing.
    const reason =
      e && e.name === "AbortError" ? REASONS.TIMEOUT : REASONS.UNREACHABLE;
    return {
      ok: false,
      reason,
      note: SOURCE_NOTES[reason],
      items: [],
      degraded: []
    };
  } finally {
    // Always cleared, including on the abort path. A leaked 30s timer keeps
    // the extension's service worker alive and, in node, holds the test process
    // open — so there is a test that asserts the process exits.
    clearTimeout(timer);
  }

  if (!resp || typeof resp !== "object" || typeof resp.status !== "number") {
    // A fetch that resolved to something that is not a Response. A stub, a
    // polyfill, or a service-worker shim. Reading `.status` off it would throw
    // and that throw would escape the call site's single fallback branch, so
    // it is treated as the malformed body it effectively is.
    return {
      ok: false,
      reason: REASONS.MALFORMED,
      note: SOURCE_NOTES[REASONS.MALFORMED],
      items: [],
      degraded: []
    };
  }

  if (resp.status === 404) {
    return {
      ok: false,
      reason: REASONS.NOT_SUPPORTED,
      note: SOURCE_NOTES[REASONS.NOT_SUPPORTED],
      items: [],
      degraded: []
    };
  }
  if (!resp.ok) {
    const reason = "http-error";
    return {
      ok: false,
      reason: `${reason}:${resp.status}`,
      note: `${SOURCE_NOTES[reason]} (HTTP ${resp.status})`,
      items: [],
      degraded: []
    };
  }

  let body;
  try {
    body = await resp.json();
  } catch {
    return {
      ok: false,
      reason: REASONS.MALFORMED,
      note: SOURCE_NOTES[REASONS.MALFORMED],
      items: [],
      degraded: []
    };
  }

  if (!body || !Array.isArray(body.items)) {
    return {
      ok: false,
      reason: REASONS.MALFORMED,
      note: SOURCE_NOTES[REASONS.MALFORMED],
      items: [],
      degraded: []
    };
  }

  if (body.items.length === 0) {
    return {
      ok: false,
      reason: REASONS.EMPTY,
      note: SOURCE_NOTES[REASONS.EMPTY],
      items: [],
      degraded: []
    };
  }

  // meta.degraded is NOT a failure. It is kindred saying a signal could not
  // contribute — `recency` when its mirror is stale, say. Swallowing it would
  // hide the reason a feed looks flat when kindred is perfectly healthy, which
  // is the same class of silent wrong answer this file exists to avoid. So it
  // travels with the items and the header shows it.
  return {
    ok: true,
    reason: null,
    note: null,
    items: body.items,
    degraded: (body.meta && Array.isArray(body.meta.degraded) && body.meta.degraded) || []
  };
}

// Map a kindred item onto the shape the feed's row builders already expect.
//
// `evidence[]` maps onto the extension's `breakdown` almost field for field:
// kindred's `reason` is a sentence, and the feed's "why this?" UI already
// renders a sentence. That is the whole reason no new formatting code is needed
// in the UI layer.
function toFeedItem(item) {
  const evidence = Array.isArray(item.evidence) ? item.evidence : [];
  const breakdown = {
    matched: [],
    signals: evidence.map((e) => ({
      signal: e.signal,
      value: e.value,
      weight: e.weight,
      reason: e.reason
    }))
  };
  return {
    id: item.id,
    url: item.url || (item.id ? `https://archiveofourown.org/works/${item.id}` : null),
    title: item.title || "",
    author: item.author || "",
    score: typeof item.score === "number" ? item.score : 0,
    breakdown,
    fromKindred: true
  };
}

// ---------- The taste queue ----------
//
// Aggregate deltas only. This is the load-bearing privacy boundary of the whole
// integration and it is worth being blunt about what is NOT here:
//
//   never: fic URLs read, titles, author names of works being read, or
//          anything identifying the reader
//   always: tag and fandom WEIGHTS, and verdict deltas
//
// The extension holds the most sensitive data in the system — a full list of
// what someone reads — and the part useful to kindred is a small aggregate of
// what they liked. The server learns what the population likes, never who.
// tools/check-taste-queue-privacy.mjs enforces the field set mechanically,
// because a privacy boundary enforced by good intentions is not a boundary.

// The only fields a taste event may carry.
const TASTE_FIELDS = ["v", "kind", "tag", "delta"];

class TasteQueue {
  constructor(opts) {
    const options = opts || {};
    this.base = options.base || DEFAULT_BASE_URL;
    this.batchSize = options.batchSize || 25;
    this.post = options.post || null;
    this.pending = [];
    this.dropped = 0;
  }

  // Queue one taste delta. Ignores anything that is not a tag/fandom weight
  // change, by checking the field set rather than trusting the caller.
  push(event) {
    if (!event || typeof event !== "object") return false;
    if (event.kind !== "taste") return false;
    if (typeof event.tag !== "string" || !event.tag) return false;
    if (typeof event.delta !== "number" || !Number.isFinite(event.delta)) {
      return false;
    }
    for (const k of Object.keys(event)) {
      if (!TASTE_FIELDS.includes(k)) {
        // A field outside the allowed set is a privacy bug, not a validation
        // nit. Drop the whole event and count it so it is visible.
        this.dropped++;
        return false;
      }
    }
    this.pending.push({
      v: 1,
      kind: "taste",
      tag: event.tag,
      delta: event.delta
    });
    return true;
  }

  get size() {
    return this.pending.length;
  }

  // Flush a batch. Returns {sent, kept} — `kept` is the count still queued.
  //
  // On failure the batch is KEPT. Dropping it loses the user's stated
  // preferences permanently for a transient network error, and a taste weight
  // the reader set by hand is not something to lose because the server was down
  // for thirty seconds.
  async flush() {
    if (this.pending.length === 0) return { sent: 0, kept: 0 };
    const batch = this.pending.splice(0, this.batchSize);
    try {
      if (this.post) {
        await this.post(batch);
      } else {
        await globalThis.fetch(`${this.base}/api/v1/taste`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ events: batch })
        });
      }
      return { sent: batch.length, kept: this.pending.length };
    } catch {
      // Put them back at the front, so ordering survives a retry.
      this.pending = batch.concat(this.pending);
      return { sent: 0, kept: this.pending.length };
    }
  }
}

// The module surface, for the extension's `chrome`/content-script world. Kept
// explicit so a test can import this file with no globals present, and so it is
// obvious that nothing here touches the DOM.
const kindred = {
  TIMEOUT_MS,
  DEFAULT_N,
  DEFAULT_BASE_URL,
  REASONS,
  SOURCE_NOTES,
  TASTE_FIELDS,
  buildUrl,
  fetchRecommendations,
  toFeedItem,
  TasteQueue
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = kindred;
}
if (typeof globalThis !== "undefined") {
  globalThis.Kindred = kindred;
}
