import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A,
  answered,
  asked,
  board,
  box,
  mounted,
  onQueue,
  press,
  serve,
  type,
  useInboxPage,
  VIEW_A,
  VIEW_B,
} from './inbox-page-harness';

// Files on an answer: `/attach` in the box's menu opens the picker, a drop
// over the box or a paste into it adds files too, each waits as a card in
// the strip under the box with its own ×, and the send carries them whole in
// the answer's request.
// A follow-up does the same. An answered card shows the files its answer
// carried: an image as a thumbnail read back from serve, anything else as
// its name.

useInboxPage();

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

const fileOf = (name: string, type: string, text: string) =>
  new File([text], name, { type });

const picker = (): HTMLInputElement =>
  document.querySelector('input[type="file"]') as HTMLInputElement;

const pick = (...files: ReadonlyArray<File>) =>
  fireEvent.change(picker(), { target: { files } });

const chips = (): ReadonlyArray<string> =>
  [...document.querySelectorAll('[data-zen-pending-file]')].map(
    (c) => c.querySelector('[data-zen-file-name]')?.textContent ?? '',
  );

const zone = (): HTMLElement =>
  document.querySelector('[data-zen-drop]') as HTMLElement;

const sendButton = () => screen.getByRole('button', { name: 'Send' });

const menu = () => document.querySelector<HTMLElement>('#macro-menu');

/** Types into the box as a person does: the value, the caret at its end. */
const typeBox = (text: string) => {
  const el = box();
  fireEvent.change(el, { target: { value: text } });
  el.setSelectionRange(text.length, text.length);
  fireEvent.select(el);
};

