# SPEC — ao3-reading-companion: fix the recommendations, then feed kindred

Status: **implemented 2026-09-30** (§1, §4). §3 not built — see §7.
Originally proposed 2026-09-29.
Repo: `~/code/python/ao3/ao3-reading-companion` (clone of `8ullyMaguire/ao3-reading-companion`)
Upstream: MV3 browser extension, plain unminified JS, no build step, no tests, no package.json

---

## 1. The bug is real, and here is exactly what it is

The report was "it recommends the exact same fics I've browsed". Confirmed, and
the cause is not a subtle ranking problem — it is that **six of the seven feed
rows never look at read history at all.**

`ctx.historyFicIds` — the set of every fic the user has ever opened — is already
computed once per feed build (`feed.js:930`) and passed into every row's
`buildResult`. The plumbing exists. Only two rows use it:

- `your_authors` filters it at `feed.js:82`
- custom rows filter it at `feed.js:414`, **and only if the row was built with
  `excludeRead: true`**

The five rows a user actually sees by default do not:

| row | line | filters read history? |
|---|---|---|
| `similar_to_tastes` (the main row) | `feed.js:53` | **no** |
| `popular` | `feed.js:181` | **no** |
| `hidden_gems` | `feed.js:207` | **no** |
| `discover_new` | `feed.js:234` | **no** |
| `completed_long_reads` | `feed.js:272` | **no** |
| `fresh_chapters` | `feed.js:118` | no — *correct*, see §1.2 |
| `your_authors` | `feed.js:82` | yes |

`similar_to_tastes` is the row whose subtitle is "Ranked by how well each fic
matches your taste profile" (`feed.js:51`). It is `scoredItems.slice(0, TOP_N)`
and nothing else. Every fic the user has read is scored, ranks highly — reading
a fic is the strongest possible signal that you like it — and is then shown
again. The scoring layer faithfully ranks read fics at the top; the feed then
displays them.

**This is a missing filter, not a bad model.** A scoring function that rates
read fics highly is *correct*: reading is the strongest positive signal there
is. The bug is that no layer between scoring and display removes them.

### 1.1 Why it is not a data problem

History is written correctly. A plain fic-page visit calls `handleHistoryVisit`
(`background.js:1132`), which creates a record via `_baseHistoryRecord` for a
fic with no prior history — no "loved" flag required (that flag only sets
`userVerdict`, `background.js:254`). So browsed fics *are* recorded. The
`historyFicIds` set at `feed.js:930` does contain them. They are simply not
filtered out of five of the seven rows.

### 1.2 The one row that must NOT filter, and why

`fresh_chapters` exists to show new chapters of fics already being read. A
filter there would break the row's entire purpose. Any global "exclude read"
switch must therefore be opt-out **per row**, not one global boolean — a single
flag would either break `fresh_chapters` or leave `similar_to_tastes` broken.

`your_authors` already has the right behaviour and is the model to follow.

### 1.3 A second, smaller problem: jitter is comparable to the signal

`ROW_TYPE_JITTER` (`scoring.js:19`) gives `discover_new` a range of **4**, while
a realistic tag-match total is a few points. Jitter is uniform in
`[-range, +range]`, so for that row it dominates the ordering — "discover new"
is close to a random shuffle with a filter on it. `completed_long_reads` at 2
and `similar_to_tastes` at 1.5 are mild; the 4 is not.

This is not the reported bug and is not fixed as part of it, but it will
dominate the *quality* of recommendations once §1 is fixed, and the user will
reasonably describe that as "still recommends the same fics" if the fix lands
without it. Flagged, scoped, not silently bundled.

---

## 2. Fix 1 — exclude read history from the rows that recommend (this task)

### Design

Filter once, centrally, in the place that already has the data.

The natural seam is between scoring and row building. `scoreAllWithData`
(`scoring.js:368`) produces `results` sorted desc, and every built-in row
consumes that same array. Rather than editing five `buildResult` bodies — five
places to forget, and a sixth row added later would ship broken — filter in
`buildFeedContext`/the row pipeline, with a per-row opt-out.

Proposed shape:

```js
// feed.js, near buildFeedContext
const READ_EXEMPT_ROW_TYPES = new Set(["fresh_chapters"]);

function excludeReadItems(scoredItems, ctx, rowType) {
  if (READ_EXEMPT_ROW_TYPES.has(rowType)) return scoredItems;
  if (!ctx.historyFicIds || ctx.historyFicIds.size === 0) return scoredItems;
  return scoredItems.filter(it => !ctx.historyFicIds.has(it.fic.ficId));
}
```

Applied to every row's items, `your_authors` excepted since it already filters.

### Why this shape

- One place. Adding a row later gets the behaviour by default, which is the
  only ordering that survives.
