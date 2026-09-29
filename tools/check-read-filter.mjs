#!/usr/bin/env node
// node tools/check-read-filter.mjs
//
//   node tools/check-read-filter.mjs   — drift check (fast)
//   VERIFY=1 node tools/check-read-filter.mjs
//
// VERIFY=1 additionally MUTATES feed.js and confirms something fails, because
// that is the only honest way to know the safety net works. Measured on this
// suite: all four mutations below are caught by this check and by NOTHING else
// — test/read-filter.test.mjs passes 7/7 against every one of them, since it
// tests a copy and the copy is unchanged. The tests pin the logic; this file
// is what makes the tests mean anything.
//
// If you ever find yourself adding a test case and nothing fails, that is the
// signal this file exists to prevent.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const feed = await readFile(join(root, "feed.js"), "utf8");
const test = await readFile(join(root, "test", "read-filter.test.mjs"), "utf8");

// The exact source that must appear in both files. Compared as two separate
// blocks rather than one, because feed.js carries a comment between the
// declaration and the function — and a check that fails on a comment is a
// check that gets deleted.
const DECL = 'const READ_EXEMPT_ROW_TYPES = new Set(["fresh_chapters"]);';

const FN = [
  "function excludeReadItems(scoredItems, ctx, rowType) {",
  "  if (READ_EXEMPT_ROW_TYPES.has(rowType)) return scoredItems;",
  "  if (!ctx || !ctx.historyFicIds || ctx.historyFicIds.size === 0) return scoredItems;",
  "  return scoredItems.filter(it => !ctx.historyFicIds.has(it.fic.ficId));",
  "}",
].join("\n");

const problems = [];

for (const [label, block] of [["declaration", DECL], ["function", FN]]) {
  if (!feed.includes(block)) {
    problems.push(
      `feed.js no longer contains the canonical ${label}.\n` +
        "  If you changed the filter, update the matching block in this file and\n" +
        "  the copy in test/read-filter.test.mjs, then re-run the tests."
    );
  }
  if (!test.includes(block)) {
    problems.push(
      `test/read-filter.test.mjs no longer contains the canonical ${label} copy.\n` +
        "  The test would be exercising logic that no longer exists in feed.js."
    );
  }
}

// The call site is the part that makes the filter actually run. A correct
// function that nothing calls is a function that does nothing.
const CALL_SITE = "def.buildResult(excludeReadItems(scored, ctx, def.rowType), ctx);";
if (!feed.includes(CALL_SITE)) {
  problems.push(
    "feed.js no longer filters at the buildResult call site.\n" +
      "  The function still exists but may be called nowhere, which is a fix\n" +
      "  that changes no behaviour."
  );
}

if (problems.length) {
  console.error("read-filter drift:\n");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}

const sha = createHash("sha256").update(DECL + "\n" + FN).digest("hex").slice(0, 12);
console.log(`read-filter: feed.js and the test agree (sha256:${sha})`);

// --- optional: prove the safety net actually catches something -------------
if (process.env.VERIFY !== "1") process.exit(0);

const FEED_PATH = join(root, "feed.js");
const good = await readFile(FEED_PATH, "utf8");

const MUTATIONS = [
  {
    name: "call site removed — the filter never runs",
    from: CALL_SITE,
    to: "def.buildResult(scored, ctx);",
  },
  {
    name: "filter inverted — keeps only read fics",
    from: "  return scoredItems.filter(it => !ctx.historyFicIds.has(it.fic.ficId));",
    to: "  return scoredItems.filter(it => ctx.historyFicIds.has(it.fic.ficId));",
  },
  {
    name: "fresh_chapters exemption removed",
    from: DECL,
    to: 'const READ_EXEMPT_ROW_TYPES = new Set();',
  },
  {
    name: "empty-history early return removed",
    from: "  if (!ctx || !ctx.historyFicIds || ctx.historyFicIds.size === 0) return scoredItems;\n",
    to: "",
  },
];

// Restore in `finally`, in THIS process. A restore in a caller orphans the
// mutation if the caller dies — which is how a broken experiment becomes a
// broken repo that looks like a passing test run.
let survived = 0;
try {
  console.log("\nmutations (each must be caught):");
  for (const m of MUTATIONS) {
    if (!good.includes(m.from)) {
      console.error(`  SKIPPED  ${m.name} — anchor not found in current feed.js`);
      survived++;
      continue;
    }
    await writeFile(FEED_PATH, good.replace(m.from, m.to));

    // encoding: "utf8" — without it spawnSync hands back a Buffer, and
    // Buffer.match is not a function. Thrown as a bare TypeError halfway
    // through the mutation loop, which is the least useful place to find out.
    const sync = spawnSync(process.execPath, [join(here, "check-read-filter.mjs")], {
      cwd: root, encoding: "utf8",
    });
    const tst = spawnSync(process.execPath, ["--test", "test/read-filter.test.mjs"], {
      cwd: root, encoding: "utf8",
    });
    const failed = (tst.stdout || "").match(/\d+ failing|✖/g) || [];
    const caught = sync.status !== 0 || failed.length > 0;
    if (!caught) survived++;
    console.log(
      `  ${caught ? "caught  " : "SURVIVED"} ${m.name}` +
        `  (sync=${sync.status}, tests=${failed.length ? "fail" : "pass"})`
    );
  }
} finally {
  await writeFile(FEED_PATH, good);
}

if (survived) {
  console.error(`\n${survived} mutation(s) survived — the safety net does not work.`);
  process.exit(1);
}
console.log(`\nall ${MUTATIONS.length} mutations caught; feed.js restored`);
