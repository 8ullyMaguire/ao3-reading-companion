# Port status — lorehaven-companion

Written so the next reader does not have to diff the tree against the plan. The plan is
`docs/PLAN.md`; the contract is Lorehaven's `docs/spec.md` §48.

## Landed

| Plan step | State | Where |
|---|---|---|
| 1 — provenance | **done** | `README.md`, `NOTICE`, `docs/PROVENANCE.md` |
| 2 — manifest retarget | **done** | `manifest.json` (Firefox only, `cookies` permission, instance enforced in code) |
| 4 — the client | **done** | `lorehaven.js` — the only file that calls `fetch` |
| 5 — the labelled cache | **done** | `cache.js` — `cached(key, loader)`, `staleLabel(entry)` |
| 6 — the feed shows the instance | **half** | `lorehaven.html` + `lorehaven-page.js` + `feed-model.js` landed. `feed.js` (the AO3 feed, 2882 lines) is untouched and still builds its own rows. |
| 7 — the instance setting | **done** | `db.js` (`settings.instance`, `getInstance`/`setInstance`), the popup row, the page's setup form |
| 3 — delete the local ranker | **not started** | `scoring.js`, `dislike.js`, `parsers.js`, `tag-suggest.js` are still loaded by `feed.html` and `preferences.html`; `debug.html` still inspects their stores. |

## Why step 3 and the rest of 6 are one piece

`feed.html` loads `scoring.js` and `dislike.js`, and `feed.js` calls them; `preferences.html`
and `preferences.js` (1825 lines) are the AO3 taste-tuning UI. Deleting the brain before the
old page stops calling it leaves a page that loads and then fails — worse than where it is
now. So the remaining work is: replace `feed.js` with a page that renders `feed-model.js`'s
output, then delete `scoring.js`, `dislike.js`, `parsers.js`, `tag-suggest.js`, `debug.*` and
the taste half of `db.js`, and point the nav at `lorehaven.html`.

## Corrections to earlier claims in this port (measured, both mine)

- **`background.js` does not call the local ranker.** Its three hits for `scoring|dislike|
  parsers` are the data *field* `dislikeReason`. The callers are the pages: `feed.js`,
  `preferences.js`, `debug.js`. Dropping `scoring.js`/`parsers.js` from `background.scripts`
  is therefore safe on its own — the coupling is in the pages, not the background.
- **`DELETE /api/v1/library/history/{id}` does exist** (`reading.rs:58`). An earlier revision
  of this port removed it in favour of a collection-level `DELETE /api/v1/library/history`,
  which is *not* a route. The id-suffixed form was right; the collection form was the
  invented one. Both are now in the client, correctly.

## The rule the remaining work must keep

The server ranks. The client renders, marks, and states absences. Nothing in the extension
sorts, scores, jitters or filters a recommendation list — `feed-model.js` is the only place a
payload becomes a list, and its tests pin the server's order against payloads whose scores
disagree with it.
