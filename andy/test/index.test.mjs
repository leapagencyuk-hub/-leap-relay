import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkDocument } from '../lib/chunk.mjs';
import { PAGE_BREAK } from '../lib/text.mjs';
import { KeywordIndex, tokenise } from '../lib/keyword.mjs';
import { quantise, pack, unpack, VectorIndex } from '../lib/vectors.mjs';
import { normalise } from '../lib/embed.mjs';

// --- chunking ----------------------------------------------------------------

test('a chunk carries the whole heading trail above it', () => {
  const doc = '# Fan club\n\n## Growth\n\n### Under 1,000 followers\n\nPin the join link every ten minutes.';
  const [chunk] = chunkDocument(doc, { minChars: 10 });
  assert.equal(chunk.heading, 'Fan club > Growth > Under 1,000 followers');
});

test('a shallower heading closes the deeper ones', () => {
  const doc = '# A\n\n## B\n\nbody one that is long enough to survive the minimum\n\n# C\n\nbody two that is long enough to survive';
  const chunks = chunkDocument(doc, { minChars: 10 });
  assert.equal(chunks[0].heading, 'A > B');
  assert.equal(chunks[1].heading, 'C');
});

test('page numbers follow the page breaks the extractor left', () => {
  const doc = `# One\n\n${'first page body. '.repeat(10)}${PAGE_BREAK}# Two\n\n${'second page body. '.repeat(10)}`;
  const chunks = chunkDocument(doc, { minChars: 10 });
  assert.equal(chunks[0].page, 1);
  assert.equal(chunks.at(-1).page, 2);
});

test('an over-long section splits with overlap, and nothing is lost', () => {
  const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} about gifting.`);
  const chunks = chunkDocument(`# Long\n\n${sentences.join(' ')}`, { targetChars: 400, overlapChars: 80, minChars: 40 });
  assert.ok(chunks.length > 2);
  for (let i = 0; i < 60; i++) {
    assert.ok(chunks.some((c) => c.text.includes(`Sentence number ${i} `)), `sentence ${i} was dropped`);
  }
  const overlapping = chunks.slice(1).some((c, i) => {
    const previousTail = chunks[i].text.slice(-80);
    return previousTail.split(' ').some((word) => word.length > 4 && c.text.startsWith(word));
  });
  assert.ok(overlapping, 'consecutive chunks should share an overlap');
});

test('a stray fragment is folded into its neighbour rather than competing as a chunk', () => {
  const doc = '# Real\n\nThis is a genuine paragraph with enough substance to stand on its own as a passage.\n\n# H\n\n7';
  const chunks = chunkDocument(doc, { minChars: 40 });
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].text.endsWith('7'));
});

test('an empty document produces no chunks rather than one empty one', () => {
  assert.deepEqual(chunkDocument(''), []);
  assert.deepEqual(chunkDocument('   \n\n  '), []);
});

test('a sentence longer than a whole chunk is still cut, not dropped', () => {
  const wall = `# T\n\n${'a'.repeat(5000)}`;
  const chunks = chunkDocument(wall, { targetChars: 500, overlapChars: 0, minChars: 10 });
  assert.ok(chunks.length >= 10);
  assert.ok(chunks.every((c) => c.text.length <= 600));
});

// --- keyword index -----------------------------------------------------------

test('numbers written as 200k also match 200,000', () => {
  const tokens = tokenise('the 200k target');
  assert.ok(tokens.includes('200k'));
  assert.ok(tokens.includes('200000'));
});

test('stopwords and single characters are dropped', () => {
  assert.deepEqual(tokenise('the a of I go live'), ['go', 'live']);
});

test('BM25 ranks the document that is actually about the query first', () => {
  const index = KeywordIndex.build([
    'Pink Drift is worth 3600 diamonds and comes from fan club regulars.',
    'Set a visible goal at the top of every stream.',
    'Fan club members drift away when a creator misses their usual days.',
  ]);
  assert.equal(index.search('pink drift diamonds', 1)[0].id, 0);
  assert.equal(index.search('why do fan club members leave', 1)[0].id, 2);
});

test('a query with no known terms returns nothing rather than everything', () => {
  const index = KeywordIndex.build(['one', 'two']);
  assert.deepEqual(index.search('zzzzzz qqqqqq'), []);
});

test('a repeated query word does not count twice', () => {
  const index = KeywordIndex.build(['gifting gifting gifting', 'gifting schedules']);
  const once = index.search('gifting', 2);
  const twice = index.search('gifting gifting', 2);
  assert.deepEqual(once.map((h) => h.score), twice.map((h) => h.score));
});

test('an index survives a round trip through JSON', () => {
  const built = KeywordIndex.build(['gifting goals', 'schedule slippage']);
  const restored = new KeywordIndex(JSON.parse(JSON.stringify(built.toJSON())));
  assert.deepEqual(restored.search('gifting', 1), built.search('gifting', 1));
});

// --- vector index ------------------------------------------------------------

const randomVectors = (count, dim, seed = 1) => {
  let state = seed;
  const next = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648 - 0.5; };
  return Array.from({ length: count }, () => normalise(Float32Array.from({ length: dim }, next)));
};

test('a vector survives quantisation well enough to rank identically', () => {
  const rows = randomVectors(200, 128);
  const index = new VectorIndex(pack(quantise(rows, 128)));
  for (const target of [0, 77, 199]) {
    assert.equal(index.search(rows[target], 1)[0].id, target, `row ${target} did not retrieve itself`);
  }
});

test('quantisation error stays far below anything that changes a ranking', () => {
  const rows = randomVectors(50, 64);
  const index = new VectorIndex(pack(quantise(rows, 64)));
  const [hit] = index.search(rows[10], 1);
  let exact = 0;
  for (let i = 0; i < 64; i++) exact += rows[10][i] * rows[10][i];
  assert.ok(Math.abs(exact - hit.score) < 0.01, `error was ${Math.abs(exact - hit.score)}`);
});

test('the packed file round-trips exactly', () => {
  const rows = randomVectors(12, 32);
  const { count, dim } = unpack(pack(quantise(rows, 32)));
  assert.equal(count, 12);
  assert.equal(dim, 32);
});

test('a truncated or foreign file is refused, not half-read', () => {
  const packed = pack(quantise(randomVectors(5, 16), 16));
  assert.throws(() => unpack(packed.subarray(0, packed.length - 4)), /expected/);
  assert.throws(() => unpack(Buffer.from('not an index at all!!')), /not an Andy index/);
});

test('a query of the wrong width is refused rather than scored against noise', () => {
  const index = new VectorIndex(pack(quantise(randomVectors(4, 16), 16)));
  assert.throws(() => index.search(new Float32Array(8), 1), /reindexing/);
});

test('an empty index returns nothing instead of throwing', () => {
  assert.deepEqual(new VectorIndex(null).search(new Float32Array(4), 5), []);
});

test('a vector of all zeros does not produce NaN scores', () => {
  const rows = [normalise(new Float32Array(16)), ...randomVectors(3, 16)];
  const index = new VectorIndex(pack(quantise(rows, 16)));
  for (const hit of index.search(rows[1], 4)) assert.ok(Number.isFinite(hit.score), 'a score was not finite');
});
