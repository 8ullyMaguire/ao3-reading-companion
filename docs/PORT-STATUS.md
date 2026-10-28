# Port status — darkhold-companion

**The port is complete.** Every step of `docs/PLAN.md` has landed and the local ranker is gone.
Written so the next reader does not have to diff the tree against the plan; the contract is
Darkhold's `docs/spec.md` §48.

## What the extension is now

A client for one instance. It asks the server what to recommend, renders the answer in the
server's order, shows the reasons the server recorded, marks what the reader has read, and states
plainly when something is absent. **No file in this extension ranks, sorts, scores or filters a
recommendation list** — `feed-model.js` is the only place a payload becomes a list, and
`test/port-guard.test.mjs` is §48.2 as a test.

| File | What it is |
|---|---|
| `manifest.json` | Firefox only; `storage` + `cookies`; the background is two scripts |
| `darkhold.js` | the client — the only file that calls `fetch`, one origin rule |
| `cache.js` | TTL cache; a failed reload serves the last copy labelled with its fetch time (§48.5) |
| `feed-model.js` | the render model; the server's order verbatim; absences named |
| `feed.html` / `feed.css` / `feed-page.js` | the feed |
| `db.js` | the instance setting, and nothing else |
| `background.js` | seeds settings on install, opens the feed once |
| `popup.html` / `popup.js` / `popup.css` | which instance, clear the cached feed, open the feed |

## What was deleted, and why each part could not stay

The plan's DELETE list named three files (`scoring.js`, `dislike.js`, `parsers.js`). The footprint
was larger, and every part was measured before it went:

- **`scoring.js`, `dislike.js`, `parsers.js`** — the ranker and the parser. §48.2 moves ranking to
  the instance.
- **`content.js` and `background.js`'s scrape half** — the AO3 collection pipeline: listing
  scrapes, subscription syncs, the login check, and the history/reading-time messages. It fed the
  local stores and the local ranker; with both gone it had no consumer, and its content script was
  already out of the manifest.
- **`tag-suggest.js`** — mined tags from browsed pages to feed the taste store. Its consumer is
  the taste store, which is gone.
- **`debug.js` / `debug.html`** — the store inspector: three of the four stores it inspected no
  longer exist.
- **`feed.js` (2882 lines), `feed.html`, `feed.css`** — the AO3 feed: seven row definitions, a
  custom-row builder, a manage-rows modal and an AO3 sync, all reading one scoring context.
  Replaced by `feed-page.js`.
- **`preferences.js` (1825 lines), `onboarding.js`, `myreading.js`** — taste tuning, AO3 onboarding,
  and a reading list built from scraped fic metadata. Each needed the pipeline.

`db.js` keeps its database name, and its old stores are left in place rather than deleted: deleting
a reader's local data to tidy a schema is not a trade this extension gets to make. Nothing reads
them.

## Corrections made along the way, all measured

- **`background.js` never called the local ranker.** Its three hits for `scoring|dislike|parsers`
  were the data *field* `dislikeReason`; the callers were the *pages*.
- **`DELETE /api/v1/library/history/{id}` exists** (`reading.rs:58`). An earlier revision had
  replaced it with a collection-level DELETE, which is not a route.
- **"Why this?" has an endpoint** — `GET /api/v1/discovery/slots/{slot_id}/explanation` — and the
  discovery handler stamps every item with its `slot_id`. The plan's §48.3 limitation was stale.
- **Impressions are the server's to record**, and it does, at serve time. The client logs none.
- **A card cannot show tags**: `PublicWorkView` carries no tags and no update time. Named in
  `feed-model.js` as `MISSING_SERVER_FIELDS` instead of defaulted.

## What is not verified here

**No browser was used.** `test/feed-page.test.mjs` drives the real `feed-page.js` against the real
client, cache and model in one shared scope, with a stubbed DOM, storage and `fetch` — so the page's
behaviour is covered, including the answers that are absences. That is not the same as the extension
loading in Firefox: the manual checks in the plan's Definition of Done (load it, see the feed, click
through) remain for a human with a browser.
