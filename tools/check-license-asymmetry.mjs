#!/usr/bin/env node
// Fails if kindred's code has leaked into the MIT extension.
//
// THE LICENCE CONSTRAINT, MECHANICALLY ENFORCED.
//
//   ao3-reading-companion  MIT   (Copyright (c) 2026 DisastrousClass)
//   kindred                AGPL-3.0
//
// The direction that is fine: this extension, being MIT, may call an AGPL
// service over HTTP. Separate works, at arm's length, no code copied — no
// obligation transfers.
//
// The direction that is not: kindred code pasted INTO this extension would
// infect an MIT work that is a public clone, and the AGPL's network clause
// would reach the service worker too. So the integration is a wire protocol,
// and this file is what stops a well-meaning "why not just import their
// ranking code" from quietly re-licensing the whole extension.
//
// A comment is the wrong mechanism for that. The symbols below are checked
// against CODE, with comments stripped, so a mention in prose is fine and an
// actual implementation is not.
//
// Run: node tools/check-license-asymmetry.mjs
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Symbols that are kindred's implementation, not the wire format. A hit means
// code was copied, not that a field name was matched — the wire names
// (`seeds`, `n`, `items`, `evidence`, `meta.degraded`) are deliberately NOT
// here, because those are the interface and using them is the whole point.
const KINDRED_SYMBOLS = [
  // Ranking internals
  "\\bPMI\\b", "\\bpmiWeighted\\b", "\\bNeighbourhood\\b", "\\btagOverlap\\b",
  "\\bTagOverlap\\b", "\\bpeerRating\\b", "\\bPeerRating\\b", "\\bmaxinfo\\b",
  "\\bMaxInfo\\b", "\\bpersistCSR\\b", "\\bLoadCSR\\b", "\\bStableSalt\\b",
  "\\bOwnerKey\\b", "\\bownerKey\\b", "\\bLearnTags\\b", "\\btagStats\\b",
  // Server-side store tables
  "\\barena_user_blocked_tags\\b", "\\barena_user_ratings\\b",
  // Go-ish types that would only appear if code were ported
  "\\bCandidatePool\\b", "\\bWorksSince\\b", "\\bStore\\) ",
];

// Files that legitimately talk ABOUT the boundary.
const ALLOWED_FILES = new Set([
  "tools/check-license-asymmetry.mjs",
  "tools/check-license-asymmetry.mjs",
  "test/kindred-license.test.mjs",
]);

// Strip comments so prose about the boundary is not a violation.
function stripComments(src, ext) {
  let out = src;
  if (ext === ".mjs" || ext === ".js") {
    out = out
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  } else if (ext === ".html") {
    out = out.replace(/<!--[\s\S]*?-->/g, "");
  }
  return out;
}

function collect(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, acc);
    else if ([".js", ".mjs", ".html"].includes(extname(entry.name))) acc.push(full);
  }
  return acc;
}

const files = collect(root).filter((f) => !ALLOWED_FILES.has(f.replace(`${root}/`, "")));
if (files.length === 0) {
  console.error("FAIL: collected zero files — the walk is wrong, and a walk that");
  console.error("      matches nothing reads as a clean pass.");
  process.exit(1);
}

let violations = 0;
for (const file of files) {
  const rel = file.replace(`${root}/`, "");
  const code = stripComments(readFileSync(file, "utf8"), extname(file));
  const hits = [];
  for (const sym of KINDRED_SYMBOLS) {
    const re = new RegExp(sym, "g");
    const m = code.match(re);
    if (m) hits.push(`${sym} (${m.length}x)`);
  }
  if (hits.length) {
    violations++;
    console.error(`FAIL: ${rel} contains kindred implementation:`);
    for (const h of hits) console.error(`        ${h}`);
  }
}

if (violations) {
  console.error(
    `\n${violations} file(s) carry kindred code into an MIT work.`
  );
  console.error("The integration is a wire protocol on purpose. If you need a");
  console.error("ranking behaviour, call the API — do not port the implementation.");
  process.exit(1);
}

console.log(
  `license-asymmetry: ${files.length} files scanned, ${KINDRED_SYMBOLS.length} kindred symbols, 0 violations`
);
console.log("  MIT extension calling AGPL kindred over HTTP is fine.");
console.log("  The reverse would re-license the extension. This check is the boundary.");
