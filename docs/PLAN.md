# lorehaven-companion — the Firefox companion

> Contract lives in `lorehaven/docs/spec.md` **§48**. This file is the *how*.
> Read §48 first; it is the authority on what may be built, and this plan
> implements it rather than re-deciding it.

**Upstream:** `github.com/8ullyMaguire/ao3-reading-companion` @ `8753a64`, MIT,
`Copyright (c) 2026 DisastrousClass`. 17,575 lines, 25 files, 41 passing tests.
No build step, no runtime dependencies — a property worth keeping, because an
extension that needs `npm install` is one that will not load in `about:debugging`.

---

## 0. The shape of this port

**Reuse the shell, replace the brain.** The upstream repo is an on-device AO3
recommender. Its feed UI, settings UI, reading-list UI and first-run flow are
good work and are kept. Its scorer, taste store, DOM parsers and content filters
are deleted, because §48.2 makes the server the only ranker and §48.4 makes
filtering server-only.

```
KEEP    manifest.json (retarget), feed.*, myreading.*, preferences.*,
        onboarding.*, popup.*, icons/, test harness shape
DELETE  scoring.js, db.js (taste + affinity stores only), dislike.js, parsers.js
ADD     lorehaven.js (the API client), cache.js, tests/
```

`db.js` needs care: it is one file with both a taste store and a read-tracking
store. Delete the taste/affinity half, keep the read-tracking half, because §48.3
still needs to know what the reader has read.

## 1. What lorehaven gives the extension, and what it does not

Verified against the tree on 2026-09-30. This table is the port's whole contract.

| Need | Lorehaven has it? | Route / symbol |
|---|---|---|
| Session cookie | yes | `lorehaven_session` (`crates/app/src/auth.rs:36`) |
| CSRF token cookie | yes | `lorehaven_csrf` + `x-csrf-token` header (`:39`, `:42`) |
| CSRF enforcement | **configurable** | `security.csrf_required`, checked at `auth.rs:164`; only safe methods skip it (`auth.rs:816`) |
| Recommended feed | yes | `GET /api/v1/discovery` (`routes/discovery.rs:22`) |
| Feed with per-item reasons | **NO** | no `explain` param, no `SlotExplanation` in the response |
| Reader's taste vector | yes | `GET /api/v1/discovery/taste-profile/me` (`:24`) |
| Reading history | yes | `GET/DELETE /api/v1/library/history` (`routes/reading.rs:56-58`) |
| Reading notes | yes | `GET/PUT /api/v1/notes`, `DELETE /api/v1/notes/{id}` (`:67-68`) |
| Works / library listing | yes | `GET /api/v1/works` (`routes/works.rs:76`) |
| Kudos | yes | `POST /api/v1/works/{id}/kudos` (`routes/works.rs:78`), needs only `content.read` scope (`works.rs:1450`) |
| Content filter state | yes | `GET /api/v1/me/dnf` (`routes/dnf.rs:64`) — display only |
| Streak | yes | `GET /api/v1/me/streak` (`discovery.rs:46`) |
| Impression logging (M47) | **NOT WIRED** | `log_impression` exists in `crates/db/src/ranking.rs`, no route calls it |

**Three request shapes, read out of the handlers rather than guessed:**

- notes: `NoteRequest` at `routes/reading.rs:120` is
  `{subject_type, subject_id, anchor?, body}` — *not* `{work_id, body}`. The
  handler passes `subject_type` straight to `save_note` as a free-form string, so
  `"work"` is a convention the reader must follow, not a value the database
  constrains. Worth an integration test against a live instance; worth nothing
  more until one exists.
- kudos: `toggle_kudos` requires `Scope::ContentRead`, not `content.write`
  (`works.rs:1450`), because kudos are a statement about the reader. So a
  reader-scoped token is enough, and the extension must not request more.
- everything non-safe: CSRF per §2.

**Two gaps block features, and both are honest blockers rather than surprises:**

- **§48.3's "why this?" has no endpoint.** `get_discovery` takes a `limit` and a
  session and returns `Json<serde_json::Value>`; there is no reason field. The data
  is in `recommendation_slots` behind `/api/v1/operator/rec/shadow`, which is an
  operator route. §33.3 requires reasons at serve time, so the extension's
  per-item breakdown needs a server change first.
- **§47's `log_impression` has no route.** M45-49 is `implemented-locally-tested`
  and this is the reason: the function is correct and unreachable. Until a route
  calls it, an extension-generated impression has nowhere to go, which is *another*
  reason §48.2 was the right call.

