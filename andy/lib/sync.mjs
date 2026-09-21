// Bringing the Drive folder into the index.
//
// The design rule here is that a sync must be safe to run at any time, as often
// as anyone likes, and must never leave the brain worse than it found it:
//
//   - Unchanged files are skipped on their Drive checksum, so a nightly sync
//     over 400 documents downloads nothing and costs nothing.
//   - Extracted text is cached per file, so a chunking change re-chunks from
//     disk instead of re-downloading the folder.
//   - A file that fails to extract is recorded with its reason and kept out of
//     the index. A scan with no text layer is the common case and it is a real
//     gap in the brain, so it is shown on the admin page rather than swallowed.
//   - The index is only replaced once it is fully rebuilt. An interrupted sync
//     leaves yesterday's working index in place.
import fs from 'node:fs';
import { Corpus } from './store.mjs';
import { Drive, driveSource } from './drive.mjs';
import { LocalSource } from './local.mjs';
import { isSupported, kindOf } from './formats.mjs';
import { extractFile } from './extract.mjs';
import { readScannedPdf } from './ocr.mjs';
import { chunkDocument } from './chunk.mjs';
import { Embedder } from './embed.mjs';
import { quantise, pack } from './vectors.mjs';
import { KeywordIndex } from './keyword.mjs';

/**
 * Pick where the files come from.
 *
 * Three sources, one pipeline. Drive is the default because that is where the
 * library lives, but a local folder needs no Google Cloud project at all, and
 * the uploads folder is what the admin page's drag-and-drop writes into. Once
 * a source is chosen, nothing downstream knows the difference.
 */
export function sourceFor(config, { folder = null } = {}) {
  if (folder) return new LocalSource(folder);

  const localRoot = config.knowledge?.localFolder;
  if (localRoot) return new LocalSource(localRoot);

  // Anything dragged onto the admin page wins over Drive. Someone who has just
  // uploaded files expects to be answered from them, not from a Drive folder
  // that may not even be connected yet.
  if (config.uploadDir && fs.existsSync(config.uploadDir) && fs.readdirSync(config.uploadDir).length) {
    return new LocalSource(config.uploadDir);
  }

  const folderId = config.knowledge?.driveFolderId;
  const drive = Drive.fromEnv();
  if (drive && folderId) return driveSource(drive, folderId);

  if (folderId && !drive) {
    throw new Error('no Drive service account — set GOOGLE_SERVICE_ACCOUNT_JSON, or point Andy at a local folder with `cli.mjs ingest <path>`');
  }
  throw new Error('nothing to read — configure a Drive folder or pass a local one');
}

export async function sync(config, { source = null, onProgress = () => {}, force = false, folder = null, client = null } = {}) {
  const corpus = new Corpus(config.dataDir);
  source ??= sourceFor(config, { folder });
  const readScan = scanReader(config, { client, onProgress });

  onProgress({ phase: 'listing', message: `reading ${source.label}` });
  const files = await source.list();
  const usable = files.filter((f) => isSupported(f.mimeType, f.name));
  const skipped = files.filter((f) => !isSupported(f.mimeType, f.name));

  const known = corpus.readDocuments();
  const next = {};
  const report = { found: files.length, skipped: skipped.length, added: 0, updated: 0, unchanged: 0, removed: 0, failed: [], readVisually: [] };
  const maxBytes = (config.knowledge?.maxFileMB ?? 60) * 1024 * 1024;

  for (const [i, file] of usable.entries()) {
    onProgress({ phase: 'reading', message: file.name, done: i, total: usable.length });
    const previous = known[file.id];
    // Google-native files report no checksum and no size, so their modified
    // time is the only change signal available.
    const stamp = file.md5 ?? file.modifiedTime;
    const cached = corpus.readText(file.id);

    if (!force && previous && previous.stamp === stamp && cached !== null && !previous.error) {
      next[file.id] = previous;
      report.unchanged++;
      continue;
    }

    if (file.size > maxBytes) {
      report.failed.push({ name: file.name, error: `${(file.size / 1048576).toFixed(0)} MB is over the ${config.knowledge?.maxFileMB ?? 60} MB limit` });
      next[file.id] = { ...describe(file), stamp, error: 'too large', chunks: 0 };
      continue;
    }

    try {
      const { buffer, mimeType } = await source.download(file);
      const { text, pages, visuallyRead, pagesRead } = await extractFile({ buffer, mimeType, name: file.name, readScan });
      corpus.writeText(file.id, text);
      next[file.id] = { ...describe(file), stamp, pages, chars: text.length, error: null, chunks: 0, visuallyRead: Boolean(visuallyRead) };
      if (visuallyRead) report.readVisually.push({ name: file.name, pages: pagesRead });
      if (previous) report.updated++; else report.added++;
    } catch (err) {
      report.failed.push({ name: file.name, error: err.message });
      next[file.id] = { ...describe(file), stamp, error: err.message, chunks: 0 };
      corpus.dropText(file.id);
    }
  }

  // Anything no longer in the folder is gone from the brain too — a document
  // somebody deleted because it was wrong must stop being quoted.
  for (const id of Object.keys(known)) {
    if (!next[id]) { corpus.dropText(id); report.removed++; }
  }

  corpus.writeDocuments(next);
  const indexReport = await reindex(config, { corpus, onProgress });
  return { ...report, ...indexReport, source: source.label, skippedFiles: skipped.map((f) => f.name) };
}

