// What Andy can read, independent of where the file came from.
//
// Lives apart from the Drive client because the same question is asked of a
// file dragged onto the admin page, a file in a local folder, and a file in
// Drive. One answer, one place to change it.

/** Google's own formats have no bytes to download — they are exported. */
export const GOOGLE_EXPORT = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

const SUPPORTED_EXT = /\.(pdf|docx|txt|md|markdown|csv|tsv|html?|json|rtf|vtt|srt)$/i;
const SUPPORTED_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values',
  'text/html', 'application/json', 'application/rtf', 'text/vtt',
]);

export function isSupported(mimeType, name = '') {
  if (GOOGLE_EXPORT[mimeType]) return true;
  // Drive's other native types — Forms, Drawings, Sites — export to nothing
  // useful, so they are skipped rather than half-read.
  if (mimeType?.startsWith('application/vnd.google-apps')) return false;
  return SUPPORTED_EXT.test(name) || SUPPORTED_MIME.has(mimeType);
}

/** A rough label for the admin page, so a corpus can be seen at a glance. */
export function kindOf({ mimeType, name = '' }) {
  if (mimeType === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (/\.docx$/i.test(name) || mimeType?.includes('wordprocessingml')) return 'docx';
  if (mimeType?.startsWith('application/vnd.google-apps')) return 'google';
  if (/\.(csv|tsv)$/i.test(name)) return 'sheet';
  if (/\.(vtt|srt)$/i.test(name)) return 'transcript';
  return 'text';
}

/** Best guess at a media type from a filename, for files that arrive without one. */
export function mimeFromName(name) {
  const ext = (String(name).match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  return {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
    csv: 'text/csv', tsv: 'text/tab-separated-values',
    html: 'text/html', htm: 'text/html',
    json: 'application/json', rtf: 'application/rtf',
    vtt: 'text/vtt', srt: 'text/plain',
  }[ext] ?? 'application/octet-stream';
}
