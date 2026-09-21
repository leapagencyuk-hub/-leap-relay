// Small text helpers shared by extraction and chunking.
//
// They live apart so chunking — which is pure string work and the part worth
// unit testing — does not pull in the PDF and DOCX parsers to run.

/**
 * Page boundary marker. A form feed, because no document body contains one.
 *
 * PAGE_FEED is the character itself. Reach for it rather than trimming
 * PAGE_BREAK: a form feed *is* whitespace, so `PAGE_BREAK.trim()` is the empty
 * string, and anything built on that silently loses every page boundary.
 */
export const PAGE_FEED = '\u000c';
export const PAGE_BREAK = `\n${PAGE_FEED}\n`;

/** Collapse the whitespace noise every extractor produces, keep paragraphs. */
export function tidy(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
