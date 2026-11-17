// The files a Question's body shows in place: each `![alt](attachment:<name>)`
// image in its markdown names one of the files the Question carries. The
// renderer (`question-markdown.ts`) draws such an image from the file of that
// name, and says which names it drew (`bodyImages`), so the page can leave
// those files out of the strip of files under the body. Both read the body's
// names here, so they agree on which images there are.
//
// Pure: `marked`'s lexer only, no clock, no platform. Not on the web's
// subpath (`@operator-inbox/core/api`), which reaches only `effect`: the page
// gets the names from serve instead.

import { Lexer, type Token, type Tokens } from 'marked';

const ATTACHMENT_SRC = /^attachment:/i;

/** Whether an image's source names one of the Question's files. */
export const isAttachmentSrc = (href: string): boolean =>
  ATTACHMENT_SRC.test(href);

/**
 * The file name an `attachment:<name>` source names: the rest of the source,
 * percent-decoded when it decodes.
 */
export const attachmentSrcName = (href: string): string => {
  const raw = href.replace(ATTACHMENT_SRC, '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

// A `<small>` block's markdown, which the renderer reads as markdown of its
// own (`pairSmallTags` in `question-markdown.ts`): a block of HTML that is
// exactly `<small>`, a newline, the markdown, a newline and `</small>`.
const SMALL_BLOCK = /^<small\s*>\n([\s\S]*)\n<\/small\s*>$/i;

const collect = (tokens: ReadonlyArray<Token>, names: Array<string>): void => {
  for (const token of tokens) {
    if (token.type === 'image') {
      const { href } = token as Tokens.Image;
      if (isAttachmentSrc(href)) names.push(attachmentSrcName(href));
    } else if (token.type === 'html' && (token as Tokens.HTML).block) {
      const inner = SMALL_BLOCK.exec((token as Tokens.HTML).text.trim())?.[1];
      if (inner !== undefined) collect(lex(inner), names);
    } else if (token.type === 'list') {
      collect((token as Tokens.List).items, names);
    } else if (token.type === 'table') {
      const table = token as Tokens.Table;
      for (const cell of table.header) collect(cell.tokens, names);
      for (const row of table.rows)
        for (const cell of row) collect(cell.tokens, names);
    } else if ('tokens' in token && Array.isArray(token.tokens)) {
      collect(token.tokens, names);
    }
  }
};

const lex = (markdown: string): ReadonlyArray<Token> =>
  new Lexer({ gfm: true }).lex(markdown);

/**
 * The file names the body's `attachment:` images use, each once, in the
 * order the body first uses them. An image inside a code span or a fence is
 * code, not an image, so it names nothing.
 */
export const attachmentImageNames = (
  markdown: string,
): ReadonlyArray<string> => {
  const names: Array<string> = [];
  collect(lex(markdown), names);
  return [...new Set(names)];
};
