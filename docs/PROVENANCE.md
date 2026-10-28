# Provenance

| | |
|---|---|
| Upstream | `https://github.com/8ullyMaguire/ao3-reading-companion` |
| Forked from | `8753a64` |
| Licence | MIT — `LICENSE` is upstream's file, byte-for-byte |
| Copyright | `(c) 2026 DisastrousClass` (upstream's line; the repository owner is `8ullyMaguire`) |
| Contract | `darkhold/docs/spec.md` §48 — this extension implements it and does not re-decide it |
| Plan | `docs/PLAN.md` (commit `442598c`) |

Verified 2026-10-15:

```sh
git diff --stat upstream/main main      # no output: the tree IS upstream @ 8753a64 + docs/
grep -c DisastrousClass LICENSE NOTICE  # 2
```

The copyright line and the repository owner are different names. That is upstream's
state, not ours to resolve, and both are credited rather than normalised to one.
Confirming it is a precondition of *release*, not of development: the code is MIT
either way.
