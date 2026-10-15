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

## Known limitations — stated, not silently absent

- **"Why this?" has no endpoint.** Lorehaven's `GET /api/v1/discovery` returns the works
  but not the per-item reasons (§48.3 wants them; the data sits behind an operator route).
  The extension renders *reasons not yet available* rather than a plausible-looking
  breakdown, because a recomputed explanation is a lie (§33.3).
- **Impression logging has no route.** `log_impression` exists in the server's ranking
  layer and nothing calls it, so an impression generated here would have nowhere to go.
  That is why the extension logs none.
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
