// Turning a file into text Andy can read.
//
// Page numbers matter more here than they look. A coach told "the guide says
// run a 20-minute goal" wants to see it; "Gifting Playbook, page 14" is a
// citation they can open and check, and it is the difference between a tool
// they trust and a tool they argue with.
import path from 'node:path';
import { createRequire } from 'node:module';
import mammoth from 'mammoth';
import { PAGE_BREAK, tidy } from './text.mjs';
import { needsVisualRead } from './ocr.mjs';

// pdfjs warns on every page of every PDF unless it is told where its own
// bundled font metrics live. The warning is harmless and the noise is not:
// it buries the extraction failures that actually need reading.
const require = createRequire(import.meta.url);
const STANDARD_FONTS = `${path.dirname(require.resolve('pdfjs-dist/package.json'))}/standard_fonts/`;

let pdfjsPromise = null;
// pdfjs is a large import and most syncs touch a handful of files, so it is
// only pulled in when a PDF actually turns up.
function pdfjs() {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

/** How many pages the PDF has, without extracting any of it. */
export async function pdfPageCount(buffer) {
  const { getDocument } = await pdfjs();
  const doc = await getDocument({ data: new Uint8Array(buffer), standardFontDataUrl: STANDARD_FONTS, disableFontFace: true, isEvalSupported: false }).promise;
  const pages = doc.numPages;
  await doc.destroy();
  return pages;
}

export async function extractPdf(buffer) {
  const { getDocument } = await pdfjs();
  const doc = await getDocument({
    data: new Uint8Array(buffer),
    // A scanned deck with no text layer should come back empty, not spend a
    // minute rendering fonts nobody will read.
    standardFontDataUrl: STANDARD_FONTS,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
  }).promise;

  const pages = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(joinItems(content.items));
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages.join(PAGE_BREAK);
}

/**
 * pdfjs hands back positioned fragments, not lines. Reassembling them on the
 * fragment's own line break flag keeps sentences together; joining everything
 * with spaces instead produces one enormous run-on paragraph per page, which
 * chunks badly and reads worse.
 */
function joinItems(items) {
  let out = '';
  for (const item of items) {
    if (item.str === undefined) continue;
    out += item.str;
    if (item.hasEOL) out += '\n';
    else if (item.str && !item.str.endsWith(' ')) out += ' ';
  }
  return tidy(out);
}

export async function extractDocx(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return tidy(value);
}

export function extractHtml(text) {
  return tidy(
    String(text)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))),
  );
}

/** Subtitles are mostly timestamps; the words are the only part worth keeping. */
export function extractSubtitles(text) {
  return tidy(
    String(text)
      .split(/\r?\n/)
      .filter((line) => !/^\d+$/.test(line.trim()))
      .filter((line) => !/-->/.test(line))
      .filter((line) => !/^(WEBVTT|NOTE|Kind:|Language:)/i.test(line.trim()))
      .join('\n'),
  );
}

/** A CSV is a table; one row per line with its header keeps it searchable. */
export function extractDelimited(text, delimiter = ',') {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return tidy(text);
  const header = lines[0].split(delimiter).map((h) => h.trim());
  const rows = lines.slice(1, 5001).map((line) => {
    const cells = line.split(delimiter);
    return header.map((h, i) => `${h}: ${(cells[i] ?? '').trim()}`).join(' · ');
  });
  return tidy([lines[0], ...rows].join('\n'));
}

/**
 * Extract one file. Returns `{ text, pages }`, or throws with a reason the
 * admin page can show — a file that failed silently is a gap in the brain
 * nobody knows about.
 */
export async function extractFile({ buffer, mimeType, name, readScan = null }) {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  const asText = () => buffer.toString('utf8');

  let text;
  let visuallyRead = false;
  let pagesRead = 0;
  if (mimeType === 'application/pdf' || ext === 'pdf') {
    text = await extractPdf(buffer);
    // A deck exported from Canva or Keynote often carries a text layer holding
    // nothing but page numbers, so "did anything extract" is the wrong test —
    // how much per page is the right one.
    const pages = text.split(PAGE_BREAK).length;
    if (needsVisualRead(text, pages)) {
      if (!readScan) {
        // Indexing "1 2 3" as a document is worse than refusing it: it counts
        // as read, contributes nothing, and hides a real gap in the library.
        throw new Error('no usable text layer — this is a scan or an image-only export. Turn on knowledge.readScans to have Andy read it.');
      }
      const read = await readScan({ buffer, name, pages });
      if (read?.text) {
        text = read.text;
        visuallyRead = true;
        // The pages the reader actually billed for, not the page markers it
        // produced — a transcript that merges two pages still cost two.
        pagesRead = read.pages ?? pages;
      }
    }
  } else if (ext === 'docx' || mimeType?.includes('wordprocessingml')) {
    text = await extractDocx(buffer);
  } else if (ext === 'html' || ext === 'htm' || mimeType === 'text/html') {
    text = extractHtml(asText());
  } else if (ext === 'vtt' || ext === 'srt') {
    text = extractSubtitles(asText());
  } else if (ext === 'csv' || mimeType === 'text/csv') {
    text = extractDelimited(asText(), ',');
  } else if (ext === 'tsv' || mimeType === 'text/tab-separated-values') {
    text = extractDelimited(asText(), '\t');
  } else if (ext === 'json' || mimeType === 'application/json') {
    text = tidy(asText());
  } else if (ext === 'rtf' || mimeType === 'application/rtf') {
    text = tidy(asText().replace(/\\[a-z]+-?\d*\s?/gi, ' ').replace(/[{}]/g, ' '));
  } else {
    text = tidy(asText());
  }

  const pages = text.split(PAGE_BREAK).length;
  if (!text.trim()) throw new Error('no readable text');
  return { text, pages, visuallyRead, pagesRead };
}

export { PAGE_BREAK, tidy };