## 2. The CSRF problem, stated before it bites

Lorehaven requires `x-csrf-token` on non-safe methods when
`security.csrf_required` is on. A browser extension holds no DOM cookie jar it can
read `HttpOnly` values from, and `lorehaven_csrf` is deliberately script-readable
precisely so clients can echo it.

**The client therefore reads `lorehaven_csrf` from `document.cookie` and sends it
as `x-csrf-token` on every POST/PUT/DELETE.** Three consequences:

1. The extension only works against an instance with `csrf_required = true` if it
   can read that cookie. If an operator disables CSRF, the extension still works
   (no header needed). Both paths are supported.
2. If an instance ever marks `lorehaven_csrf` `HttpOnly`, the extension's writes
   break. That is a server change to §9's auth model, and it is flagged here
   rather than worked around.
3. The extension must not log or store the CSRF token. It reads it, sends it,
   forgets it.

## 3. Steps

Each step ends in a command and its expected output. An implementer with zero
context should be able to run these in order and stop at the first divergence.

### Step 1 — the fork, with provenance

```sh
cd ~/code-local/rust/lorehaven-companion
git fetch upstream main
git reset --hard upstream/main          # start from upstream, not from my notes
npm test                               # 41 passing, before any edit
```

**Verify:** `41 passed` — the baseline is proven green *before* the port, so a later
failure is attributable.

Then rewrite the three provenance files. `LICENSE` stays **verbatim** (upstream MIT,
`Copyright (c) 2026 DisastrousClass`). Add `NOTICE`:

```sh
cat > NOTICE <<'EOF'
lorehaven-companion is a fork of ao3-reading-companion
(https://github.com/8ullyMaguire/ao3-reading-companion), MIT licensed,
Copyright (c) 2026 DisastrousClass. The LICENSE file is upstream's, unmodified.

The copyright holder above and the repository owner are not the same name, and
that discrepancy is unresolved. Both are credited here rather than silently
normalised to one. Confirming it is a precondition of RELEASE, not of
development: the code is MIT either way.

Forked from upstream commit 8753a64. The recommender was replaced -- see
lorehaven docs/spec.md section 48.2 for why the extension holds no ranker.
EOF
```

And in `README.md`, replace the title and add the fork note. Record the upstream
commit in the repo (`docs/PROVENANCE.md`) rather than in the README body, so
provenance is a file you can diff.

**Verify:** `grep -c "DisastrousClass" LICENSE NOTICE` returns `2`.

### Step 2 — manifest, retargeted

Rewrite `manifest.json`. Firefox-only, per §48.10. Changes from upstream:

- `name` → `Lorehaven Companion`
- `gecko.id` → `lorehaven-companion@lorehaven` (an add-on id must be stable
  forever; this is a decision, not a placeholder)
- `content_scripts[0].matches` → `https://lorehaven.invalid/*` **removed entirely**:
  there is no Lorehaven web page to inject into, because Lorehaven is a server
  application and this extension is a standalone surface. No content script.
- `host_permissions` → the reader's configured instance. Firefox does **not**
  support a dynamic `host_permissions` value at runtime from `storage` without
  `permissions.request()` at runtime, which prompts. **Decision: request
  `host_permissions` for `*://*/*` once at first run** and refuse to send anything
  to a host the reader has not configured, enforced in `lorehaven.js` — because
  §48.5's guarantee is "credentials go only to the configured instance", and a
  per-instance permission prompt on every instance switch is worse UX than one
  honest broad permission the code never abuses.
- `background.scripts` → `["lorehaven.js", "db.js", "background.js"]` (drop
  `scoring.js`, add `lorehaven.js`)

**Verify:**
```sh
node -e "const m=require('./manifest.json'); console.log(m.content_scripts===undefined||m.content_scripts.length===0, m.background.scripts.join(','), m.browser_specific_settings.gecko.strict_min_version)"
```
prints `true lorehaven.js,db.js,background.js 115.0`.

### Step 3 — delete the brain, and prove it is gone

```sh
rm scoring.js dislike.js parsers.js
```

`db.js` is a surgical edit, not a deletion. Read it first, then remove the taste
and affinity stores, keeping the read-tracking store. Concretely: delete every
store whose name contains `taste` or `affinity`, and every function that writes a
user-set tag weight. Keep `read_ids` / `completed` / the read tracker.

**Verify the deletion is real — this is the §48.9 check:**
```sh
node -e "const s=require('fs').readFileSync('db.js','utf8');
const bad=['TAGS','TAG_WEIGHTS','affinity','AFFINITY'].filter(t=>s.includes(t));
console.log(bad.length? 'LEAKED: '+bad : 'clean')"
```
prints `clean`. And `grep -rn "scoring\|dislike\|parseAo3" *.js` returns nothing.

