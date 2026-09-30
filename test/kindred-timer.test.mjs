// test/kindred-timer.test.mjs
//
// The timeout timer must be cleared on EVERY path.
//
// Mutation-proven, and the mutation is not subtle: removing `clearTimeout(timer)`
// from the `finally` block left the whole suite green. It is invisible to a unit
// test because the test process is not held by the timer — node's test runner
// exits its own way — so nothing in the client tests noticed.
//
// The leak is still real and observable, which is why this file exists as a
// SUBPROCESS test rather than another in-process assertion. Measured: with the
// timer cleared, a script that makes one failing call exits immediately. With
// it removed, the same script hangs until the 30s deadline, because a pending
// timer is a live handle and node does not exit while one exists.
//
// In the extension this is the same defect with a worse consequence: a service
// worker with a pending 30s timer is held awake, so a feed build that falls back
// to local ranking — the common case, since the user's kindred is often not
// running — leaves a timer behind on every single build.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Run a snippet in a fresh node process and report how long it took.
//
// The real timeout is 30s, and the test budget here is 6s: if the process is
// still alive at 6s, the timer was leaked, because a correct run exits in
// well under a second. Using the real 30s value means the test does not pass by
// having shrunk the deadline to something trivially small.
const BUDGET_MS = 6_000;

function runSnippet(body) {
  const dir = mkdtempSync(join(tmpdir(), "kindred-timer-"));
  try {
    const file = join(dir, "probe.mjs");
    writeFileSync(
      file,
      `import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(join(root, "kindred.js"))});
const K = require(${JSON.stringify(join(root, "kindred.js"))});
${body}
console.log("done");
`
    );
    const started = Date.now();
    const r = spawnSync(process.execPath, [file], {
      timeout: BUDGET_MS,
      encoding: "utf8",
      killSignal: "SIGKILL"
    });
    return { ms: Date.now() - started, stdout: r.stdout || "", signal: r.signal, error: r.error };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FAILING_CALL = `await K.fetchRecommendations("http://127.0.0.1:8010", ["s"], 20, {
  fetch: async () => { throw new TypeError("Failed to fetch"); }
});`;

test("a failing call does not leave a pending timer holding the process open", () => {
  const r = runSnippet(FAILING_CALL);
  assert.ok(
    !r.error && !r.signal,
    `the process was killed after ${BUDGET_MS}ms (${r.signal || r.error}) — ` +
      `a pending timer is a live handle, so clearTimeout is missing from the ` +
      `client's finally block`
  );
  assert.ok(r.ms < BUDGET_MS / 2, `took ${r.ms}ms, expected well under ${BUDGET_MS / 2}ms`);
  assert.match(r.stdout, /done/, "the call should have completed");
});

test("the same holds for the timeout path, where the timer has already fired", () => {
  // Different path: the abort fires, so the timer is due to fire anyway. It
  // must still be cleared, or a timeout leaves the handle alive for the
  // remainder of its 30s.
  const r = runSnippet(`await K.fetchRecommendations("http://127.0.0.1:8010", ["s"], 20, {
  timeoutMs: 50,
  fetch: (url, init) => new Promise((_res, rej) => {
    init.signal.addEventListener("abort", () => {
      const e = new Error("aborted"); e.name = "AbortError"; rej(e);
    });
  })
});`);
  assert.ok(!r.error && !r.signal, `the timeout path hung (${r.signal || r.error})`);
  assert.ok(r.ms < BUDGET_MS / 2, `took ${r.ms}ms`);
});

test("and for the success path, which is the one that runs most often", () => {
  // The success path returns before the timer is due, so it is the case most
  // likely to leak in ordinary use: a healthy kindred, a call that returns in
  // 40ms, and a 30s timer left behind.
  const r = runSnippet(`await K.fetchRecommendations("http://127.0.0.1:8010", ["s"], 20, {
  fetch: async () => ({
    ok: true, status: 200,
    json: async () => ({ items: [{ id: "1", title: "t" }], meta: { degraded: [] } })
  })
});`);
  assert.ok(!r.error && !r.signal, `the success path hung (${r.signal || r.error})`);
  assert.ok(r.ms < BUDGET_MS / 2, `took ${r.ms}ms`);
});

test("a TasteQueue flush does not hold the process open either", () => {
  // The queue is on the same timer discipline, and a failed flush retries on a
  // timer in the extension. This asserts the happy path is clean.
  const r = runSnippet(`const q = new K.TasteQueue({ post: async () => {} });
q.push({ kind: "taste", tag: "slow burn", delta: 0.4 });
await q.flush();`);
  assert.ok(!r.error && !r.signal, `the queue path hung (${r.signal || r.error})`);
  assert.ok(r.ms < BUDGET_MS / 2, `took ${r.ms}ms`);
});
