import { describe, expect, it } from '@effect/vitest';
import {
  type Attachment,
  attachmentImageNames,
  imageAttachmentNamed,
  renderedQuestionBody,
  renderQuestionMarkdown,
} from '../src';

// The files a body shows in place: the names its `attachment:` images use,
// read from the markdown, and the `<img>` the renderer marks for each, which
// the page opens in its lightbox.

const file = (name: string, type = 'image/png', hash = 'h'): Attachment => ({
  path: `/state/attachments/i/${hash}/${name}`,
  name,
  type,
  bytes: 10,
});

const url = (name: string) => `/api/attachments/i/h/${name}`;

// The names the rendered HTML marks, in order: what the page finds.
const marked = (html: string): ReadonlyArray<string> =>
  [...html.matchAll(/data-attachment-image="([^"]*)"/g)].map((m) =>
    (m[1] ?? '').replaceAll('&amp;', '&'),
  );

describe('the names a body’s attachment images use', () => {
  it('is none for a body with no attachment image', () => {
    expect(attachmentImageNames('')).toStrictEqual([]);
    expect(
      attachmentImageNames('Plain text, ![web](https://x.test/a.png).'),
    ).toStrictEqual([]);
  });

  it('is each name once, in the order the body first uses it', () => {
    expect(
      attachmentImageNames(
        [
          '![b](attachment:b.png) and ![a](attachment:a.png)',
          '',
          '![b again](attachment:b.png)',
        ].join('\n'),
      ),
    ).toStrictEqual(['b.png', 'a.png']);
  });

  it('decodes a percent-encoded name, and reads one in angle brackets', () => {
    expect(
      attachmentImageNames(
        '![a](attachment:my%20shot.png)\n\n![b](<attachment:other shot.png>)',
      ),
    ).toStrictEqual(['my shot.png', 'other shot.png']);
  });

  it('takes the scheme in any case', () => {
    expect(attachmentImageNames('![a](ATTACHMENT:a.png)')).toStrictEqual([
      'a.png',
    ]);
  });

  it('finds an image in a list, a table, a quote, a link and a <small> block', () => {
    const body = [
      '- ![l](attachment:list.png)',
      '',
      '| x |',
      '| - |',
      '| ![t](attachment:table.png) |',
      '',
      '> ![q](attachment:quote.png)',
      '',
      '[![k](attachment:link.png)](https://x.test)',
      '',
      '<small>',
      '![s](attachment:small.png)',
      '</small>',
    ].join('\n');
    expect(attachmentImageNames(body)).toStrictEqual([
      'list.png',
      'table.png',
      'quote.png',
      'link.png',
      'small.png',
    ]);
  });

  it('names nothing for an image in a code span or a fence', () => {
    expect(
      attachmentImageNames(
        '`![c](attachment:span.png)`\n\n```\n![f](attachment:fence.png)\n```',
      ),
    ).toStrictEqual([]);
  });

  it('agrees with the images the renderer marks', () => {
    const body = [
      'Intro ![a](attachment:a.png)',
      '',
      '- ![b](attachment:b%26c.png)',
      '',
      '<small>',
      '![s](attachment:s.png)',
      '</small>',
      '',
      '`![x](attachment:x.png)`',
    ].join('\n');
    expect(marked(renderQuestionMarkdown(body, url))).toStrictEqual(
      attachmentImageNames(body),
    );
  });
});

describe('the files a body shows in place', () => {
  it('is the first image of a name, and never a file that is not an image', () => {
    const shot = file('shot.png');
    const again = file('shot.png', 'image/png', 'h2');
    const log = file('run.log', 'text/plain');
    expect(imageAttachmentNamed([log, shot, again], 'shot.png')).toBe(shot);
    expect(imageAttachmentNamed([log], 'run.log')).toBeUndefined();
    expect(imageAttachmentNamed([shot], 'gone.png')).toBeUndefined();
  });

  it('is named beside the rendered body: each name the resolver drew', () => {
    const images = (name: string) =>
      name === 'a.png' || name === 'b.png' ? url(name) : undefined;
    expect(
      renderedQuestionBody(
        '![b](attachment:b.png) ![x](attachment:run.log) ![a](attachment:a.png) ![b](attachment:b.png)',
        images,
      ).bodyImages,
    ).toStrictEqual(['b.png', 'a.png']);
  });

  it('is left out when the body draws none, or with no resolver', () => {
    expect('bodyImages' in renderedQuestionBody('Plain', url)).toBe(false);
    expect(
      'bodyImages' in
        renderedQuestionBody('![gone](attachment:x.png)', () => undefined),
    ).toBe(false);
    expect('bodyImages' in renderedQuestionBody('![a](attachment:a.png)')).toBe(
      false,
    );
  });
});

describe('an attachment image in the rendered body', () => {
  it('carries its name, and is a focusable button that opens a dialog', () => {
    expect(
      renderQuestionMarkdown('![the page](attachment:my%20shot.png)', url),
    ).toBe(
      '<p><img src="/api/attachments/i/h/my shot.png" alt="the page" loading="lazy" data-attachment-image="my shot.png" role="button" tabindex="0" aria-haspopup="dialog"></p>\n',
    );
  });

  it('is named for its file when it has no alt text', () => {
    expect(renderQuestionMarkdown('![](attachment:shot.png)', url)).toContain(
      'alt="" loading="lazy" data-attachment-image="shot.png" role="button" tabindex="0" aria-haspopup="dialog" aria-label="Show shot.png">',
    );
  });

  it('escapes the name it carries', () => {
    const html = renderQuestionMarkdown(
      '![](<attachment:a"><script>.png>)',
      () => '/x',
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain(
      'data-attachment-image="a&quot;&gt;&lt;script&gt;.png"',
    );
  });

  it('is the link’s, not a button, inside a link’s anchor', () => {
    const html = renderQuestionMarkdown(
      '[![a](attachment:shot.png)](https://x.test)',
      url,
    );
    expect(html).toContain('data-attachment-image="shot.png">');
    expect(html).not.toContain('role="button"');
    // A link that is not an anchor leaves the image a button.
    expect(
      renderQuestionMarkdown('[![a](attachment:shot.png)](ftp://x)', url),
    ).toContain('role="button"');
  });

  it('marks no other image', () => {
    expect(
      renderQuestionMarkdown('![w](https://x.test/a.png)', url),
    ).not.toContain('data-attachment-image');
  });
});
