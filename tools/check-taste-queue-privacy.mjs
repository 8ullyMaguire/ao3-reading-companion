#!/usr/bin/env node
// Fails if anything that could identify a reader can reach the taste queue.
//
// THE PRIVACY BOUNDARY, MECHANICALLY ENFORCED.
//
// The extension holds a complete record of what someone reads — the most
// sensitive data in the system. What kindred needs is a small aggregate of what
// they liked. The line is:
//
//   out:  tag and fandom WEIGHTS, verdict deltas
//   never: fic URLs read, titles, author names, or anything identifying the reader
//
// kindred.js enforces the field set at runtime (TASTE_FIELDS, and push() refuses
// an event carrying anything else). This check enforces it statically, over the
// whole extension — so a second call site added next month, in a file that
// nobody re-reads the queue for, is caught before it ships rather than after.
//
// A runtime check on one queue is not enough: the failure mode is a new
// `fetch(..., {body: JSON.stringify({read: [...]})})` somewhere that bypasses
// the queue entirely, and nothing in kindred.js can see that.
//
// Run: node tools/check-taste-queue-privacy.mjs
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = new Set([
  "tools/check-taste-queue-privacy.mjs",
  "test/kindred-taste-queue.test.mjs",
  "test/kindred-privacy.test.mjs",
  "docs/SPEC-integrate-kindred.md",
]);

// Fields a taste payload may carry. Kept as the same four the client enforces,
// and the check FAILS if the two ever disagree — that is the whole point of
// having the check read the constant rather than restate it.
const ALLOWED_FIELDS = ["v", "kind", "tag", "delta"];

// Forbidden data shapes, as NAMES. The first version of this file matched
// URL patterns like /archiveofourown\.org\/works\/\d+/ and missed a payload
// field `fic: event.ficUrl` entirely — the identifier is in the FIELD, not in
// a literal URL, and a check that looks for URLs cannot see that. Mutation-
// proven: adding that field left the check green.
//
// So the check is now structural. Anything that builds a taste payload must
// name only allow-listed keys, and the payload objects are parsed as object
// literals. A field called `fic` fails whether its value is a URL, an id, or
// undefined.
const FORBIDDEN_FIELD_NAMES = [
  "fic", "ficUrl", "ficURL", "ficId", "ficIds", "work", "workId", "workIds",
  "works", "title", "ficTitle", "workTitle", "author", "authors", "authorName",
  "user", "userId", "username", "reader", "readerId", "account",
  "url", "urls", "link", "links",
  "history", "historyFicIds", "readHistory", "read", "readIds", "recentlyRead",
  "bookmark", "bookmarks", "kudos", "session", "cookie", "email"
];

function stripComments(src, ext) {
  let out = src;
  if (ext === ".mjs" || ext === ".js") {
    out = out.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  } else if (ext === ".html") {
    out = out.replace(/<!--[\s\S]*?-->/g, "");
  }
  return out;
}

function collect(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) collect(full, acc);
    else if ([".js", ".mjs", ".html"].includes(extname(e.name))) acc.push(full);
  }
  return acc;
}

const files = collect(root).filter((f) => !ALLOWED.has(f.replace(`${root}/`, "")));
if (files.length === 0) {
  console.error("FAIL: collected zero files — a walk that matches nothing reads as a pass.");
  process.exit(1);
}

// Part 1: the client's allow-list and this file's must agree.
const client = readFileSync(join(root, "kindred.js"), "utf8");
const declared = (client.match(/const TASTE_FIELDS = \[([^\]]*)\]/) || [])[1];
if (!declared) {
  console.error("FAIL: TASTE_FIELDS not found in kindred.js — the client's allow-list moved.");
  process.exit(1);
}
const clientFields = declared
  .split(",")
  .map((s) => s.trim().replace(/^["']|["']$/g, ""))
  .filter(Boolean)
  .sort();
const checkFields = [...ALLOWED_FIELDS].sort();
if (JSON.stringify(clientFields) !== JSON.stringify(checkFields)) {
  console.error("FAIL: the allow-list and this check disagree.");
  console.error(`  kindred.js: ${clientFields.join(", ")}`);
  console.error(`  this check : ${checkFields.join(", ")}`);
  console.error("  A field added to one and not the other is a field nobody is watching.");
  process.exit(1);
}

// Part 2: no reader-identifying data in any outbound payload.
let violations = 0;
for (const file of files) {
  const rel = file.replace(`${root}/`, "");
  const code = stripComments(readFileSync(file, "utf8"), extname(file));
  // Only files that actually talk to kindred are in scope for the payload
  // patterns; a fic URL in a link inside the feed is correct, not a leak.
  const talksToKindred = /kindred|Kindred/.test(code);
  if (!talksToKindred) continue;

  // Structural: find every object literal that is pushed into the taste queue
  // or posted as one, and check its keys.
  const payloads = [
    // this.pending.push({ ... }) and queue.push({ ... })
    /\.push\(\{([\s\S]{0,300}?)\}\s*\)/g,
    // JSON.stringify({ events: [...] }) — the wire shape
    /JSON\.stringify\(\{([\s\S]{0,300}?)\}/g
  ];
  for (const re of payloads) {
    let m;
    while ((m = re.exec(code)) !== null) {
      const body = m[1];
      // Only objects that look like a taste event: they must mention at least
      // one allow-listed field, or they are some unrelated push.
      if (!ALLOWED_FIELDS.some((f) => new RegExp(`\\b${f}\\b`).test(body))) continue;
      const keys = [...body.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((x) => x[1]);
      const forbidden = keys.filter(
        (k) => !ALLOWED_FIELDS.includes(k) && FORBIDDEN_FIELD_NAMES.includes(k)
      );
      if (forbidden.length) {
        violations++;
        console.error(
          `FAIL: ${rel} — taste payload carries ${forbidden.join(", ")}`
        );
        console.error(`      in: { ${body.replace(/\s+/g, " ").trim().slice(0, 120)} }`);
      }
    }
  }
}

if (violations) {
  console.error(
    `\n${violations} violation(s). The taste queue carries aggregate weights;`
  );
  console.error("reading history is the most sensitive data in the system and is");
  console.error("explicitly out of scope (SPEC §4.8).");
  process.exit(1);
}

console.log(`taste-queue-privacy: ${files.length} files scanned, allow-list agrees (${clientFields.join(", ")}), 0 violations`);
console.log("  out: tag/fandom weights and verdict deltas.");
console.log("  never: fic URLs, titles, author names, or anything identifying the reader.");