describe('attaching files to an answer', () => {
  it('opens the picker from /attach, which leaves the text as it was', async () => {
    await mounted(`/inbox/${A}`);
    const click = vi.spyOn(picker(), 'click');
    typeBox('See /att');
    await waitFor(() => expect(menu()).not.toBeNull());
    expect(
      screen
        .getAllByRole('option')
        .map((o) => o.querySelector('span')?.textContent),
    ).toEqual(['/attach']);
    press({ key: 'Enter', code: 'Enter' }, box());
    expect(click).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(menu()).toBeNull());
    expect(box().value).toBe('See ');
    expect(picker().multiple).toBe(true);
    pick(
      fileOf('shot.png', 'image/png', 'png'),
      fileOf('build.log', 'text/plain', 'log'),
    );
    await waitFor(() => expect(chips()).toEqual(['shot.png', 'build.log']));
  });

  it('opens the picker from /attach clicked in the menu of a follow-up', async () => {
    await mounted();
    await onQueue(/With the agent/);
    const click = vi.spyOn(picker(), 'click');
    typeBox('/');
    await waitFor(() => expect(menu()).not.toBeNull());
    fireEvent.mouseDown(screen.getByRole('option', { name: /\/attach/ }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(box().value).toBe('');
  });

  it('shows a drop zone while files are dragged over the box, and takes them on drop', async () => {
    await mounted(`/inbox/${A}`);
    const dataTransfer = {
      types: ['Files'],
      files: [fileOf('dropped.txt', 'text/plain', 'hi')],
      dropEffect: 'none',
    };
    fireEvent.dragEnter(zone(), { dataTransfer });
    await screen.findByText('Drop to attach');
    fireEvent.drop(zone(), { dataTransfer });
    await waitFor(() => expect(chips()).toEqual(['dropped.txt']));
    expect(screen.queryByText('Drop to attach')).toBeNull();
  });

  it('ignores a drag that carries no files', async () => {
    await mounted(`/inbox/${A}`);
    fireEvent.dragEnter(zone(), {
      dataTransfer: { types: ['text/plain'], files: [] },
    });
    expect(screen.queryByText('Drop to attach')).toBeNull();
  });

  it('attaches an image pasted into the box', async () => {
    await mounted(`/inbox/${A}`);
    fireEvent.paste(box(), {
      clipboardData: {
        files: [fileOf('image.png', 'image/png', 'png')],
        getData: () => '',
      },
    });
    await waitFor(() => expect(chips()).toEqual(['image.png']));
  });

  it('may be the whole answer, and the send carries each file whole', async () => {
    await mounted(`/inbox/${A}`);
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    pick(fileOf('note.txt', 'text/plain', 'hello'));
    await waitFor(() =>
      expect((sendButton() as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(sendButton());
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    expect(serve.posts[0]).toEqual({
      path: `/api/inbox/${A}/questions/1/answer`,
      body: {
        response: '',
        seenRevision: 1,
        attachments: [
          { name: 'note.txt', type: 'text/plain', data: btoa('hello') },
        ],
      },
    });
  });

  it('carries files on a follow-up, and clears them once it lands', async () => {
    await mounted();
    await onQueue(/With the agent/);
    type('See the log');
    pick(fileOf('trace.log', 'text/plain', 'boom'));
    await waitFor(() => expect(chips()).toEqual(['trace.log']));
    fireEvent.click(sendButton());
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    expect(serve.posts[0]?.path).toBe(`/api/inbox/${A}/questions`);
    expect(serve.posts[0]?.body).toMatchObject({
      attachments: [
        { name: 'trace.log', type: 'text/plain', data: btoa('boom') },
      ],
    });
    await waitFor(() => expect(chips()).toEqual([]));
  });
});

describe('a file waiting to be sent', () => {
  it('is a card in the same strip as the comments and macros, and comes off with its ×', async () => {
    serve.macros = JSON.stringify({
      macros: [
        {
          name: 'park',
          description: 'Park this thread',
          instruction: 'Stop work on this thread until asked.',
          params: [],
        },
      ],
    });
    await mounted(`/inbox/${A}`);
    typeBox('/park');
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: /\/park/ })).not.toBeNull(),
    );
    press({ key: 'Enter', code: 'Enter' }, box());
    await waitFor(() =>
      expect(document.querySelector('[data-macro-card]')).not.toBeNull(),
    );
    pick(
      fileOf('shot.png', 'image/png', 'png'),
      fileOf('build.log', 'text/plain', 'log'),
    );
    await waitFor(() => expect(chips()).toEqual(['shot.png', 'build.log']));
    // One strip: the macro's card, then the files' cards, side by side.
    const strips = document.querySelectorAll('[data-macro-cards]');
    expect(strips).toHaveLength(1);
    const strip = strips[0] as HTMLElement;
    expect(strip.querySelector('[data-macro-card]')).not.toBeNull();
    const files = strip.querySelectorAll('[data-zen-pending-file]');
    expect(files).toHaveLength(2);
    expect(files[0]?.getAttribute('aria-label')).toBe('/attach shot.png');
    expect(files[0]?.querySelector('img')?.getAttribute('src')).toBe(
      'blob:preview',
    );
    expect(files[1]?.querySelector('img')).toBeNull();
    expect(files[1]?.textContent).toContain('3 B');
    fireEvent.click(screen.getByRole('button', { name: 'Remove shot.png' }));
    await waitFor(() => expect(chips()).toEqual(['build.log']));
  });

  it('has a strip of its own under a follow-up', async () => {
    await mounted();
    await onQueue(/With the agent/);
    pick(fileOf('trace.log', 'text/plain', 'boom'));
    await waitFor(() => expect(chips()).toEqual(['trace.log']));
    expect(
      document
        .querySelector('[data-zen-pending-file]')
        ?.closest('[data-macro-cards]'),
    ).not.toBeNull();
  });

  it('leaves no Attach link under the box', async () => {
    await mounted(`/inbox/${A}`);
    expect(screen.queryByRole('button', { name: 'Attach' })).toBeNull();
    expect(document.querySelector('[data-zen-attach]')).toBeNull();
  });
});

describe('an answered card with files', () => {
  it('shows an image as a thumbnail from serve, and any other file by name', async () => {
    const root = `/state/operator-inbox/attachments/${A}`;
    serve.board = board([
      {
        ...VIEW_A,
        awaitingAgent: [
          {
            ...answered(2, 'Second', 12, ''),
            attachments: [
              {
                path: `${root}/0123456789abcdef/shot.png`,
                name: 'shot.png',
                type: 'image/png',
                bytes: 2048,
              },
              {
                path: `${root}/fedcba9876543210/build log.txt`,
                name: 'build log.txt',
                type: 'text/plain',
                bytes: 12,
              },
            ],
          },
        ],
      },
      VIEW_B,
    ]);
    await mounted(`/inbox/${A}`);
    await onQueue(/With the agent/);
    const img = await screen.findByRole('img', { name: 'shot.png' });
    expect(img.getAttribute('src')).toBe(
      `/api/attachments/${A}/0123456789abcdef/shot.png`,
    );
    // The thumbnail opens the image over the page, never in place of it.
    expect(img.closest('a')).toBeNull();
    const other = screen.getByText('build log.txt').closest('a');
    expect(other?.getAttribute('href')).toBe(
      `/api/attachments/${A}/fedcba9876543210/build%20log.txt`,
    );
    expect(other?.getAttribute('title')).toBe(
      `${root}/fedcba9876543210/build log.txt`,
    );
  });
});

