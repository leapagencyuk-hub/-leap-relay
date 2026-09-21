// Cutting a document into the pieces Andy retrieves.
//
// The whole quality of an answer is decided here. Two failure modes to avoid:
//
//   Too small, and a chunk says "do this for 20 minutes" with no clue what
//   "this" is — retrieved, it is useless, and worse, it reads as authoritative.
//
//   Too big, and one chunk covers gifting, schedules and campaigns at once. It
//   matches every query slightly and none of them well, and it crowds better
//   passages out of the answer.
//
// So: split on the document's own structure first, and only fall back to
// counting characters when a section is too long to sit in one piece. Every
// chunk carries the heading trail above it, because "Under 1,000 followers"
// means nothing without "Fan club growth > Early stage" over the top of it.
import { PAGE_BREAK } from './text.mjs';

const HEADING = [
  /^#{1,6}\s+\S/,                       // markdown
  /^[A-Z][A-Za-z0-9 ,'&()/-]{2,70}:$/,  // "Gifting strategy:"
  /^\d+(\.\d+)*[.)]\s+\S/,              // "3.2 Goals"
  /^[A-Z0-9 &'()/-]{4,70}$/,            // A LINE IN CAPS
];

const isHeading = (line) => {
  const t = line.trim();
  if (!t || t.length > 90) return false;
  if (/[.!?]$/.test(t) && !/:$/.test(t)) return false;   // a sentence, not a title
  return HEADING.some((re) => re.test(t));
};

const headingDepth = (line) => {
  const t = line.trim();
  const hashes = t.match(/^(#{1,6})\s/);
  if (hashes) return hashes[1].length;
  if (/^\d+\.\d+/.test(t)) return 3;
  if (/^\d+[.)]\s/.test(t)) return 2;
  return /^[A-Z0-9 &'()/-]+$/.test(t) ? 1 : 2;
};

const cleanHeading = (line) => line.trim().replace(/^#{1,6}\s+/, '').replace(/:$/, '').trim();

/**
 * Split a document into chunks.
 *
 * @returns {Array<{ text, heading, page, index }>} in document order.
 */
export function chunkDocument(text, options = {}) {
  const targetChars = options.targetChars ?? 1800;
  const overlapChars = options.overlapChars ?? 250;
  const minChars = options.minChars ?? 120;

  const sections = splitByHeading(String(text ?? ''));
  const chunks = [];

  for (const section of sections) {
    for (const piece of splitToSize(section.text, targetChars, overlapChars)) {
      if (piece.text.trim().length < minChars && chunks.length) {
        // A stub — a stray caption, a page number. Fold it into its neighbour
        // rather than letting it compete for a slot in the answer.
        const previous = chunks[chunks.length - 1];
        previous.text = `${previous.text}\n${piece.text.trim()}`;
        continue;
      }
      if (piece.text.trim().length < minChars) continue;
      chunks.push({
        text: piece.text.trim(),
        heading: section.heading,
        page: section.page + piece.pageOffset,
        index: chunks.length,
      });
    }
  }
  return chunks;
}

/** Break the document at its headings, tracking the trail and the page. */
function splitByHeading(text) {
  const lines = text.split('\n');
  const sections = [];
  const trail = [];
  let buffer = [];
  let page = 1;
  let sectionPage = 1;

  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body) sections.push({ heading: trail.join(' > ') || null, text: buffer.join('\n'), page: sectionPage });
    buffer = [];
    sectionPage = page;
  };

  for (const line of lines) {
    // A form feed is the page boundary extractPdf left behind.
    if (line.includes('\u000c')) { page += line.split('\u000c').length - 1; }

    if (isHeading(line)) {
      flush();
      const depth = headingDepth(line);
      trail.length = Math.min(trail.length, depth - 1);
      trail[depth - 1] = cleanHeading(line);
      for (let i = 0; i < trail.length; i++) trail[i] ??= '';
      while (trail.length && !trail[trail.length - 1]) trail.pop();
      sectionPage = page;
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections.filter((s) => s.text.trim());
}

/**
 * Cut an over-long section on paragraph boundaries, then sentences, never
 * mid-word. Consecutive pieces overlap by `overlapChars` so a point made across
 * a boundary survives in at least one of them whole.
 */
function splitToSize(text, targetChars, overlapChars) {
  const clean = text.replaceAll('\u000c', '');
  if (clean.trim().length <= targetChars) {
    return [{ text: clean, pageOffset: 0 }];
  }

  const units = clean.split(/\n{2,}/).flatMap((para) =>
    para.length <= targetChars ? [para] : splitSentences(para, targetChars));

  const pieces = [];
  let current = '';
  let consumed = 0;       // characters of the section before `current` begins
  let startedAt = 0;

  const push = () => {
    if (!current.trim()) return;
    pieces.push({ text: current, pageOffset: pageOffsetAt(text, startedAt) });
  };

  for (const unit of units) {
    if (current && current.length + unit.length + 2 > targetChars) {
      push();
      const tail = overlapChars > 0 ? current.slice(-overlapChars) : '';
      // Start the overlap at a sentence boundary so it does not open mid-clause.
      const trimmed = tail.replace(/^[^.!?\n]*[.!?\n]\s*/, '') || tail;
      startedAt = consumed + current.length - trimmed.length;
      current = trimmed ? `${trimmed}\n\n${unit}` : unit;
      consumed = startedAt;
      continue;
    }
    current = current ? `${current}\n\n${unit}` : unit;
  }
  push();
  return pieces;
}

function splitSentences(paragraph, targetChars) {
  const sentences = paragraph.match(/[^.!?]+[.!?]+[\])'"`’”]*\s*|[^.!?]+$/g) ?? [paragraph];
  const out = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > targetChars) { out.push(current.trim()); current = ''; }
    // A single sentence longer than a whole chunk is a table or a wall of
    // bullet text with no full stops; cut it on width as a last resort.
    if (sentence.length > targetChars) {
      for (let i = 0; i < sentence.length; i += targetChars) out.push(sentence.slice(i, i + targetChars).trim());
      continue;
    }
    current += sentence;
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

const pageOffsetAt = (text, charIndex) => (text.slice(0, Math.max(0, charIndex)).match(/\u000c/g) ?? []).length;

export { isHeading, splitByHeading, PAGE_BREAK };
