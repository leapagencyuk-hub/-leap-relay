import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sync, reindex, indexableText } from '../lib/sync.mjs';
import { Knowledge, renderPassages } from '../lib/retrieve.mjs';
import { Corpus } from '../lib/store.mjs';
import { Drive } from '../lib/drive.mjs';

const tempConfig = () => ({
  dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'andy-')),
  knowledge: { driveFolderId: 'FOLDER', maxFileMB: 1, chunk: { targetChars: 600, overlapChars: 80, minChars: 40 } },
  embeddings: { provider: 'none' },
  retrieval: { candidates: 30, passages: 5, rrfK: 60 },
});

/** A Drive stand-in: the two methods sync uses, backed by a mutable file list. */
function fakeDrive(files) {
  const state = { files: [...files], downloads: 0 };
  return {
    state,
    listFolder: async () => state.files.map(({ body, ...rest }) => rest),
    download: async (file) => {
      state.downloads++;
      const found = state.files.find((f) => f.id === file.id);
      if (found.body == null) throw new Error('nothing to download');
      return { buffer: Buffer.from(found.body, 'utf8'), mimeType: found.mimeType };
    },
  };
}

const file = (id, name, body, extra = {}) => ({
  id, name, body,
  mimeType: 'text/markdown',
  modifiedTime: '2026-09-01T00:00:00Z',
  size: body ? Buffer.byteLength(body) : 0,
  md5: `${id}-v1`,
  link: `https://drive/${id}`,
  folder: 'Gifting',
  ...extra,
});

const GIFTING = '# Goals\n\nSet a visible goal at the top of every stream so the room has a reason to gift right now.';
const SCHEDULE = '# Slippage\n\nFan club members drift away when a creator misses the days they usually stream on.';

test('a first sync reads everything and indexes it', async () => {
  const config = tempConfig();
  const drive = fakeDrive([file('a', 'Gifting.md', GIFTING), file('b', 'Schedules.md', SCHEDULE)]);
  const report = await sync(config, { drive });
  assert.equal(report.added, 2);
  assert.equal(report.chunks, 2);
  assert.equal(report.retrieval, 'keyword-only');
  assert.equal(drive.state.downloads, 2);
});

test('an unchanged file is not downloaded again', async () => {
  const config = tempConfig();
  const drive = fakeDrive([file('a', 'Gifting.md', GIFTING)]);
  await sync(config, { drive });
  const before = drive.state.downloads;
  const report = await sync(config, { drive });
  assert.equal(report.unchanged, 1);
  assert.equal(report.added, 0);
  assert.equal(drive.state.downloads, before, 'an unchanged file must not be re-downloaded');
});

test('--force re-reads a file whose checksum has not moved', async () => {
  const config = tempConfig();
  const drive = fakeDrive([file('a', 'Gifting.md', GIFTING)]);
  await sync(config, { drive });
  const before = drive.state.downloads;
  await sync(config, { drive, force: true });
  assert.equal(drive.state.downloads, before + 1);
});

test('a changed checksum re-reads the file and replaces its passages', async () => {
  const config = tempConfig();
  const drive = fakeDrive([file('a', 'Gifting.md', GIFTING)]);
  await sync(config, { drive });
  drive.state.files[0].body = '# Goals\n\nCompletely different guidance about running campaign matches every week.';
  drive.state.files[0].md5 = 'a-v2';
  const report = await sync(config, { drive });
  assert.equal(report.updated, 1);
  const hits = await new Knowledge(config).search('campaign matches');
  assert.ok(hits.length, 'the new text should be searchable');
  assert.ok(!hits.some((h) => h.chunk.text.includes('visible goal')), 'the old text should be gone');
});

test('a file deleted from Drive stops being quoted', async () => {
  const config = tempConfig();
  const drive = fakeDrive([file('a', 'Gifting.md', GIFTING), file('b', 'Schedules.md', SCHEDULE)]);
  await sync(config, { drive });
  drive.state.files = drive.state.files.filter((f) => f.id !== 'b');
  const report = await sync(config, { drive });
  assert.equal(report.removed, 1);
  const hits = await new Knowledge(config).search('fan club members drift away');
  assert.ok(!hits.some((h) => h.chunk.title === 'Schedules.md'), 'the deleted document must not still be retrievable');
});

test('a file that cannot be read is recorded with its reason and kept out of the index', async () => {
  const config = tempConfig();
  const drive = fakeDrive([file('a', 'Gifting.md', GIFTING), file('scan', 'Scan.pdf', null, { mimeType: 'application/pdf' })]);
  const report = await sync(config, { drive });
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].name, 'Scan.pdf');
  const status = new Knowledge(config).status();
  assert.equal(status.documents, 1, 'a failed file must not count as a document Andy has read');
  assert.equal(status.failed.length, 1);
});