describe('an attached image in its lightbox', () => {
  const SHOT = {
    path: `/state/operator-inbox/attachments/${A}/0123456789abcdef/shot.png`,
    name: 'shot.png',
    type: 'image/png',
    bytes: 2048,
  };
  const URL_OF_SHOT = `/api/attachments/${A}/0123456789abcdef/shot.png`;
  const lightbox = () => document.querySelector('[data-zen-lightbox]');

  const showing = async () => {
    serve.board = board([
      {
        ...VIEW_A,
        awaitingAgent: [
          { ...answered(2, 'Second', 12, 'See'), attachments: [SHOT] },
        ],
      },
      VIEW_B,
    ]);
    await mounted(`/inbox/${A}`);
    await onQueue(/With the agent/);
    return screen.findByRole('button', { name: 'Show shot.png' });
  };

  it('opens over the page from the thumbnail, and Escape closes it, the URL unchanged', async () => {
    const thumbnail = await showing();
    const before = location.href;
    fireEvent.click(thumbnail);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('shot.png');
    expect(lightbox()?.querySelector('img')?.getAttribute('src')).toBe(
      URL_OF_SHOT,
    );
    const original = screen.getByRole('link', { name: 'Open original' });
    expect(original.getAttribute('href')).toBe(URL_OF_SHOT);
    expect(original.getAttribute('target')).toBe('_blank');
    expect(location.href).toBe(before);
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(location.href).toBe(before);
  });

  it('closes from its CLOSE button, and from a click beside the image', async () => {
    fireEvent.click(await showing());
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'CLOSE' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Show shot.png' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Close shot.png' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('an agent’s question with its own files', () => {
  const root = `/state/operator-inbox/attachments/${A}`;
  const SHOT = {
    path: `${root}/0123456789abcdef/shot.png`,
    name: 'shot.png',
    type: 'image/png',
    bytes: 2048,
  };
  const DETAIL = {
    path: `${root}/abcdef0123456789/detail.png`,
    name: 'detail.png',
    type: 'image/png',
    bytes: 1024,
  };
  const LOG = {
    path: `${root}/fedcba9876543210/run.log`,
    name: 'run.log',
    type: 'text/plain',
    bytes: 16,
  };
  const URL_OF_SHOT = `/api/attachments/${A}/0123456789abcdef/shot.png`;
  const URL_OF_DETAIL = `/api/attachments/${A}/abcdef0123456789/detail.png`;
  // The body as serve renders it (core's `renderQuestionMarkdown`), its
  // `attachment:shot.png` image resolved and marked.
  const inline = `<p>Look:</p>\n<p><img src="${URL_OF_SHOT}" alt="the page" loading="lazy" data-attachment-image="shot.png" role="button" tabindex="0" aria-haspopup="dialog"></p>\n`;
  const lightbox = () => document.querySelector('[data-zen-lightbox]');
  const strip = () => document.querySelector('[data-zen-attachments]');

  // The Question is #3, after #1, so it is not the lit one.
  const showing = async (
    attachments: ReadonlyArray<typeof SHOT> = [SHOT, DETAIL, LOG],
  ) => {
    serve.board = board([
      {
        ...VIEW_A,
        awaitingOperator: [
          asked(1, 'First', 2),
          {
            ...asked(3, 'Does it look right?', 9),
            body: 'Look:\n\n![the page](attachment:shot.png)',
            bodyHtml: inline,
            bodyParts: [{ kind: 'html', html: inline }],
            bodyImages: ['shot.png'],
            askedAttachments: attachments,
          },
        ],
      },
      VIEW_B,
    ]);
    await mounted(`/inbox/${A}`);
    return screen.findByRole('button', { name: 'the page' });
  };

  const card = (image: HTMLElement) => image.closest('article') as HTMLElement;

  it('shows the files the body does not place under it: an image as a thumbnail, a file by name', async () => {
    await showing();
    const thumbnail = await screen.findByRole('button', {
      name: 'Show detail.png',
    });
    const list = thumbnail.closest('[data-zen-attachments]');
    const body = document.querySelector('[data-readout-body]');
    if (list === null || body === null) throw new Error('no list or body');
    // The list comes after the body.
    expect(
      body.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const other = screen.getByText('run.log').closest('a');
    expect(other?.getAttribute('href')).toBe(
      `/api/attachments/${A}/fedcba9876543210/run.log`,
    );
    fireEvent.click(thumbnail);
    await screen.findByRole('dialog');
    expect(lightbox()?.querySelector('img')?.getAttribute('src')).toBe(
      URL_OF_DETAIL,
    );
  });

  it('leaves the image the body shows in place out of the strip', async () => {
    await showing();
    await screen.findByRole('button', { name: 'Show detail.png' });
    expect(screen.queryByRole('button', { name: 'Show shot.png' })).toBeNull();
    expect(
      [...(strip()?.querySelectorAll('li') ?? [])].map((li) => li.textContent),
    ).toEqual(['', 'run.log16 B']);
  });

  it('has no strip when the body shows every file in place', async () => {
    await showing([SHOT]);
    expect(strip()).toBeNull();
  });

  it('shows an image the body names in place', async () => {
    const image = await showing();
    expect(image.getAttribute('src')).toBe(URL_OF_SHOT);
    expect(image.closest('[data-readout-body]')).not.toBeNull();
  });

  it('opens the image in place in the lightbox on a click, without lighting its card', async () => {
    const image = await showing();
    expect(card(image).hasAttribute('data-zen-lit')).toBe(false);
    const before = location.href;
    fireEvent.click(image);
    const dialog = await screen.findByRole('dialog');
    expect(card(image).hasAttribute('data-zen-lit')).toBe(false);
    expect(within(dialog).getByText('shot.png')).toBeDefined();
    expect(lightbox()?.querySelector('img')?.getAttribute('src')).toBe(
      URL_OF_SHOT,
    );
    const original = screen.getByRole('link', { name: 'Open original' });
    expect(original.getAttribute('href')).toBe(URL_OF_SHOT);
    expect(original.getAttribute('target')).toBe('_blank');
    expect(location.href).toBe(before);
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(location.href).toBe(before);
  });

  it('closes from its CLOSE button, and from a click beside the image', async () => {
    const image = await showing();
    fireEvent.click(image);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'CLOSE' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(image);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Close shot.png' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens the image in place from the keyboard, on Enter or Space', async () => {
    const image = await showing();
    expect(image.tabIndex).toBe(0);
    for (const key of ['Enter', ' ']) {
      image.focus();
      const pressed = fireEvent.keyDown(image, { key, code: key });
      // The key is the image's: the page does not scroll, and no shortcut runs.
      expect(pressed).toBe(false);
      const dialog = await screen.findByRole('dialog');
      expect(lightbox()?.querySelector('img')?.getAttribute('src')).toBe(
        URL_OF_SHOT,
      );
      fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
    expect(card(image).hasAttribute('data-zen-lit')).toBe(false);
  });

  it('opens nothing for another key on the image', async () => {
    const image = await showing();
    image.focus();
    fireEvent.keyDown(image, { key: 'a', code: 'KeyA' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // A click in the lightbox is the lightbox's: React would carry it back
  // through the portal to the card's article and light the card.
  describe('a click in the lightbox leaves the card under it unlit', () => {
    const openers = [
      [
        'the image in place',
        () => screen.getByRole('button', { name: 'the page' }),
      ],
      [
        'a thumbnail',
        () => screen.getByRole('button', { name: 'Show detail.png' }),
      ],
    ] as const;
    const backdrop = () =>
      document.querySelector<HTMLElement>('[data-zen-lightbox-backdrop]');
    // A press as a pointer makes it: down, up, then the click.
    const pressOn = (el: Element) => {
      fireEvent.pointerDown(el);
      fireEvent.mouseDown(el);
      fireEvent.pointerUp(el);
      fireEvent.mouseUp(el);
      fireEvent.click(el);
    };

    for (const [from, opener] of openers) {
      it(`on CLOSE, opened from ${from}`, async () => {
        const image = await showing();
        fireEvent.click(opener());
        await screen.findByRole('dialog');
        pressOn(screen.getByRole('button', { name: 'CLOSE' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(card(image).hasAttribute('data-zen-lit')).toBe(false);
      });

      it(`on the backdrop, opened from ${from}`, async () => {
        const image = await showing();
        fireEvent.click(opener());
        await screen.findByRole('dialog');
        const ground = backdrop();
        if (ground === null) throw new Error('no backdrop');
        pressOn(ground);
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(card(image).hasAttribute('data-zen-lit')).toBe(false);
      });

      it(`inside the popup, opened from ${from}`, async () => {
        const image = await showing();
        fireEvent.click(opener());
        const dialog = await screen.findByRole('dialog');
        // Its title, and "Open original", whose link still opens the file.
        pressOn(within(dialog).getByRole('heading'));
        const original = screen.getByRole('link', { name: 'Open original' });
        pressOn(original);
        expect(original.getAttribute('href')).toMatch(/^\/api\/attachments\//);
        expect(screen.queryByRole('dialog')).not.toBeNull();
        // Beside the image, which closes it.
        pressOn(within(dialog).getByRole('button', { name: /^Close / }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(card(image).hasAttribute('data-zen-lit')).toBe(false);
      });
    }
  });
});