**The test that keeps the deletion honest** — `test/no-local-ranker.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';

test('no module can compute a ranking locally (§48.2)', () => {
  const files = readdirSync('.').filter(f => f.endsWith('.js'));
  const banned = ['scoring.js', 'dislike.js', 'parsers.js'];
  for (const f of banned) {
    assert.ok(!files.includes(f), `${f} still present — the local ranker must not come back`);
  }
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/TAG_WEIGHTS|taste_weights|affinity_scores/.test(src),
      `${f} references a local taste store`);
  }
});

test('every fetch target is the configured instance (§48.5)', async () => {
  const src = readFileSync('lorehaven.js', 'utf8');
  assert.ok(src.includes('assertConfiguredOrigin'),
    'the API client must check its target origin before every request');
});
```

**Verify:** `node --test test/no-local-ranker.test.mjs` → `2 passed`. Then break it
on purpose — `touch scoring.js` — and confirm it fails. A test that has never been
shown red is not evidence.

### Step 4 — the API client

New file `lorehaven.js`. The only place that calls `fetch`. Shape:

```js
'use strict';
const SESSION_COOKIE = 'lorehaven_session';   // auth.rs:36
const CSRF_COOKIE = 'lorehaven_csrf';        // auth.rs:39
const CSRF_HEADER = 'x-csrf-token';          // auth.rs:42

let configuredBase = null;   // e.g. https://reading.example.org

function configuredOrigin() {
  if (!configuredBase) throw new Error('No Lorehaven instance configured (§48.5)');
  return new URL(configuredBase).origin;
}

function assertConfiguredOrigin(url) {
  if (new URL(url).origin !== configuredOrigin()) {
    throw new Error('Refusing to send credentials off-instance (§48.5)');
  }
}

function readCookie(name) {
  const hit = document.cookie.split('; ').find(c => c.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

async function api(path, { method = 'GET', body } = {}) {
  const url = configuredOrigin() + path;
  assertConfiguredOrigin(url);                       // §48.5
  const headers = { 'accept': 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = readCookie(CSRF_COOKIE);            // §2
    if (csrf) headers[CSRF_HEADER] = csrf;
  }
  const res = await fetch(url, {
    method, headers,
    credentials: 'include',                          // session cookie, nothing else
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
}
```

**Every function the extension needs, each with the route verified in §1:**

| function | call | returns |
|---|---|---|
| `getFeed()` | `api('/api/v1/discovery')` | works array |
| `getTasteVector()` | `api('/api/v1/discovery/taste-profile/me')` | vector |
| `getHistory()` | `api('/api/v1/library/history')` | history |
| `getNotes()` | `api('/api/v1/notes')` | notes |
| `addNote(workId, text)` | `api('/api/v1/notes', {method:'PUT', body:{subject_type:'work', subject_id:workId, body:text}})` | — |
| `toggleKudos(workId)` | `api(`/api/v1/works/${workId}/kudos`, {method:'POST'})` | — |
| `getDnf()` | `api('/api/v1/me/dnf')` | filters, **display only** |
| `getStreak()` | `api('/api/v1/me/streak')` | streak |

`test/lorehaven-client.test.mjs` covers the origin assertion with a real
counter-test: a request to `https://evil.example/` must throw. And a test that
`assertConfiguredOrigin` is called on the *write* path too, not only reads.

**Verify:** `node --test test/lorehaven-client.test.mjs` → `N passed`. A client
with no tests is how an extension ends up POSTing someone's notes to a host it
should not.

### Step 5 — cache, labelled

New file `cache.js`. §48.5: cached content is shown **labelled, with its age**,
never as live. A `Map` plus a one-hour TTL in `browser.storage.local` (not
IndexedDB — a cache is not state, and §48.5 says so).

```js
const TTL_MS = 60 * 60 * 1000;   // §48.5
async function cached(key, loader) {
  const hit = (await browser.storage.local.get(key))[key];
  if (hit && Date.now() - hit.at < TTL_MS) return { data: hit.data, at: hit.at, stale: false };
  try {
    const data = await loader();
    await browser.storage.local.set({ [key]: { data, at: Date.now() } });
    return { data, at: Date.now(), stale: false };
  } catch (err) {
    if (hit) return { data: hit.data, at: hit.at, stale: true };  // labelled, with age
    throw err;
  }
}
```

