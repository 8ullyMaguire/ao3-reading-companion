# RENAME-NOTES — lorehaven-companion → darkhold-companion

The project formerly called **lorehaven** is now **darkhold**, and this extension
followed it. The extension is the same code against the same server routes: this
is a rename, not a port.

| | |
|---|---|
| Old name | `lorehaven-companion` / "Lorehaven Companion" |
| New name | `darkhold-companion` / "Darkhold Companion" |
| Old path | `~/code-local/rust/lorehaven-companion` |
| New path | `~/code-local/rust/darkhold-companion` |
| Date | 2026-10-28 |

## What changed

- **Directory**: `lorehaven-companion/` → `darkhold-companion/`.
- **The client module**: `lorehaven.js` → `darkhold.js` (`git mv`), and
  `test/lorehaven-client.test.mjs` → `test/darkhold-client.test.mjs`. Every
  `require`, `<script src=…>`, manifest entry and test that named the file follows.
- **`manifest.json`**: `name` and `action.default_title` are now
  `Darkhold Companion`; the description says "The Darkhold client".
- **`package.json`**: `name` is `darkhold-companion` (it was still the upstream
  fork's `ao3-reading-companion`) and the description names Darkhold.
- **Cookies**: the client asks for `darkhold_csrf` / `darkhold_session`, which is
  what the renamed server sets (`darkhold auth.rs:36`, `:39`). The server's cookie
  names are not this repo's to choose — renaming the client's constants *and not*
  them would have made every write 403.
- **User-facing strings**: page titles, the `<h1>`s, the "Open the feed" button id
  (`open-lorehaven` → `open-darkhold`), the "No Darkhold instance configured"
  error, console-log tags (`[Darkhold]`), the instance-URL placeholder
  (`https://darkhold.example`), comments, README, `NOTICE`, `docs/`.
- **`docs/PLAN.md` / `docs/PROVENANCE.md`**: the contract is now
  `darkhold/docs/spec.md` §48, which is where it lives.

## What stayed

- **The add-on id**: `gecko.id` is still `lorehaven-companion@lorehaven`. Firefox
  treats the id as the extension's identity, so changing it would ship a *new*
  extension rather than an upgrade — the old one stays installed, side by side, and
  a reader's settings and instance URL stay behind in it. A stable id is a
  documented decision in `docs/PLAN.md`, and the rename does not get to override it.
  The user-visible name changed; the identity did not.
- **The server's cookie names** were renamed only to match the server; the old
  spellings are still read (see the shim below).
- **Every route, response shape and test assertion.** No endpoint moved, no
  behaviour was re-decided, and no ranker came back.
- **The upstream fork provenance** (`NOTICE`, `docs/PROVENANCE.md`, the LICENSE).
  History is not renamed.
- **The README's link to the server repository** still points at
  `https://git.polarisocial.xyz/hirrolot19/lorehaven`, because that is where the
  project is actually hosted; the forge path has not been renamed and a dead link
  would be a worse outcome than an old name. The README says so in a parenthesis.

## The compatibility shim

**The CSRF cookie.** `darkhold.js` reads `darkhold_csrf` first and falls back to
the pre-rename `lorehaven_csrf`, warning once on the console:

```
[Darkhold] lorehaven_csrf is still present; the instance now sets darkhold_csrf.
The old cookie is read until it expires — sign in again to replace it.
```

A browser that was signed in before the server renamed its cookies still holds the
old one until it expires. Refusing it would turn the rename into "every write 403s
and nothing says why" for a reader who did nothing wrong. The token is read, sent
in `x-csrf-token`, and forgotten, exactly as before — it is never stored or logged.
The current name always wins when both exist, and the old one is not even read.
Covered by `test/darkhold-client.test.mjs`: *the current cookie name wins…* and
*a CSRF token under the pre-rename cookie name is still read…*.

`SESSION_COOKIE` / `LEGACY_SESSION_COOKIE` are exported for the same reason, though
the session cookie itself is `HttpOnly` and is sent by the browser, not read here.

## What an operator must do

1. **Nothing, for an existing install.** The add-on id is unchanged, so Firefox
   upgrades in place and the stored instance URL survives.
2. **Reload the extension** after pulling, so the new `darkhold.js` is the one
   running: `about:debugging` → This Firefox → Reload.
3. **Sign in to the instance once** when convenient. That replaces the old
   `lorehaven_*` cookies and makes the console warning go away.
4. **Scripts and paths**: `/home/alvaro/code-local/rust/lorehaven-companion` is now
   a **symlink** to `darkhold-companion`, so a script that `cd`s to the old path
   still works. Point new scripts at the new path.

## Verification (real output, this machine)

```
$ node --test 'test/*.test.mjs'
ℹ tests 50
ℹ pass 50
ℹ fail 0

$ node -e "const m=require('./manifest.json'); console.log(m.name, m.browser_specific_settings.gecko.id)"
Darkhold Companion lorehaven-companion@lorehaven
```

The extension has no build step and no dependencies, so that is the whole check.

`npm run check` (`tools/check-read-filter.mjs`) is **broken, and was broken before
this rename**: it reads `feed.js`, which the port deleted in `0354737` ("the
ranker, its pipeline and its pages are gone"). It now dies with
`ENOENT: … /feed.js`. Left alone rather than silently repaired — it is a stale
tool from the pre-port layout, not a rename victim, and deciding whether to retarget
or delete it is a separate change.
