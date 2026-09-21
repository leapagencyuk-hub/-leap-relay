// Reading a PDF that has no text to extract.
//
// A scanned or photographed deck is a document LEAP paid for and cannot use —
// pdfjs finds nothing in it, and it sits in the corpus contributing zero
// passages. Traditional OCR is the usual answer and it is a poor one here:
// this library is slide decks, screenshots of TikTok's own dashboards, and
// diagrams with text scattered around them, which is exactly the material
// line-based OCR handles worst.
//
// So the fallback is Claude reading the pages. The Messages API takes a PDF
// directly as a document block and reads it visually, which means layout,
// tables, and text inside screenshots all survive — and it needs no native
// binary, no WASM, and nothing installed on the host.
//
// This costs real money per page, unlike everything else in the ingest path.
// So it only ever runs on a PDF that yielded nothing, it is capped, and every
// page it reads is reported.
import { PAGE_FEED } from './text.mjs';

const PROMPT = `Transcribe this document to plain text, page by page.

Rules:
- Put the marker ---PAGE--- on its own line between pages, and nowhere else.
- Transcribe every word you can see, including text inside screenshots, charts and diagrams.
- Keep headings on their own lines. Keep lists as lists. Keep tables readable, one row per line.
- Do not summarise, do not explain, do not add anything that is not in the document.
- If a page is blank or has no readable text, write (no text on this page).

Output the transcription only.`;

/** The model's page marker, converted to the form-feed the chunker expects. */
const MARKER = /^\s*-{2,}\s*PAGE\s*-{2,}\s*$/gim;

/**
 * Read a PDF with Claude's vision and return its text.
 *
 * @param {Buffer} buffer the PDF
 * @param {object} options
 * @param {import('@anthropic-ai/sdk').default} options.client
 * @returns {Promise<{ text, pages, cost: { requests, pages } }>}
 */
export async function readScannedPdf(buffer, {
  client,
  model = 'claude-opus-5',
  maxPages = 120,
  pagesPerRequest = 40,
  name = 'document',
  onProgress = () => {},
} = {}) {
  const { PDFDocument } = await import('pdf-lib');
  const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const total = source.getPageCount();

  if (total > maxPages) {
    throw new Error(`${total} pages is over the ${maxPages}-page limit for reading a scan — raise knowledge.readScans.maxPages if this one is worth the cost`);
  }

  // Sent in batches rather than whole: one request per 500-page manual would
  // be slow, near the request-size limit, and would lose everything if it
  // failed. A batch that fails costs its own pages, not the document.
  const batches = [];
  for (let start = 0; start < total; start += pagesPerRequest) {
    batches.push([start, Math.min(start + pagesPerRequest, total)]);
  }

  const parts = [];
  for (const [start, end] of batches) {
    onProgress({ name, done: start, total });
    const slice = batches.length === 1 ? buffer : await extractPages(source, start, end);
    const response = await client.messages.create({
      model,
      max_tokens: 32000,
      // Transcription is not a reasoning task; thinking about it spends tokens
      // to no benefit, and low effort keeps a large corpus affordable.
      output_config: { effort: 'low' },
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: slice.toString('base64') } },
          { type: 'text', text: PROMPT },
        ],
      }],
    });

    if (response.stop_reason === 'refusal') {
      throw new Error('the model declined to transcribe this document');
    }
    parts.push(response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim());
  }
  onProgress({ name, done: total, total });

  // PAGE_FEED, not PAGE_BREAK.trim() — a form feed is whitespace, so trimming
  // one leaves an empty string, and every page in every scan would collapse
  // onto page 1 with the citations to match.
  const text = parts.join('\n---PAGE---\n')
    .replace(MARKER, `\n${PAGE_FEED}\n`)
    .replace(/\(no text on this page\)/gi, '')
    .trim();

  return { text, pages: total, cost: { requests: batches.length, pages: total } };
}

/** A new PDF holding one page range of the original. */
async function extractPages(source, start, end) {
  const { PDFDocument } = await import('pdf-lib');
  const slice = await PDFDocument.create();
  const copied = await slice.copyPages(source, Array.from({ length: end - start }, (_, i) => start + i));
  for (const page of copied) slice.addPage(page);
  return Buffer.from(await slice.save());
}

/**
 * Is this PDF's text layer good enough to use?
 *
 * A pure scan extracts to nothing, which is easy. The harder and more common
 * case is a deck exported from Canva or Keynote where only the page numbers
 * and a stray footer carry a text layer — that extracts "successfully" to
 * forty characters and looks like a working document. Both are decided on the
 * same measure: how much text there is per page.
 */
export function needsVisualRead(text, pages, minCharsPerPage = 80) {
  const clean = String(text ?? '').replaceAll('\u000c', '').trim();
  if (!clean) return true;
  return clean.length / Math.max(1, pages) < minCharsPerPage;
}