- The exemption is a named, documented exception (`fresh_chapters`), not an
  implicit side effect of that row's internals.
- The `size === 0` early return keeps a user with no history on exactly today's
  behaviour, so the change cannot make a cold-start feed worse.

### What must be true afterwards

1. No fic in `history` appears in `similar_to_tastes`, `popular`,
   `hidden_gems`, `discover_new`, or `completed_long_reads`.
2. `fresh_chapters` still shows read fics with new chapters.
3. A user with empty history sees an identical feed to today.
4. `your_authors` is unchanged.

### Tests

There is no test infrastructure in this repo at all. Adding a minimal one is
part of this task, not a follow-up: a fix for a ranking bug with no test is a
fix that can silently revert.

- `test/scoring.test.mjs` — node's built-in `node:test`, zero dependencies, run
  with `node --test`. The repo has no bundler, so the test must not introduce
  one.
- Extract nothing. `excludeReadItems` is called with plain objects; `ctx` is a
  plain object. Test it directly, with no IndexedDB, by injecting a literal
  `historyFicIds` Set and a literal `scoredItems` array.
- Four cases: read fic removed from a normal row; read fic kept in
  `fresh_chapters`; empty history changes nothing; `your_authors` behaviour
  unchanged.

### Verification

```
cd ~/code/python/ao3/ao3-reading-companion
node --test test/            # must pass
```

Manual, in the browser: browse ≥5 fics, open the feed, confirm none of those 5
appear in the five filtered rows, and confirm `fresh_chapters` still lists a
read fic with a new chapter.

---

## 3. Fix 2 — the entity problem (the actual main functionality, missing)

The user is right that this is the main thing and that it is missing. Two
separate gaps:

### 3.1 The frontend has no recommendation surface at all

kindred's core function is recommending **entities** from seeds — works,
authors, tags, fandoms, users, collections — by taste. The extension's feed
recommends *fics only*, and does so from a local candidate cache. The kindred
web UI (added 2026-09-29) has a working `/recommend` API and an arena, but the
extension has no concept of a backend at all: `host_permissions` is
`["https://archiveofourown.org/*"]` and every `fetch` in the codebase targets
AO3.

So the two halves of the user's actual goal — kindred recommends entities, the
extension helps populate kindred — have no connection. §4 builds it.

### 3.2 The extension models fics, not entities

`db.js` has 7 object stores: `preferences`, `history`, `ficCache`,
`authorAffinity`, `customRows`, `settings`, `dislikeHistory`. Author affinity is
the only non-fic entity, and it is a scoring input rather than a
recommendable object. There is no tag entity, no fandom entity, nothing
addressable by URL.

`scoring.js:88-113` matches tags and fandoms as *strings* against flat
preference maps. `preferredTagMap` is built from `preferred_tag` rows
(`scoring.js:288`) — strings with weights, no identity, no co-occurrence, no
relationship to a work beyond the string matching on screen.

Consequences, all of which cap recommendation quality:

- A tag cannot be recommended, only matched.
- No tag-tag similarity, so "recommended because you like X" cannot be
  generalised past exact strings.
- Author affinity is capped at 5 completed reads (`scoring.js:121`) and is the
  only author signal.

---

## 4. Integration — kindred is the recommendation source, local scoring is the fallback

**Direction (user decision, 2026-09-29): kindred's API is the primary source
for recommendations. If kindred is unreachable, fall back to what the extension
does today.** This inverts the first draft of this spec, which proposed kindred
as an *additional* row. It is better: one recommendation path, better ranking,
and the local path is a degradation rather than a peer.

### 4.1 The shape

```
kindred reachable  →  GET /api/v1/recommend?seeds=...&k=20
                     rows built from the response's evidence[]
                     (row titles keep today's wording)

kindred unreachable →  today's local path, unchanged:
                       scoreAllWithData + ROW_DEFINITIONS + excludeReadItems
```

