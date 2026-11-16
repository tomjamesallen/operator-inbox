// Syntax colouring for a fenced code block in an inbox question's
// server-rendered body (`question-markdown.ts`). Pure: source and language in,
// HTML out, synchronous.
//
// highlight.js's core is loaded with only the grammars below, so a fence in
// any other language, or with none, stays plain code. What it returns escapes the
// source itself, and its only markup is `<span class="hljs-…">`, which the
// page styles from the body's container (apps/web `index.css`).

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import diff from 'highlight.js/lib/languages/diff';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import typescript from 'highlight.js/lib/languages/typescript';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('diff', diff);

// A fence's language, as written, to the grammar that colours it. A name not
// here is not coloured, even if a loaded grammar would claim it as an alias.
const GRAMMAR: Readonly<Record<string, string>> = {
  ts: 'typescript',
  typescript: 'typescript',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'bash',
  bash: 'bash',
  shell: 'bash',
  zsh: 'bash',
  md: 'markdown',
  markdown: 'markdown',
  diff: 'diff',
  patch: 'diff',
};

/**
 * The fence body as coloured HTML, or `undefined` when its language is not
 * one this colours (the caller then renders it as plain escaped code).
 */
export const highlightCode = (
  code: string,
  lang: string | undefined,
): string | undefined => {
  const grammar = GRAMMAR[(lang ?? '').trim().toLowerCase()];
  if (grammar === undefined) return undefined;
  return hljs.highlight(code, { language: grammar, ignoreIllegals: true })
    .value;
};