test('a failed file is retried on the next sync rather than remembered as done', async () => {
  // A Drive blip, not a bad file: the download fails once and succeeds after.
  // The checksum never changes, so nothing but the retry rule can recover it —
  // which is the point. A transient failure must not quietly remove a document
  // from the brain until somebody happens to edit it.
  const config = tempConfig();
  const drive = fakeDrive([file('a', 'Gifting.md', GIFTING)]);
  let failNext = true;
  const flaky = {
    ...drive,
    download: async (f) => {
      if (failNext) { failNext = false; throw new Error('Drive timed out'); }
      return drive.download(f);
    },
  };

  const first = await sync(config, { drive: flaky });
  assert.equal(first.failed.length, 1);
  assert.equal(new Knowledge(config).status().documents, 0);

  const second = await sync(config, { drive: flaky });
  assert.equal(second.failed.length, 0, 'the retry should have succeeded');
  assert.equal(new Knowledge(config).status().documents, 1);
  assert.ok((await new Knowledge(config).search('visible goal')).length);
});

test('a file over the size limit is refused with a readable reason', async () => {
  const config = tempConfig();
  const big = file('big', 'Huge.md', 'x'.repeat(100));
  big.size = 5 * 1024 * 1024;   // over the 1 MB limit this config sets
  const report = await sync(config, { drive: fakeDrive([big]) });
  assert.match(report.failed[0].error, /over the 1 MB limit/);
});

test('reindex re-chunks from cache without touching Drive', async () => {
  const config = tempConfig();
  const drive = fakeDrive([file('a', 'Gifting.md', `# Goals\n\n${'Long body sentence about gifting goals. '.repeat(40)}`)]);
  await sync(config, { drive });
  const before = new Knowledge(config).status().chunks;

  config.knowledge.chunk.targetChars = 200;
  const downloads = drive.state.downloads;
  const report = await reindex(config, {});
  assert.equal(drive.state.downloads, downloads, 'reindex must not re-download');
  assert.ok(report.chunks > before, 'smaller chunks should produce more of them');
});

test('an interrupted sync leaves the previous index intact', async () => {
  const config = tempConfig();
  const drive = fakeDrive([file('a', 'Gifting.md', GIFTING)]);
  await sync(config, { drive });
  const good = new Knowledge(config).status().chunks;

  const broken = { listFolder: async () => { throw new Error('Drive is down'); }, download: async () => {} };
  await assert.rejects(() => sync(config, { drive: broken }), /Drive is down/);

  assert.equal(new Knowledge(config).status().chunks, good, 'yesterday\'s index should still be there');
});

test('a stale vector file is ignored rather than ranked against', async () => {
  const config = tempConfig();
  await sync(config, { drive: fakeDrive([file('a', 'Gifting.md', GIFTING), file('b', 'Schedules.md', SCHEDULE)]) });
  const corpus = new Corpus(config.dataDir);
  // A vector file from a corpus with a different number of chunks.
  corpus.writeVectors(Buffer.concat([
    (() => { const h = Buffer.alloc(16); h.write('ANDYVEC1', 0, 'ascii'); h.writeUInt32LE(99, 8); h.writeUInt32LE(4, 12); return h; })(),
    Buffer.alloc(99 * 4 + 99 * 4),
  ]));
  const status = new Knowledge(config).status();
  assert.equal(status.retrieval, 'keyword only');
  const hits = await new Knowledge(config).search('goals');
  assert.ok(hits.length, 'keyword search should still work');
});

test('the indexed text carries a chunk\'s provenance, not just its body', () => {
  const indexed = indexableText({ title: 'Gifting.pdf', folder: 'Campaigns', heading: 'Goals', text: 'body' });
  for (const part of ['Gifting.pdf', 'Campaigns', 'Goals', 'body']) assert.ok(indexed.includes(part));
});

test('passages are rendered with the id Andy is asked to cite', () => {
  const rendered = renderPassages([
    { chunk: { id: 7, title: 'Gifting.pdf', heading: 'Goals', page: 4, text: 'Set a goal.' } },
  ]);
  assert.match(rendered, /^\[#7\] Gifting\.pdf · Goals · page 4\nSet a goal\./);
});

test('page 1 is not spelled out, because every document has one', () => {
  const rendered = renderPassages([{ chunk: { id: 1, title: 'A.md', heading: null, page: 1, text: 'x' } }]);
  assert.ok(!rendered.includes('page 1'));
});

test('Drive file-type support covers what staff actually upload, and skips what it cannot read', () => {
  assert.ok(Drive.isSupported('application/pdf', 'Deck.pdf'));
  assert.ok(Drive.isSupported('application/vnd.google-apps.document', 'Notes'));
  assert.ok(Drive.isSupported('text/plain', 'notes.txt'));
  assert.ok(Drive.isSupported(null, 'transcript.vtt'));
  assert.ok(!Drive.isSupported('image/png', 'screenshot.png'));
  assert.ok(!Drive.isSupported('video/mp4', 'stream.mp4'));
  assert.ok(!Drive.isSupported('application/vnd.google-apps.form', 'Survey'));
});