No new row, no toggle for "which source" — a second source is a second thing to
be wrong. One source, chosen per feed build, recorded in the feed header so the
user can see *why* a feed looks flat ("kindred unreachable — showing local
ranking"). Silent fallback is the failure mode here: a user whose feed quietly
degrades has no way to know, and the honest report is the whole point.

### 4.2 What kindred already gives us, verified

`GET /api/v1/recommend?seed=ao3_work:10057010&n=30` on the live instance returns
items carrying an `evidence[]` array, one entry per signal, each with `signal`,
`value`, `weight` and a human `reason`:

```json
{"signal": "neighbourhood", "value": 56.41, "weight": 0.333,
 "reason": "42 tags reach the seed neighbourhood; strongest is \"bellatrix black lestrange\" (pmi-weighted vote 32.38)"}
{"signal": "peer_rating", "value": 0.204, "weight": 0.122,
 "reason": "arena effective rating 1773.5"}
```

That maps onto the extension's existing `breakdown` object almost field for
field, so the "why this?" UI works against kindred's reasons with no new
formatting code. The live signals are `neighbourhood`, `tag_overlap`,
`popularity`, `quality`, `peer_rating`, and `recency` is reported in
`meta.degraded[]` when it cannot contribute.

**This is a strict ranking upgrade.** kindred scores against 112,935 works with
a graph-backed tag index and PMI-weighted tag voting; the extension scores flat
string matches against whatever the user happened to visit. The local path is
genuinely the fallback it should be.

### 4.3 The entity problem this finally fixes

The user's actual complaint about kindred was that entity recommendation was
missing from the frontend. The extension is where that surfaces: kindred's
`/recommend` already handles `kind=` across works, tags, fandoms, authors and
users, and the extension's feed is the natural place to *show* non-work
entities, which the kindred web UI still does not do well.

So §4.4 is not plumbing for its own sake — it is the delivery mechanism for
"kindred recommends entities and you can see it."

### 4.4 What the extension sends back (anonymous, opt-in, off by default)

Taste signals, not reading history. This is the load-bearing distinction: the
extension holds the most sensitive data in the system (a full list of what
someone reads), and the part useful to kindred is a small aggregate.

Per taste event — a `preferred_tag`/`preferred_fandom` weight change, a
`userVerdict`, a dislike with its reason:

```json
{ "v": 1, "kind": "taste", "tag": "enemies to lovers", "delta": 0.4 }
```

Batched on a timer, never per keystroke. Never: fic URLs being read, titles,
author names of works being read, or anything identifying the *reader*. The
server learns what the population likes, never who.

### 4.5 Client changes — as built

`kindred.js` is new: the base URL, `fetchRecommendations()` with a 30s timeout,
and a batched retrying `TasteQueue`. It touches no DOM, no IndexedDB and no
`chrome.*`, which is what lets the whole fallback table be tested in plain node.
`feed.js` gains `resolveSource()` ahead of `renderAllRows` — kindred first,
local on any failure. `preferences.html` / `preferences.js` gain the section and
the toggle.

**`manifest.json` does NOT gain a `host_permissions` entry, and that is the
decision rather than an omission.** Two reasons. Chrome requires
`chrome.permissions.request()` to come from a user gesture, so the toggle is the
only place it can work. And a static entry is requested at install, from every
reader, for a host they have not chosen — while this extension's own description
promises *"All data stays on your computer."* The permission is requested when
the reader switches the toggle on, and a denial puts the checkbox back and says
why.

### 4.5a One correction to this spec, and the bug it would have shipped

§4.1 says the fallback is recorded "in the feed header". The first implementation
put `container.innerHTML = source.bannerHtml` on the line *after*
`container.innerHTML = ""` — so the note existed in the code, was computed
correctly, and was discarded before anything could read it. A silent
degradation, which is the exact failure this section exists to prevent.

There is a second instance of the same shape, and it is the one worth
remembering: `readKindredSettings` read `chrome.storage.local` while every other
setting in the extension is written through `dbPut("settings", …)` into
IndexedDB. So the read found nothing, `kindredEnabled` was always falsy, and
`resolveSource` took its `"disabled"` branch — a perfectly correct no-op. The
feature would have shipped with a working toggle, a working client, a green
suite, and no recommendations ever.

**A feature that is off by default fails silently when its on-switch does not
connect.** Nothing throws, and the absence of recommendations is
indistinguishable from a reader who has not opted in. The test that now catches
it writes a settings record the way `preferences.js` does and asserts the
network is reached — because the per-seam tests all pass while the pieces are
disconnected.

**The permission is requested on toggle, not at install.** Chrome requires
`permissions.request()` to be user-initiated, so the toggle in `preferences.html`
requests it; the default-off state ships without the permission at all. This is
a platform constraint, not a preference.

### 4.6 Fallback must be total

Every kindred failure mode resolves to today's behaviour: unreachable host, 404
because a self-hosted instance runs an older kindred, malformed JSON, empty
result set, timeout. An empty result set is the subtle one — a reachable kindred
with no matches is not an error, and treating it as one would make a
cold-start kindred silently drop the user to local ranking while looking like
a bug. Empty ⇒ render local, and say so.

### 4.7 Licensing — RESOLVED 2026-09-30. Not blocking.

Read before writing any of §4, as this section required.

| Repo | Licence |
|---|---|
| `ao3-reading-companion` | **MIT** — 1,070 bytes, `Copyright (c) 2026 DisastrousClass` |
| `kindred` | **AGPL-3.0** — 34,523 bytes |

The answer is not "copyleft with a share-alike term, so be careful". The two
licences are on **opposite sides** of the permissive/copyleft line, and the
asymmetry is what makes §4.5's wire protocol the only correct design:

- **MIT extension calling an AGPL service over HTTP: fine.** Separate works,
  communicating at arm's length. No code is copied, so no obligation transfers.
- **kindred code inside the extension: never.** AGPL would infect an MIT work
  that is a public clone, and the network clause reaches the service worker too.
- **Feeding kindred's database from the extension: fine.** Facts and weights are
  not the extension's creative expression.

**Enforced, not merely documented:** `tools/check-license-asymmetry.mjs` fails
if any of 21 kindred implementation symbols (`PMI`, `Neighbourhood`,
`persistCSR`, `OwnerKey`, `arena_user_blocked_tags`, …) appears in the
extension's JS, with comments stripped so prose about the boundary is fine and
an actual port is not. The wire names — `seeds`, `n`, `items`, `evidence` — are
deliberately NOT in the list, because those are the interface and using them is
the point.

### 4.8 What is deliberately not built

- No taste vector upload. Aggregate deltas only; kindred does the aggregating.
- No read-history sync. It is the most sensitive data and the least useful
  per-reader; the *aggregate* is what improves recommendations.
- No kindred calling AO3 on the extension's behalf. kindred reads its own
  mirror.

---

## 5. Sequence

1. **Fix 1 — done and verified.** `excludeReadItems` in `feed.js`, 7 tests, 4
   mutations caught. The reported bug, shipped on its own.
2. **§4.4 licensing** — read `LICENSE`, answer the share-alike question.
3. **§4.1/§4.5 kindred as the source** — after step 2.

Fix 1 ships first and independently: nothing in §4 depends on it, and putting
the reported bug fix behind a change that touches `host_permissions` would make
it harder to review, not easier.

## 6. Open questions for the user

1. **§4.4 licensing** — read `LICENSE` and confirm share-alike terms before §4
   code is written. This is the one item that can invalidate the design.
2. **§1.3 jitter** — fix `discover_new`'s range of 4 alongside §1, or leave it
   and accept that row stays close to random? Recommend fixing it; it is one
   number.
3. **Host** — the extension is browser-side and the kindred instance is
   self-hosted. Does the extension point at `kindred.polarisocial.xyz`, or at a
   user-run local kindred on `127.0.0.1:8010`? Local-first is the default,
   public is opt-in, because §4.1 assumes the server is the user's to trust.


## 7. What was and was not built

Built and verified 2026-09-30:

| § | Item | State |
|---|---|---|
| §1 | read-history filter (`excludeReadItems`) | done earlier, `8753a64` |
| §1.3 | `discover_new` jitter | **done** — was a halfwidth of 4, i.e. an 8-point spread on a row whose signal is one tag match |
| §4.1 | kindred as the source, local as fallback | done |
| §4.4 | licence question | **resolved**, §4.7 above |
| §4.5 | `kindred.js`, the feed switch, the toggle | done |
| §4.6 | total fallback | done — 6 failure modes, each with its own reason and a banner |
| §4.4 | taste queue | done — aggregate deltas only, allow-list enforced by a check |
| §3 | the entity problem / recommendation surface | **not built** |

§3 is not built and is not blocked on anything here. It asks for a
recommendation surface in the extension's own UI for non-work entities —
fandoms, authors, tags — which is a UI project rather than an integration one.
The kindred API already supports `kind=` across those entity kinds
(`buildKindredSeeds` emits opaque `kindred_seed:*` strings and does not parse
them, so a new entity kind needs no change there), so the remaining work is
presentation.

## 8. Verification that actually ran

From a fresh clone of the committed tree, not the working directory:

- `node --test 'test/*.test.mjs'` — **116 tests, 0 failing** (41 before this work)
- `npm run check` — 4 checks, all PASS
- Every check mutation-proven to fail: jitter 5, kindred client 6, fallback 7,
  licence 2, privacy 2, allow-list disagreement 1

Mutations that survived and the coverage written in response, because the
survivals are the interesting part:

| Mutation | Why it survived | What caught it |
|---|---|---|
| `discover_new` back to 4 | the test held a verbatim copy of the constants | a drift test parsing the real source |
| jitter formula one-sided and 2x wide | the formula was copied too | a shape test on `_scoreJitter`'s source |
| `clearTimeout` removed | node's runner exits regardless of pending timers | a subprocess test asserting the process exits |
| a `fic:` field on the taste payload | the check matched URL literals, not field names | a structural check on the payload's keys |
| banner computed then overwritten | tests inspected the return value, not the render | a source assertion on the `innerHTML` ordering |
| main-path banner dropped | an existence check passes while the *other* branch has it | a count of the assignments |
| `kindred: null` falling through to the global | `falsy-or` was indistinguishable when a global exists | an explicit three-state test |
