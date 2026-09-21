import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { needsVisualRead, readScannedPdf } from '../lib/ocr.mjs';
import { extractFile } from '../lib/extract.mjs';
import { sync } from '../lib/sync.mjs';
import { Knowledge } from '../lib/retrieve.mjs';

/** A PDF with `pages` pages and no meaningful text layer. */
async function blankPdf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    // Only a page number, which is exactly what a Canva export carries.
    doc.addPage([600, 800]).drawText(String(i + 1), { x: 300, y: 20, size: 9, font });
  }
  return Buffer.from(await doc.save());
}

const scripted = (texts) => {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (request) => {
        calls.push(request);
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: texts.shift() ?? '(no text on this page)' }] };
      },
    },
  };
};

// --- deciding whether a PDF needs reading ------------------------------------

test('an empty text layer needs a visual read', () => {
  assert.equal(needsVisualRead('', 1), true);
  assert.equal(needsVisualRead('   \n\u000c ', 2), true);
});

test('a text layer of nothing but page numbers needs a visual read', () => {
  // The common case, and the one a simple "did anything extract" test misses:
  // a deck exported from Canva or Keynote extracts "successfully" to this.
  assert.equal(needsVisualRead('Deck\n\u000c\n2\n\u000c\n3\n\u000c\n4', 4), true);
});

test('a real text layer is left alone, so nothing is paid for twice', () => {
  assert.equal(needsVisualRead('x'.repeat(2000), 4), false);
  assert.equal(needsVisualRead('x'.repeat(400), 4), false, '100 chars a page is a real document');
});

// --- reading one -------------------------------------------------------------

test('a PDF is sent to the model as a document block, not as text', async () => {
  const client = scripted(['Page one text\n---PAGE---\nPage two text']);
  const result = await readScannedPdf(await blankPdf(2), { client });

  const [block] = client.calls[0].messages[0].content;
  assert.equal(block.type, 'document');
  assert.equal(block.source.media_type, 'application/pdf');
  assert.ok(block.source.data.length > 0, 'the PDF itself must be sent');
  assert.match(result.text, /Page one text/);
  assert.equal(result.pages, 2);
});

test('the page marker becomes a real page break, so citations get page numbers', async () => {
  const client = scripted(['One\n---PAGE---\nTwo\n---PAGE---\nThree']);
  const { text } = await readScannedPdf(await blankPdf(3), { client });
  assert.equal(text.split('\u000c').length, 3, 'three pages means two breaks');
});

test('a long document is split into several requests', async () => {
  const client = scripted(['A', 'B', 'C']);
  const result = await readScannedPdf(await blankPdf(9), { client, pagesPerRequest: 4 });
  assert.equal(client.calls.length, 3, '9 pages at 4 a request is 3 requests');
  assert.equal(result.cost.requests, 3);
  assert.equal(result.cost.pages, 9);
  // Each request must carry only its own slice, not the whole document again.
  for (const call of client.calls) assert.ok(call.messages[0].content[0].source.data.length > 0);
});

test('a document past the page cap is refused rather than silently billed', async () => {
  const client = scripted(['x']);
  const long = await blankPdf(12);
  await assert.rejects(() => readScannedPdf(long, { client, maxPages: 5 }), /over the 5-page limit/);
  assert.equal(client.calls.length, 0, 'nothing may be sent once the cap is exceeded');
});

test('transcription runs at low effort, because it is not a reasoning task', async () => {
  const client = scripted(['x']);
  await readScannedPdf(await blankPdf(1), { client });
  assert.equal(client.calls[0].output_config.effort, 'low');
  assert.equal(client.calls[0].thinking, undefined, 'thinking about a transcription spends tokens for nothing');
});

test('a refusal is reported rather than stored as the document text', async () => {
  const client = { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } };
  const pdf = await blankPdf(1);
  await assert.rejects(() => readScannedPdf(pdf, { client }), /declined to transcribe/);
});

test('blank pages are dropped rather than transcribed as a note', async () => {
  const client = scripted(['Real text here\n---PAGE---\n(no text on this page)']);
  const { text } = await readScannedPdf(await blankPdf(2), { client });
  assert.ok(!/no text on this page/i.test(text));
  assert.match(text, /Real text here/);
});

// --- the fallback in context -------------------------------------------------

/** A PDF whose text layer is a real document, not a stray page number. */
async function readablePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([600, 800]);
    for (let line = 0; line < 20; line++) {
      page.drawText('Set a visible goal at the top of every stream so the room has a reason to gift.',
        { x: 40, y: 760 - line * 24, size: 10, font });
    }
  }
  return Buffer.from(await doc.save());
}

test('a readable PDF never reaches the visual reader', async () => {
  const buffer = await readablePdf();
  let called = false;
  await extractFile({ buffer, mimeType: 'application/pdf', name: 'ok.pdf', readScan: async () => { called = true; return null; } });
  assert.equal(called, false, 'paying to re-read a document that already extracted is pure waste');
});

test('a scan ingests end to end and becomes searchable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-scan-'));
  fs.writeFileSync(path.join(dir, 'Scanned Deck.pdf'), await blankPdf(2));

  const client = scripted(['Pink Drift is worth 3600 diamonds and comes from a fan club regular rather than a passer-by.']);
  const config = {
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'andy-data-')),
    knowledge: {
      chunk: { targetChars: 900, overlapChars: 80, minChars: 40 },
      readScans: { enabled: true, model: 'test', maxPages: 50, pagesPerRequest: 40 },
    },
    embeddings: { provider: 'none' },
    retrieval: {},
  };

  const report = await sync(config, { folder: dir, client });
  assert.equal(report.added, 1);
  assert.equal(report.readVisually.length, 1, 'the sync must report what it paid to read');
  assert.equal(report.readVisually[0].pages, 2);

  const [hit] = await new Knowledge(config).search('how much is pink drift worth');
  assert.ok(hit, 'a scan that was read should be searchable');
  assert.match(hit.chunk.text, /3600 diamonds/);
});

test('with reading turned off, a scan fails with a reason naming the setting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-scan-'));
  fs.writeFileSync(path.join(dir, 'Scanned Deck.pdf'), await blankPdf(2));
  const config = {
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'andy-data-')),
    knowledge: { chunk: {}, readScans: { enabled: false } },
    embeddings: { provider: 'none' },
    retrieval: {},
  };
  const report = await sync(config, { folder: dir });
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].error, /readScans/);
  assert.equal(new Knowledge(config).status().documents, 0,
    'a scan nobody can read must not count as a document Andy has read');
});
