import { describe, expect, it } from 'vitest';
import { highlightCode } from '../src/code-highlight';

describe('highlightCode', () => {
  it('colours each diff line by its kind, escaping the source', () => {
    expect(highlightCode(' same\n-old <b>\n+new\n@@ -1 +1 @@', 'diff')).toBe(
      [
        ' same',
        '<span class="hljs-deletion">-old &lt;b&gt;</span>',
        '<span class="hljs-addition">+new</span>',
        '<span class="hljs-meta">@@ -1 +1 @@</span>',
      ].join('\n'),
    );
  });

  it('colours every language it names, in any case', () => {
    for (const lang of [
      'ts',
      'TypeScript',
      'json',
      'yaml',
      'yml',
      'sh',
      'bash',
      'shell',
      'zsh',
      'md',
      'markdown',
      'diff',
      'patch',
    ])
      expect(highlightCode('a', lang), lang).toBeDefined();
  });

  it('leaves any other language, and none, to the caller', () => {
    expect(highlightCode('x = 1', 'python')).toBeUndefined();
    expect(highlightCode('x = 1', 'javascript')).toBeUndefined();
    expect(highlightCode('x = 1', '')).toBeUndefined();
    expect(highlightCode('x = 1', undefined)).toBeUndefined();
  });

  it('never lets markup in the source through', () => {
    for (const lang of ['ts', 'json', 'yaml', 'sh', 'md', 'diff'])
      expect(highlightCode('<script>alert(1)</script>', lang)).not.toContain(
        '<script',
      );
  });
});
