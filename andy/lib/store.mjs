// The corpus on disk.
//
// Three files, deliberately separate because they change at different rates:
//
//   documents.json   one entry per source file — id, name, Drive link, checksum
//   chunks.json.gz   the text Andy actually reads back, with its provenance
//   vectors.bin      one int8 row per chunk, in chunk order
//
// Chunks and vectors are kept in the same order so a search result index maps
// straight onto a chunk with no lookup table. `vectors.bin` is rewritten whole
// on every reindex, which at this corpus size costs a second and removes every
// class of bug that comes from patching a binary file in place.
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

export class Corpus {
  constructor(dataDir) {
    this.root = dataDir;
    this.docsPath = path.join(dataDir, 'documents.json');
    this.chunksPath = path.join(dataDir, 'chunks.json.gz');
    this.vectorsPath = path.join(dataDir, 'vectors.bin');
    this.metaPath = path.join(dataDir, 'index.json');
    this.filesDir = path.join(dataDir, 'files');
    fs.mkdirSync(this.filesDir, { recursive: true });
  }

  readDocuments() {
    if (!fs.existsSync(this.docsPath)) return {};
    return JSON.parse(fs.readFileSync(this.docsPath, 'utf8'));
  }

  writeDocuments(docs) { writeAtomic(this.docsPath, JSON.stringify(docs, null, 2)); }

  readChunks() {
    if (!fs.existsSync(this.chunksPath)) return [];
    return JSON.parse(gunzipSync(fs.readFileSync(this.chunksPath)).toString('utf8'));
  }

  writeChunks(chunks) { writeAtomic(this.chunksPath, gzipSync(JSON.stringify(chunks))); }

  readMeta() {
    if (!fs.existsSync(this.metaPath)) {
      return { updatedAt: null, chunks: 0, documents: 0, dim: 0, model: null, lastSync: null, embedded: 0 };
    }
    return JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
  }

  writeMeta(meta) { writeAtomic(this.metaPath, JSON.stringify(meta, null, 2)); }

  /** Extracted text, cached per Drive file so a re-chunk does not re-download. */
  textPath(docId) { return path.join(this.filesDir, `${safe(docId)}.txt`); }
  readText(docId) {
    const p = this.textPath(docId);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }
  writeText(docId, text) { writeAtomic(this.textPath(docId), text); }
  dropText(docId) { fs.rmSync(this.textPath(docId), { force: true }); }

  readVectors() {
    if (!fs.existsSync(this.vectorsPath)) return null;
    return fs.readFileSync(this.vectorsPath);
  }

  writeVectors(buffer) { writeAtomic(this.vectorsPath, buffer); }

  stats() {
    const meta = this.readMeta();
    const docs = Object.values(this.readDocuments());
    return {
      ...meta,
      documents: docs.length,
      bytes: docs.reduce((sum, d) => sum + (d.size ?? 0), 0),
      byType: docs.reduce((acc, d) => { acc[d.kind ?? 'other'] = (acc[d.kind ?? 'other'] ?? 0) + 1; return acc; }, {}),
      failed: docs.filter((d) => d.error).length,
    };
  }
}

// A half-written index is worse than a missing one: it loads, it looks fine,
// and every answer from it is wrong. Write beside, then rename.
function writeAtomic(target, contents) {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, target);
}

const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, '_');
