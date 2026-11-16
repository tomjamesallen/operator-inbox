import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A,
  answered,
  asked,
  B,
  board,
  box,
  mounted,
  onQueue,
  serve,
  type,
  useInboxPage,
  VIEW_A,
  VIEW_B,
} from './inbox-page-harness';

// Files on an answer: the "Attach" link under the box opens the picker, a
// drop over the box or a paste into it adds files too, each waits as a chip
// with its own ×, and the send carries them whole in the answer's request.
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
    (c) => c.querySelector('.truncate')?.textContent ?? '',
  );

const zone = (): HTMLElement =>
  document.querySelector('[data-zen-drop]') as HTMLElement;

const sendButton = () => screen.getByRole('button', { name: 'Send' });

describe('attaching files to an answer', () => {
  it('opens the picker from the link, shows a chip per file, and takes one off', async () => {
    await mounted(`/inbox/${A}`);
    const click = vi.spyOn(picker(), 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    expect(click).toHaveBeenCalled();
    pick(
      fileOf('shot.png', 'image/png', 'png'),
      fileOf('build.log', 'text/plain', 'log'),
    );
    await waitFor(() => expect(chips()).toEqual(['shot.png', 'build.log']));
    fireEvent.click(screen.getByRole('button', { name: 'Remove shot.png' }));
    await waitFor(() => expect(chips()).toEqual(['build.log']));
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

describe('the attach line', () => {
  it('keeps its place under a box that takes no files, with the link hidden', async () => {
    await mounted(`/inbox/${B}`);
    expect(document.querySelector('[data-zen-attach]')).not.toBeNull();
    expect(document.querySelector('[data-zen-attach-space]')).toBeNull();
    // Quarry has nothing with the agent, so the box there takes nothing.
    await onQueue(/With the agent/);
    await waitFor(() =>
      expect(document.querySelector('[data-zen-attach]')).toBeNull(),
    );
    const space = document.querySelector('[data-zen-attach-space]');
    expect(space?.className).toContain('invisible');
    expect(space?.getAttribute('aria-hidden')).toBe('true');
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
  const LOG = {
    path: `${root}/fedcba9876543210/run.log`,
    name: 'run.log',
    type: 'text/plain',
    bytes: 16,
  };
  const URL_OF_SHOT = `/api/attachments/${A}/0123456789abcdef/shot.png`;
  // The body as serve renders it, its `attachment:shot.png` image resolved.
  const inline = `<p>Look:</p>\n<p><img src="${URL_OF_SHOT}" alt="the page" loading="lazy" data-attachment-image></p>\n`;

  const showing = async () => {
    serve.board = board([
      {
        ...VIEW_A,
        awaitingOperator: [
          {
            ...asked(1, 'Does it look right?', 2),
            body: 'Look:\n\n![the page](attachment:shot.png)',
            bodyHtml: inline,
            bodyParts: [{ kind: 'html', html: inline }],
            askedAttachments: [SHOT, LOG],
          },
        ],
      },
      VIEW_B,
    ]);
    await mounted(`/inbox/${A}`);
  };

  it('shows them under the body: an image as a thumbnail that opens in the lightbox, a file by name', async () => {
    await showing();
    const thumbnail = await screen.findByRole('button', {
      name: 'Show shot.png',
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
    const before = location.href;
    fireEvent.click(thumbnail);
    await screen.findByRole('dialog');
    expect(
      document
        .querySelector('[data-zen-lightbox]')
        ?.querySelector('img')
        ?.getAttribute('src'),
    ).toBe(URL_OF_SHOT);
    expect(location.href).toBe(before);
  });

  it('shows an image the body names in place', async () => {
    await showing();
    const img = await screen.findByRole('img', { name: 'the page' });
    expect(img.getAttribute('src')).toBe(URL_OF_SHOT);
    expect(img.closest('[data-readout-body]')).not.toBeNull();
  });
});