/**
 * Rebuild chunks, vectors and the keyword index from the cached text.
 *
 * Separate from `sync` on purpose: a chunking or embedding-model change needs
 * this and nothing else, and it runs without touching Drive at all.
 */
export async function reindex(config, { corpus = null, onProgress = () => {} } = {}) {
  corpus ??= new Corpus(config.dataDir);
  const documents = corpus.readDocuments();
  const embedder = new Embedder(config.embeddings);

  onProgress({ phase: 'chunking', message: 'cutting documents into passages' });
  const chunks = [];
  for (const [id, doc] of Object.entries(documents)) {
    doc.chunks = 0;
    if (doc.error) continue;
    const text = corpus.readText(id);
    if (!text) continue;
    for (const piece of chunkDocument(text, config.knowledge?.chunk ?? {})) {
      chunks.push({
        id: chunks.length,
        docId: id,
        title: doc.name,
        folder: doc.folder,
        link: doc.link,
        heading: piece.heading,
        page: piece.page,
        text: piece.text,
      });
      doc.chunks++;
    }
  }

  onProgress({ phase: 'keyword', message: `indexing ${chunks.length} passages` });
  // The heading trail and the file name are part of what a chunk is about, so
  // they are indexed with it — a passage under "Fan club growth" should be
  // findable by that phrase even when its body never repeats it.
  const searchable = chunks.map(indexableText);
  const keyword = KeywordIndex.build(searchable);

  let embedded = 0;
  let dim = 0;
  if (embedder.enabled && chunks.length) {
    const vectors = await embedder.embed(searchable, {
      kind: 'document',
      onProgress: (done, total) => onProgress({ phase: 'embedding', message: `${done}/${total} passages`, done, total }),
    });
    dim = vectors[0]?.length ?? 0;
    corpus.writeVectors(pack(quantise(vectors, dim)));
    embedded = vectors.length;
  } else {
    // Leaving a stale vector file behind would silently rank the new corpus
    // against the old one's embeddings.
    fs.rmSync(corpus.vectorsPath, { force: true });
  }

  corpus.writeChunks(chunks);
  fs.writeFileSync(`${corpus.root}/keyword.json`, JSON.stringify(keyword.toJSON()));
  corpus.writeDocuments(documents);
  corpus.writeMeta({
    updatedAt: new Date().toISOString(),
    lastSync: new Date().toISOString(),
    chunks: chunks.length,
    documents: Object.values(documents).filter((d) => !d.error).length,
    embedded,
    dim,
    model: embedder.enabled ? embedder.label : null,
  });

  return { chunks: chunks.length, embedded, dim, retrieval: embedder.enabled ? 'hybrid' : 'keyword-only' };
}

/**
 * The visual reader, or null when it is off or unusable.
 *
 * Off by default is deliberate: this is the only part of ingest that costs
 * money per page, and a folder of scans could quietly run up a bill on a sync
 * nobody watched. It is turned on knowingly, and every page it reads is
 * reported back.
 */
function scanReader(config, { client, onProgress }) {
  const settings = config.knowledge?.readScans;
  if (!settings?.enabled) return null;
  if (!client && !process.env.ANTHROPIC_API_KEY) return null;

  return async ({ buffer, name }) => {
    const sdk = client ?? new (await import('@anthropic-ai/sdk')).default();
    try {
      return await readScannedPdf(buffer, {
        client: sdk,
        model: settings.model ?? 'claude-opus-5',
        maxPages: settings.maxPages ?? 120,
        pagesPerRequest: settings.pagesPerRequest ?? 40,
        name,
        onProgress: ({ done, total }) => onProgress({ phase: 'reading a scan', message: name, done, total }),
      });
    } catch (err) {
      // A scan that cannot be read must not fail the file: the document is
      // recorded with the reason, exactly as an unreadable one always was.
      throw new Error(`no text layer, and reading it visually failed: ${err.message}`);
    }
  };
}

/** What gets indexed for a chunk: its provenance, then its text. */
export function indexableText(chunk) {
  return [chunk.title, chunk.folder, chunk.heading, chunk.text].filter(Boolean).join('\n');
}

const describe = (file) => ({
  name: file.name,
  folder: file.folder,
  link: file.link,
  mimeType: file.mimeType,
  size: file.size,
  modifiedTime: file.modifiedTime,
  kind: kindOf(file),
});

