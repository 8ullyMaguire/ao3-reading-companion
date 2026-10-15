# Lorehaven Companion

A Firefox extension that puts your configured [Lorehaven](https://git.polarisocial.xyz/hirrolot19/lorehaven)
instance in the toolbar: the recommended feed, your reading history and notes, and the
works you are part-way through — for the reader who wants the instance's judgement, not a
second one invented in the browser.

A fork of [`ao3-reading-companion`](https://github.com/8ullyMaguire/ao3-reading-companion)
(MIT, see `NOTICE` and `docs/PROVENANCE.md`). The fork keeps upstream's shell and removes
its brain: **the server is the only ranker** (spec §48.2), so the extension holds no taste
store, no scoring code and no client-side ordering.

## Loading it

No build step and no runtime dependencies — deliberately, because an extension that needs
`npm install` is one that will not load in `about:debugging`.

1. `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → pick `manifest.json`.
2. Set your instance URL in the extension's settings. It is shown in the popup at all
   times, so you can always see which server it is talking to (§48.5).
3. Sign in to that instance in the same browser. The extension reads the instance's
   session and CSRF cookies; it never stores the CSRF token, and it refuses to send
   anything to a host you have not configured.

## What the server does and does not give the feed — measured, not assumed

Each line below was read out of Lorehaven's own route tables and DTOs, and each is the reason
something is shown, omitted, or stated as absent.

- **"Why this?" exists.** `GET /api/v1/discovery/slots/{slot_id}/explanation` (M29, §33.3)
  returns the *recorded* slot — `reasons[]`, `blend_score`, `served_at`, `instance_curation`,
  `seeded_by`, `recipe_stage` — and `GET /api/v1/discovery` stamps every item with its
  `slot_id` for exactly that purpose. The page renders the server's own words; a slot it
  cannot read is rendered as *not available*, never as a recomputed breakdown.
- **Impressions are the server's to record**, and it does: the discovery handler calls
  `recommendation_slots::record_response` for every item it serves. The extension logs none,
  because a client-side impression record would compete with the server's own account of
  what it served.
- **A card cannot show tags.** `PublicWorkView` (`routes/works.rs:236`) carries `id, title,
  summary, language, rating, visibility, completion, published_at, show_public_ratings,
  discussion_mode, rating_summary, metrics, authors, chapters, rec_blurb` — and no tags of
  any kind, and no update time. `feed-model.js` names them in `MISSING_SERVER_FIELDS` instead
  of inventing values; `published_at` is a publication time and is never shown as an update.
- **Kudos and views may be `null`**: `metrics` is null when the owner has switched public
  aggregates off (§9.5), so the page omits the number rather than printing a `0` that would
  claim nobody had read it.
- **The discovery feed carries ids only** (`{"work_id": …}`, plus `slot_id`), so details come
  per work from `GET /api/v1/works/{id}`. A work whose details fail to load keeps its place:
  the order is the server's, and a card that quietly dropped or moved would be re-ranking.
- **Route shapes worth not guessing**: one history entry is
  `DELETE /api/v1/library/history/{id}`, all of them are `POST /api/v1/library/history/clear`;
  the collection has no DELETE. Notes are `GET|PUT /api/v1/notes` and `DELETE /api/v1/notes/{id}`.
- Chromium is out of scope (§48.10). Signed-in use only — that cost is stated in §48.2.

## Port status

This is a fork mid-port. What has landed, and what has not, is in
[`docs/PORT-STATUS.md`](docs/PORT-STATUS.md) — written so the next reader does not have
to diff the tree against the plan.

## Tests

```sh
npm test          # node --test 'test/*.test.mjs' — no dependencies
npm run check     # the read-filter harness
```
