// BM25 keyword search.
//
// This is not a fallback for when embeddings are off — it earns its place next
// to them. Vectors are good at meaning and bad at exact strings, and this
// corpus is full of exact strings that matter: gift names, "200k", "Fan Club",
// "diamonds per hour", a campaign's name. A creator asking about Pink Drift
// wants the page that says Pink Drift, not the page about expensive gifts in
// general. Both indexes run on every query and their ranks are fused.

const STOPWORDS = new Set(`a an and are as at be but by for from has have how i if in into is it its of on or
that the their then there these they this to was what when where which who will with you your do does did can
could should would about above after again all also am any because been before being below between both each
few further here him his more most not now only other our out over own same so some such than too under until
up very we were while why`.split(/\s+/));

/**
 * Split text the way a search query is split.
 *
 * Numbers are kept — "200k", "1000", "90" are some of the most meaningful
 * tokens in this corpus. `200k` also yields `200` so a question about "200,000
 * diamonds" reaches a document that writes it as 200k.
 */
export function tokenise(text) {
  const out = [];
  const raw = String(text ?? '').toLowerCase().replace(/[’']/g, '').match(/[a-z0-9]+(?:\.[a-z0-9]+)*/g) ?? [];
  for (const token of raw) {
    if (token.length < 2 || STOPWORDS.has(token)) continue;
    out.push(token);
    const numeric = token.match(/^(\d+)k$/);
    if (numeric) out.push(numeric[1], `${numeric[1]}000`);
  }
  return out;
}

export class KeywordIndex {
  /** @param {{postings: Record<string, number[][]>, lengths: number[], avgLength: number}} state */
  constructor(state = null) {
    this.postings = state?.postings ?? {};
    this.lengths = state?.lengths ?? [];
    this.avgLength = state?.avgLength ?? 0;
    this.k1 = 1.4;
    this.b = 0.75;
  }

  get size() { return this.lengths.length; }

  static build(documents) {
    const postings = new Map();
    const lengths = new Array(documents.length);

    for (let id = 0; id < documents.length; id++) {
      const tokens = tokenise(documents[id]);
      lengths[id] = tokens.length;
      const counts = new Map();
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
      for (const [token, count] of counts) {
        let list = postings.get(token);
        if (!list) postings.set(token, list = []);
        list.push([id, count]);
      }
    }

    const total = lengths.reduce((sum, n) => sum + n, 0);
    return new KeywordIndex({
      postings: Object.fromEntries(postings),
      lengths,
      avgLength: documents.length ? total / documents.length : 0,
    });
  }

  toJSON() { return { postings: this.postings, lengths: this.lengths, avgLength: this.avgLength }; }

  search(query, k = 60) {
    const terms = tokenise(query);
    if (!terms.length || !this.size) return [];

    const scores = new Map();
    const seen = new Set();
    for (const term of terms) {
      if (seen.has(term)) continue;   // a repeated word is not twice as important
      seen.add(term);
      const list = this.postings[term];
      if (!list) continue;
      // Standard BM25 idf, with the +1 that keeps a term appearing in more than
      // half the corpus from scoring negative.
      const idf = Math.log(1 + (this.size - list.length + 0.5) / (list.length + 0.5));
      for (const [id, frequency] of list) {
        const norm = this.avgLength > 0 ? this.lengths[id] / this.avgLength : 1;
        const weight = (frequency * (this.k1 + 1)) / (frequency + this.k1 * (1 - this.b + this.b * norm));
        scores.set(id, (scores.get(id) ?? 0) + idf * weight);
      }
    }

    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

export { STOPWORDS };
