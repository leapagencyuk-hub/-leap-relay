// The vector index: one flat file, scanned in full on every query.
//
// No database, no native module, no second service. At this corpus size that is
// not a compromise — a few hundred documents is tens of thousands of chunks,
// and scanning tens of thousands of rows takes single-digit milliseconds. An
// approximate index would add a build step, a native dependency and a tuning
// parameter to save time Andy does not spend.
//
// Vectors are stored as int8 rather than float32. Unit-length embeddings live
// in [-1, 1], so one byte per dimension holds them to about three decimal
// places — the ranking is unchanged, and the file is a quarter of the size.
// That matters on a 1 GB Render disk and it matters more in memory: the whole
// index is held resident so a query never touches the disk.

/** float32 rows -> one int8 buffer. Each row carries its own scale. */
export function quantise(vectors, dim) {
  const count = vectors.length;
  const data = Buffer.alloc(count * dim);
  const scales = new Float32Array(count);

  for (let row = 0; row < count; row++) {
    const vector = vectors[row];
    if (vector.length !== dim) throw new Error(`vector ${row} has ${vector.length} dimensions, expected ${dim}`);
    let max = 0;
    for (const v of vector) { const a = Math.abs(v); if (a > max) max = a; }
    const scale = max > 0 ? max / 127 : 1;
    scales[row] = scale;
    const base = row * dim;
    for (let i = 0; i < dim; i++) {
      // Clamp: rounding 127.4999 up would wrap the signed byte to -128.
      data[base + i] = Math.max(-127, Math.min(127, Math.round(vector[i] / scale))) & 0xff;
    }
  }
  return { data, scales, count, dim };
}

/** Pack the rows and their scales into the single file the index loads. */
export function pack({ data, scales, count, dim }) {
  const header = Buffer.alloc(16);
  header.write('ANDYVEC1', 0, 'ascii');
  header.writeUInt32LE(count, 8);
  header.writeUInt32LE(dim, 12);
  return Buffer.concat([header, Buffer.from(scales.buffer, scales.byteOffset, count * 4), data]);
}

export function unpack(buffer) {
  if (!buffer || buffer.length < 16 || buffer.toString('ascii', 0, 8) !== 'ANDYVEC1') {
    throw new Error('vector file is missing or not an Andy index');
  }
  const count = buffer.readUInt32LE(8);
  const dim = buffer.readUInt32LE(12);
  const scalesEnd = 16 + count * 4;
  const expected = scalesEnd + count * dim;
  if (buffer.length !== expected) {
    throw new Error(`vector file is ${buffer.length} bytes, expected ${expected} for ${count}x${dim}`);
  }
  // Copy rather than view: a Buffer from disk is not guaranteed to be aligned
  // to 4 bytes, and Float32Array on an unaligned offset throws.
  const scales = new Float32Array(count);
  for (let i = 0; i < count; i++) scales[i] = buffer.readFloatLE(16 + i * 4);
  // Int8Array needs no alignment, so the rows are viewed in place rather than
  // copied — and the view is signed, which takes a branch out of the hot loop.
  const rows = buffer.subarray(scalesEnd);
  const data = new Int8Array(rows.buffer, rows.byteOffset, rows.length);
  return { data, scales, count, dim };
}

export class VectorIndex {
  constructor(packed) { this.index = packed ? unpack(packed) : { data: Buffer.alloc(0), scales: new Float32Array(0), count: 0, dim: 0 }; }

  get size() { return this.index.count; }
  get dim() { return this.index.dim; }

  /**
   * Cosine similarity against every row, top `k` returned.
   *
   * The query is quantised too, so the inner loop is integer multiply-add over
   * a Buffer — which V8 compiles well — instead of float work over an array of
   * arrays. The row scales are folded back in once per row, not per dimension.
   */
  search(queryVector, k = 60) {
    const { data, scales, count, dim } = this.index;
    if (!count) return [];
    if (queryVector.length !== dim) {
      throw new Error(`query has ${queryVector.length} dimensions, index has ${dim} — the corpus needs reindexing`);
    }

    let qMax = 0;
    for (const v of queryVector) { const a = Math.abs(v); if (a > qMax) qMax = a; }
    const qScale = qMax > 0 ? qMax / 127 : 1;
    const query = new Int8Array(dim);
    for (let i = 0; i < dim; i++) query[i] = Math.max(-127, Math.min(127, Math.round(queryVector[i] / qScale)));

    // A bounded min-heap would be tidier; for tens of thousands of rows a plain
    // array plus one sort is faster in practice and far easier to be sure of.
    const scored = new Array(count);
    for (let row = 0; row < count; row++) {
      const base = row * dim;
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += data[base + i] * query[i];
      scored[row] = { id: row, score: dot * scales[row] * qScale };
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }
}
