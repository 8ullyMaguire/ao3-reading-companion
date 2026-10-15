import { test } from 'node:test';
import assert from 'node:assert/strict';
import feedModel from '../feed-model.js';

const { buildFeed, ficFrom, reasonFrom, readSetFromHistory, MISSING_SERVER_FIELDS } = feedModel;

const discovery = (ids) => ({
  items: ids.map((id, i) => ({ work_id: id, slot_id: `slot-${id}`, position: i })),
  sort: 'for_you',
  request_id: 'req-1',
});

// A work as GET /api/v1/works/{id} returns it (PublicWorkView, routes/works.rs:236).
const work = (id, over = {}) => ({
  id, title: `Work ${id}`, summary: 'a summary', language: 'en', rating: 'teen',
  visibility: 'public', completion: 'complete', published_at: '2026-01-01T00:00:00Z',
  show_public_ratings: true, discussion_mode: 'both', rating_summary: null,
  metrics: { views: 12, complete_reads: 3, reactions: 1, kudos: 7, bookmarks: 2, collection_adds: 0, reviews: 1 },
  authors: [{ handle: 'writer' }], chapters: [{ word_count: 1000 }, { word_count: 500 }],
  rec_blurb: null, ...over,
});

test('the server order is preserved even when the works themselves would sort differently (§48.2)', () => {
  // The works' own numbers disagree with the order the server sent, on every axis a local
  // ranker might reach for. The model must not touch the order.
  const worksById = { c: work('c', { metrics: { kudos: 1, views: 1 } }), b: work('b', { metrics: { kudos: 99999, views: 99999 } }), a: work('a', { title: 'zzz' }) };
  const model = buildFeed({ discovery: discovery(['c', 'b', 'a']), worksById });
  assert.deepEqual(model.items.map((i) => i.workId), ['c', 'b', 'a']);
});

test('a work whose details could not be loaded keeps its place — dropped or moved is re-ranking', () => {
  const model = buildFeed({ discovery: discovery(['a', 'b', 'c']), worksById: { b: work('b') } });
  assert.deepEqual(model.items.map((i) => i.workId), ['a', 'b', 'c']);
  assert.equal(model.items[0].fic, null);
  assert.equal(model.items[1].fic.title, 'Work b');
});

test('an unreadable explanation is an absence, and no line is invented in its place', () => {
  const model = buildFeed({ discovery: discovery(['a']), worksById: { a: work('a') } });
  assert.equal(model.items[0].reason.available, false);
  assert.deepEqual(model.items[0].reason.lines, []);
  assert.equal(model.items[0].reason.blendScore, null);
});

test("the server's reason lines are passed through verbatim, never reworded", () => {
  const explanation = {
    slot_id: 'slot-a', work_id: 'a', position: 0,
    reasons: [{ kind: 'taste', text: 'Because you liked slow-burn rivals-to-lovers' }, { label: 'fresh chapter' }],
    taste_signal: { strength: 0.8 }, seeded_by: 'arena comparison 41', recipe_stage: 'rrf-blend',
    instance_curation: 'editor pick: winter fests', blend_score: 4207, served_at: '2026-10-15T20:01:02Z',
  };
  const r = reasonFrom(explanation);
  assert.equal(r.available, true);
  assert.deepEqual(r.lines, ['Because you liked slow-burn rivals-to-lovers', 'fresh chapter', 'editor pick: winter fests']);
  assert.equal(r.blendScore, 4207);
  assert.equal(r.servedAt, '2026-10-15T20:01:02Z');
  assert.equal(r.seededBy, 'arena comparison 41');
});

test('a slot the server recorded with no reader-side reasons says exactly that', () => {
  const r = reasonFrom({ slot_id: 's', reasons: [], blend_score: 10, served_at: 'x' });
  assert.equal(r.available, true);
  assert.deepEqual(r.lines, []);
});

test('read state comes from the server history, in both shapes it may arrive in', () => {
  assert.deepEqual([...readSetFromHistory([{ work_id: 'a' }, { ficId: 'b' }, { id: 'c' }])], ['a', 'b', 'c']);
  assert.deepEqual([...readSetFromHistory({ items: [{ work_id: 'z' }] })], ['z']);
  assert.deepEqual([...readSetFromHistory(null)], []);
  const model = buildFeed({ discovery: discovery(['a', 'b']), history: [{ work_id: 'b' }] });
  assert.deepEqual(model.items.map((i) => i.read), [false, true]);
});

test('a work with public aggregates switched off reports null kudos, not zero (§9.5)', () => {
  const f = ficFrom(work('a', { metrics: null }), 'a');
  assert.equal(f.kudos, null);
  assert.equal(f.hits, null);
  assert.equal(f.ficId, 'a');
});

test('isComplete is the exact completion value, and nothing is inferred from anything else', () => {
  assert.equal(ficFrom(work('a', { completion: 'complete' }), 'a').isComplete, true);
  assert.equal(ficFrom(work('a', { completion: 'in_progress' }), 'a').isComplete, false);
  assert.equal(ficFrom(work('a', { completion: 'abandoned' }), 'a').isComplete, false);
});

test('the fields the server does not carry are named as missing, and never defaulted onto a card', () => {
  const f = ficFrom(work('a'), 'a');
  for (const k of MISSING_SERVER_FIELDS) {
    assert.equal(f[k], undefined, `${k} must not appear on a card the server cannot fill`);
  }
  assert.deepEqual(MISSING_SERVER_FIELDS.sort(),
    ['characters', 'fandoms', 'freeformTags', 'lastUpdated', 'relationships', 'warnings']);
});

test('word count sums the chapters the server sent, and author comes from authors[0]', () => {
  const f = ficFrom(work('a'), 'a');
  assert.equal(f.wordCount, 1500);
  assert.equal(f.chapters, 2);
  assert.equal(f.author, 'writer');
});

test('a malformed payload yields no card rather than a half-filled one, and never throws', () => {
  assert.equal(ficFrom(null, 'a'), null);
  assert.equal(ficFrom(undefined, 'a'), null);
  const model = buildFeed({ discovery: { items: [null, { work_id: 'a' }] } });
  assert.equal(model.items.length, 2);
  assert.equal(model.items[0].workId, null);
  assert.equal(model.items[0].fic, null);
});

test('an empty or absent discovery is an empty feed, not a crash', () => {
  assert.deepEqual(buildFeed({}).items, []);
  assert.deepEqual(buildFeed({ discovery: { items: [] } }).items, []);
  assert.equal(buildFeed({}).sort, null);
});