`test/cache.test.mjs`: a failing loader with a warm cache returns `stale: true`
and the old `at`; a failing loader with a cold cache throws. The first is the
behaviour that keeps §48.5 honest.

**Verify:** `node --test test/cache.test.mjs` → `2 passed`, and a fresh test where
`at` is 3 hours old is served as stale.

### Step 6 — the feed UI, rewritten to be a surface

`feed.html/js/css` keep their structure; the data layer is replaced wholesale.
Every one of the seven upstream feed rows (`scoring.js:19`) is **deleted** — the
server returns one ordering, so seven client-side row types would be seven ways
for the extension to disagree with it.

The one genuine port: `buildMatchStrengthLabel(breakdown)` at `feed.js:618` takes
a `{tag, author, fandom, content}` breakdown. Lorehaven's `SlotExplanation`
(§33.3) has a different shape, so **the function is retained but the shape changes**
to accept a `SlotExplanation`, and until the endpoint exists (§1) it renders a
stated "reasons not yet available" rather than a fabricated breakdown. Rendering a
plausible-looking reason is exactly the lie §33.3 forbids.

`test/feed.test.mjs`: the feed renders N items from a fixture of N works, and the
"why this?" element says *unavailable* — not *empty*, not a guess.

**Verify:** `node --test test/feed.test.mjs` → `2 passed`.

### Step 7 — settings: one instance, always visible

`preferences.js` gains an instance field and drops the upstream's AO3-specific
preferences. The instance URL is shown in the popup **at all times** (§48.5), not
buried in settings, because an extension that talks to a server is one the reader
should be able to see the name of.

**Verify:** `node --test test/settings.test.mjs` → `2 passed`, one asserting the
base URL renders in the popup on every open.

### Step 8 — the full gate

```sh
cd ~/code-local/rust/lorehaven-companion
npm test                    # every test in the fork
npm run check               # the read-filter harness, retargeted
node --test test/no-local-ranker.test.mjs   # the §48.2 guard, explicitly
```

Then **manual**, because no unit test proves an extension loads:

1. `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → pick
   `manifest.json`. It must load with **no** errors in the console.
2. Set the instance to a running Lorehaven. Open the popup. The feed renders real
   works from `/api/v1/discovery`.
3. Stop the server. Reload the popup. The feed shows the cached copy **labelled as
   cached with its age**, and does not claim to be live.
4. Open a work the reader's DNF filter excludes. Confirm it does not appear — and
   confirm it does not appear in the **cached** copy either.
5. `about:networking` or the add-on's request inspector: the only hosts contacted
   are the configured instance. Nothing else.

## 4. Definition of done

- [ ] Forked from `upstream/main` @ `8753a64`, `LICENSE` verbatim, `NOTICE` names
      both DisastrousClass and 8ullyMaguire, provenance in `docs/PROVENANCE.md`
- [ ] `manifest.json`: Firefox-only, `strict_min_version` 115,
      `data_collection_permissions: ["none"]`, **no content script**
- [ ] `scoring.js`, `dislike.js`, `parsers.js` deleted; `db.js`'s taste and
      affinity stores removed, its read-tracking kept
- [ ] `test/no-local-ranker.test.mjs` passes **and was shown to fail** when
      `scoring.js` is restored
- [ ] `lorehaven.js` is the only file that calls `fetch`; every request asserts
      its origin first; the off-instance request test is a real counter-test
- [ ] CSRF handled per §2: read `lorehaven_csrf`, send `x-csrf-token` on writes,
      never store it
- [ ] Cache is labelled stale with its age; a cold cache + dead server throws
- [ ] All seven upstream feed rows deleted; no client-side ordering path exists
- [ ] "Why this?" renders *unavailable*, never a fabricated breakdown
- [ ] Instance URL visible in the popup at all times
- [ ] `npm test` green; the five manual checks in Step 8 done by a human
- [ ] The two blockers in §1 (no reasons endpoint, no impression route) are
      either fixed server-side or stated in the extension's README as known
      limitations — not silently absent

## 5. Open, deliberately

- **Chromium**: §48.10 excludes it. If wanted, it is a spec amendment.
- **Anonymous use**: requires being signed in. §48.2 states the cost.
- **Per-item reasons**: blocked on a server change; §48.3 names two options and
  chooses neither. The owner picks.
- **Impression logging from the extension**: blocked until a route calls
  `log_impression`. This is M45-49's missing step 7, and it is the same work.
- **Offline install packaging**: `npm test` and a temporary add-on are the gate
  here. AMO signing is a release step, out of scope for the port.
