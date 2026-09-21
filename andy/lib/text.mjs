// Small text helpers shared by extraction and chunking.
//
// They live apart so chunking — which is pure string work and the part worth
// unit testing — does not pull in the PDF and DOCX parsers to run.

/** Page boundary marker. A form feed, because no document body contains one. */
export const PAGE_BREAK = '\n\u000c\n';

/** Collapse the whitespace noise every extractor produces, keep paragraphs. */
export function tidy(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
