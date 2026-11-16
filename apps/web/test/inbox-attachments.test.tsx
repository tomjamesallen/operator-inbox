import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A,
  answered,
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
    const other = screen.getByText('build log.txt').closest('a');
    expect(other?.getAttribute('href')).toBe(
      `/api/attachments/${A}/fedcba9876543210/build%20log.txt`,
    );
    expect(other?.getAttribute('title')).toBe(
      `${root}/fedcba9876543210/build log.txt`,
    );
  });
});
