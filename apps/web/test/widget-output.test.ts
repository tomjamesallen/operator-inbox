import { describe, expect, it } from 'vitest';
import { ansiLines, readWidgetOutput } from '../src/widget-output';

// A widget's stdout, read in each format: ANSI SGR onto the theme's classes
// for `text`, and the envelope for `json`.

const ESC = '\x1b';

describe('text', () => {
  it('reads each line, with no trailing blank line', () => {
    const out = readWidgetOutput('load 0.42\ndisk 61%\n\n', 'text');
    expect(out.lines.map((l) => l.map((s) => s.text).join(''))).toEqual([
      'load 0.42',
      'disk 61%',
    ]);
    expect(out.tone).toBeUndefined();
    expect(out.note).toBeUndefined();
  });

  it('maps SGR colours and styles onto the theme', () => {
    const [line] = ansiLines(
      `${ESC}[1;31mfail${ESC}[0m ok ${ESC}[92mgreen${ESC}[39m ${ESC}[2;3;4mquiet${ESC}[m`,
    );
    expect(line).toEqual([
      { text: 'fail', cls: 'text-red font-bold' },
      { text: ' ok ', cls: '' },
      { text: 'green', cls: 'text-green' },
      { text: ' ', cls: '' },
      { text: 'quiet', cls: 'opacity-60 italic underline' },
    ]);
  });

  it('carries a style over a line break, as a terminal does', () => {
    const lines = ansiLines(`${ESC}[33mone\ntwo${ESC}[0m\nthree`);
    expect(lines).toEqual([
      [{ text: 'one', cls: 'text-yellow' }],
      [{ text: 'two', cls: 'text-yellow' }],
      [{ text: 'three', cls: '' }],
    ]);
  });

  it('drops 256 and true colour, keeping the text after them', () => {
    const [line] = ansiLines(
      `${ESC}[38;5;208ma${ESC}[38;2;10;20;30;1mb${ESC}[38:5:208mc`,
    );
    expect(line).toEqual([
      { text: 'a', cls: '' },
      { text: 'b', cls: 'font-bold' },
      { text: 'c', cls: 'font-bold' },
    ]);
  });

  it('drops every other escape and control character', () => {
    const [line] = ansiLines(
      `${ESC}[2K${ESC}[?25l${ESC}]8;;https://example.com\x07link${ESC}]8;;\x07${ESC}(B\x07a\bb\tc`,
    );
    expect(line?.map((s) => s.text).join('')).toBe('linkab\tc');
  });

  it('reads a carriage return as a line break', () => {
    expect(ansiLines('a\r\nb\rc').map((l) => l[0]?.text)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('json', () => {
  it('reads the text, then the detail, with the tone', () => {
    const out = readWidgetOutput(
      JSON.stringify({ text: '41 of 100', tone: 'warn', detail: 'a\nb' }),
      'json',
    );
    expect(out.lines.map((l) => l[0]?.text)).toEqual(['41 of 100', 'a', 'b']);
    expect(out.tone).toBe('warn');
    expect(out.note).toBeUndefined();
  });

  it('reads SGR inside the text and the detail', () => {
    const out = readWidgetOutput(
      JSON.stringify({ text: `${ESC}[32mup${ESC}[0m` }),
      'json',
    );
    expect(out.lines).toEqual([[{ text: 'up', cls: 'text-green' }]]);
  });

  it('notes a tone it does not know, and draws the text without one', () => {
    const out = readWidgetOutput(
      JSON.stringify({ text: 'x', tone: 'purple' }),
      'json',
    );
    expect(out.tone).toBeUndefined();
    expect(out.note).toBe('unknown tone "purple"');
  });

  it('shows output that is not JSON as plain text, with a note', () => {
    const out = readWidgetOutput(`${ESC}[31mnot json${ESC}[0m\nat all`, 'json');
    expect(out.lines).toEqual([
      [{ text: 'not json', cls: '' }],
      [{ text: 'at all', cls: '' }],
    ]);
    expect(out.tone).toBe('bad');
    expect(out.note).toBe('not JSON: shown as plain text');
  });

  it('shows an envelope with no text as plain text, with a note', () => {
    const raw = JSON.stringify({ used: 41, of: 100 });
    const out = readWidgetOutput(raw, 'json');
    expect(out.lines).toEqual([[{ text: raw, cls: '' }]]);
    expect(out.note).toBe('no "text": shown as plain text');
  });

  it('shows a JSON value that is not an object as plain text', () => {
    expect(readWidgetOutput('[1, 2]', 'json').note).toBe(
      'not a JSON object: shown as plain text',
    );
  });

  it('leaves out a detail that is not text, and says so', () => {
    const out = readWidgetOutput(
      JSON.stringify({ text: 'x', detail: 3 }),
      'json',
    );
    expect(out.lines).toHaveLength(1);
    expect(out.note).toBe('"detail" is not text, so it is left out');
  });
});
