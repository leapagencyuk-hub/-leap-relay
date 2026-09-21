// Retrieval: the passages Andy is allowed to answer from.
//
// Keyword and vector results are combined with reciprocal rank fusion rather
// than by adding their scores. BM25 scores and cosine similarities are not on
// the same scale and never will be — one is unbounded and corpus-dependent, the
// other sits in [-1, 1] — so any weighted sum needs a normalisation constant
// that has to be retuned every time the corpus changes. RRF only reads the
// ranks, so it needs no tuning and cannot be thrown off by one index producing
// unusually large numbers for an unusual query.
import fs from 'node:fs';
import path from 'node:path';
import { Corpus } from './store.mjs';
import { KeywordIndex } from './keyword.mjs';
import { VectorIndex } from './vectors.mjs';
import { Embedder } from './embed.mjs';
import { indexableText } from './sync.mjs';

export class Knowledge {
  constructor(config) {
    this.config = config;
    this.corpus = new Corpus(config.dataDir);
    this.embedder = new Embedder(config.embeddings);
    this.loaded = null;
  }

  /**
   * Load the index into memory, once.
   *
   * `loadedAt` is checked against the index file's mtime on every search, so a
   * sync that finishes while the server is up is picked up on the next question
   * instead of needing a restart.
   */
  load({ force = false } = {}) {
    const stamp = fs.existsSync(this.corpus.metaPath) ? fs.statSync(this.corpus.metaPath).mtimeMs : 0;
    if (!force && this.loaded && this.loaded.stamp === stamp) return this.loaded;

    const chunks = this.corpus.readChunks();
    const keywordPath = path.join(this.corpus.root, 'keyword.json');
    const keyword = fs.existsSync(keywordPath)
      ? new KeywordIndex(JSON.parse(fs.readFileSync(keywordPath, 'utf8')))
      : KeywordIndex.build(chunks.map(indexableText));

    let vectors = null;
    try {
      const packed = this.corpus.readVectors();
      if (packed) vectors = new VectorIndex(packed);
    } catch {
      // A corrupt or stale vector file must not take the whole bot down; the
      // keyword index alone still answers, and `status` reports the shortfall.
      vectors = null;
    }
    // A vector file that does not line up with the chunks is from a previous
    // corpus. Ranking against it would return confidently wrong passages.
    if (vectors && vectors.size !== chunks.length) vectors = null;

    this.loaded = { stamp, chunks, keyword, vectors, meta: this.corpus.readMeta() };
    return this.loaded;
  }

  get ready() { return this.load().chunks.length > 0; }

  /**
   * Search the corpus.
   *
   * @returns {Promise<Array<{chunk, score, from}>>} best first.
   */
  async search(query, { limit = null, folder = null } = {}) {
    const { chunks, keyword, vectors } = this.load();
    if (!chunks.length) return [];

    const settings = this.config.retrieval ?? {};
    const candidates = settings.candidates ?? 60;
    const take = limit ?? settings.passages ?? 18;
    const k = settings.rrfK ?? 60;

    const keywordHits = keyword.search(query, candidates);

    let vectorHits = [];
    if (vectors && this.embedder.enabled) {
      try {
        vectorHits = vectors.search(await this.embedder.embedOne(query, 'query'), candidates);
      } catch (err) {
        // An embeddings outage degrades the answer; it must not prevent one.
        vectorHits = [];
        this.lastVectorError = err.message;
      }
    }

    const fused = new Map();
    const fuse = (hits, from) => {
      hits.forEach((hit, rank) => {
        const entry = fused.get(hit.id) ?? { id: hit.id, score: 0, from: [] };
        entry.score += 1 / (k + rank + 1);
        entry.from.push(from);
        fused.set(hit.id, entry);
      });
    };
    fuse(keywordHits, 'keyword');
    fuse(vectorHits, 'meaning');

    let ranked = [...fused.values()].sort((a, b) => b.score - a.score);

    if (folder) {
      const wanted = String(folder).toLowerCase();
      ranked = ranked.filter((r) => (chunks[r.id]?.folder ?? '').toLowerCase().includes(wanted));
    }

    return ranked
      .slice(0, take)
      .map((r) => ({ chunk: chunks[r.id], score: r.score, from: r.from }))
      .filter((r) => r.chunk);
  }

  /** What the admin page and `/andy status` report. */
  status() {
    const { chunks, vectors, meta } = this.load();
    const documents = Object.values(this.corpus.readDocuments());
    return {
      ...meta,
      chunks: chunks.length,
      documents: documents.filter((d) => !d.error).length,
      failed: documents.filter((d) => d.error).map((d) => ({ name: d.name, error: d.error })),
      retrieval: vectors && this.embedder.enabled ? 'hybrid (meaning + keyword)' : 'keyword only',
      embeddings: this.embedder.label,
      // null rather than false when embeddings are off: there is nothing to
      // match, which is a setting, not the stale-index fault this flag warns of.
      vectorsMatchChunks: this.embedder.enabled ? Boolean(vectors) && vectors.size === chunks.length : null,
    };
  }
}

/**
 * Lay passages out for the model.
 *
 * Every passage is numbered, and the number is what Andy cites. Keeping the
 * source on the same line as the number means a citation can be checked without
 * the model having to repeat the file name, which it gets wrong far more often
 * than it gets a number wrong.
 */
export function renderPassages(results) {
  if (!results.length) return 'Nothing in the library matches that.';
  return results.map(({ chunk }) => {
    const where = [chunk.title, chunk.heading, chunk.page > 1 ? `page ${chunk.page}` : null]
      .filter(Boolean).join(' · ');
    return `[#${chunk.id}] ${where}\n${chunk.text}`;
  }).join('\n\n---\n\n');
}
