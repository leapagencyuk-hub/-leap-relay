// Embeddings.
//
// Anthropic does not serve an embeddings endpoint, so this is the one place
// Andy talks to somebody else. Voyage is the default because it is the provider
// Anthropic points at and the whole corpus costs pennies to embed once.
//
// The important property is that this is optional. With `provider: "none"`, or
// with no key set, Andy still answers — retrieval falls back to keyword search
// alone. That is measurably worse at paraphrased questions ("the room is dead"
// vs "low engagement"), and the admin page says so rather than looking healthy.

const ENDPOINTS = {
  voyage: {
    url: 'https://api.voyageai.com/v1/embeddings',
    body: (texts, model, dim, kind) => ({
      input: texts,
      model,
      input_type: kind === 'query' ? 'query' : 'document',
      output_dimension: dim,
      truncation: true,
    }),
    read: (json) => json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding),
  },
  openai: {
    url: 'https://api.openai.com/v1/embeddings',
    body: (texts, model, dim) => ({ input: texts, model, ...(dim ? { dimensions: dim } : {}) }),
    read: (json) => json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding),
  },
};

export class Embedder {
  constructor(settings = {}) {
    this.provider = settings.provider ?? 'none';
    this.model = settings.model ?? null;
    this.dimensions = settings.dimensions ?? null;
    this.apiKey = settings.apiKey ?? null;
    this.batchSize = settings.batchSize ?? 96;
  }

  /** False when Andy has to fall back to keyword-only retrieval. */
  get enabled() { return this.provider !== 'none' && Boolean(this.apiKey) && Boolean(ENDPOINTS[this.provider]); }

  get label() { return this.enabled ? `${this.provider}/${this.model}` : 'off (keyword-only)'; }

  /**
   * Embed a list of texts. Returns unit-length Float32Arrays, so a dot product
   * is cosine similarity and the index never has to normalise again.
   */
  async embed(texts, { kind = 'document', onProgress = null } = {}) {
    if (!this.enabled) throw new Error('embeddings are not configured');
    const out = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const vectors = await this.callWithRetry(batch, kind);
      for (const v of vectors) out.push(normalise(v));
      onProgress?.(Math.min(i + batch.length, texts.length), texts.length);
    }
    return out;
  }

  async embedOne(text, kind = 'query') {
    const [vector] = await this.embed([text], { kind });
    return vector;
  }

  async callWithRetry(texts, kind, retries = 4) {
    const spec = ENDPOINTS[this.provider];
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(spec.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(spec.body(texts, this.model, this.dimensions, kind)),
          signal: AbortSignal.timeout(90000),
        });
        if (res.status === 429 || res.status >= 500) {
          // Embedding a whole corpus will hit the rate limit; that is expected
          // and is a reason to wait, not a reason to fail the sync.
          const wait = Number(res.headers.get('retry-after')) * 1000 || Math.min(2000 * 2 ** attempt, 60000);
          lastError = `HTTP ${res.status}`;
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const vectors = spec.read(await res.json());
        if (vectors.length !== texts.length) {
          throw new Error(`embeddings returned ${vectors.length} vectors for ${texts.length} inputs`);
        }
        return vectors;
      } catch (err) {
        lastError = err.message;
        if (attempt === retries) break;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    throw new Error(`embeddings failed: ${lastError}`);
  }
}

export function normalise(values) {
  const vector = Float32Array.from(values);
  let sum = 0;
  for (const v of vector) sum += v * v;
  const length = Math.sqrt(sum);
  if (length > 0) for (let i = 0; i < vector.length; i++) vector[i] /= length;
  return vector;
}
