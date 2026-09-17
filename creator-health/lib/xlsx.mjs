// Minimal, dependency-free .xlsx reader.
// An xlsx is a zip of XML parts; we only need sharedStrings.xml and the first sheet.
// Reading it here keeps the pipeline installable on Render with `npm install` doing nothing.
import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

function findEndOfCentralDirectory(buf) {
  // The EOCD record lives in the last 64KB; scan backwards for its signature.
  const min = Math.max(0, buf.length - 0x10000 - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('not a zip file (no end-of-central-directory record)');
}

function readEntries(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extract(buf, entry) {
  // The local file header repeats the name/extra lengths, which may differ from the
  // central directory copy, so re-read them rather than trusting the central record.
  const lo = entry.localOffset;
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`unsupported zip compression method ${entry.method}`);
}

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function unescapeXml(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return XML_ENTITIES[code] ?? m;
  });
}

function parseSharedStrings(xml) {
  const out = [];
  // Each <si> may hold one <t> or several <r><t> rich-text runs; join every run.
  for (const si of xml.split('<si>').slice(1)) {
    const body = si.slice(0, si.indexOf('</si>'));
    let text = '';
    const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let m;
    while ((m = re.exec(body))) text += m[1];
    out.push(unescapeXml(text));
  }
  return out;
}

function columnToIndex(ref) {
  // "BC12" -> 54 (zero-based column index)
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>|<row[^>]*\/>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(xml))) {
    const body = rowMatch[1] ?? '';
    const cells = [];
    const cellRe = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch;
    while ((cellMatch = cellRe.exec(body))) {
      const attrs = cellMatch[1];
      const inner = cellMatch[2] ?? '';
      const refAttr = /r="([A-Z]+\d+)"/.exec(attrs);
      const idx = refAttr ? columnToIndex(refAttr[1]) : cells.length;
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      let value = null;
      if (type === 'inlineStr') {
        let text = '';
        const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
        let t;
        while ((t = tRe.exec(inner))) text += t[1];
        value = unescapeXml(text);
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (v != null) value = type === 's' ? (shared[Number(v)] ?? '') : unescapeXml(v);
      }
      while (cells.length < idx) cells.push(null);
      cells[idx] = value;
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * Read the first worksheet of an xlsx file as an array of row arrays.
 * Every cell comes back as a string or null; typing is the caller's job.
 */
export function readSheetRows(filePath) {
  const buf = readFileSync(filePath);
  const entries = readEntries(buf);
  const sharedEntry = entries.get('xl/sharedStrings.xml');
  const shared = sharedEntry ? parseSharedStrings(extract(buf, sharedEntry).toString('utf8')) : [];
  const sheetName = [...entries.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort()[0];
  if (!sheetName) throw new Error('workbook contains no worksheet');
  return parseSheet(extract(buf, entries.get(sheetName)).toString('utf8'), shared);
}

/** Read the first worksheet as objects keyed by the header row. */
export function readSheetObjects(filePath) {
  const rows = readSheetRows(filePath);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => (h ?? '').trim());
  const records = [];
  for (const row of rows.slice(1)) {
    if (!row.some((c) => c != null && c !== '')) continue;
    const rec = {};
    headers.forEach((h, i) => { if (h) rec[h] = row[i] ?? ''; });
    records.push(rec);
  }
  return { headers, records };
}
