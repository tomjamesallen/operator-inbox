import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GATEWAY_SENTENCE, MISMATCH_MESSAGE } from '../src/failure';
import { json } from './fixture';
import {
  A,
  B,
  board,
  box,
  footNote,
  items,
  litKey,
  mounted,
  note,
  openRail,
  openRowMenu,
  rail,
  send,
  serve,
  type,
  useInboxPage,
  VIEW_A,
  VIEW_B,
} from './inbox-page-harness';

// What the page's writes come to. Quarry holds one question, so a failed answer
// there comes back lit: nothing else is in the queue to flow on to. Flowing on
// and the strays are `inbox-reader.test.tsx`; a machine's words are
// `inbox-machines.test.tsx`.

useInboxPage();

const QUARRY = `/inbox/${B}`;

const answerIn = async (text: string): Promise<void> => {
  await mounted(QUARRY);
  type(text);
  send();
};

const backWith = async (sentence: string): Promise<void> => {
  await waitFor(() => expect(footNote()).toBe(sentence));
  expect(litKey()).toBe(`${B}/1`);
};

describe('an answer', () => {
  it('sends the revision it showed, and a refused answer keeps the text', async () => {
    const sentence =
      '#1 changed after you opened it; read it again before answering';
    serve.post = () => json({ _tag: 'AnswerRefused', message: sentence }, 409);
    await answerIn('Go with B');
    await backWith(`Not sent: ${sentence}.`);
    expect(serve.posts.map((p) => p.body)).toEqual([
      { response: 'Go with B', seenRevision: 1 },
    ]);
    expect(box().value).toBe('Go with B');
  });

  it('defers to the agent with or without a note', async () => {
    serve.post = () =>
      json({ _tag: 'AnswerRefused', message: 'stop here' }, 409);
    await mounted(QUARRY);
    const defer = () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'Leave it to the agent' }),
      );
    defer();
    await backWith('Not sent: stop here.');
    type('lean B');
    defer();
    await waitFor(() => expect(serve.posts).toHaveLength(2));
    expect(serve.posts.map((p) => p.body)).toEqual([
      { response: '', seenRevision: 1, deferred: true },
      { response: 'lean B', seenRevision: 1, deferred: true },
    ]);
  });

  it('says an answer whose request got no reply was not sent', async () => {
    serve.post = () => Promise.reject(new TypeError('Failed to fetch'));
    await answerIn('Yes');
    await backWith(
      'Not sent: operator-inbox serve did not reply. Is operator-inbox serve running?',
    );
  });

  it('says an answer a proxy answered for with a 504 is unconfirmed', async () => {
    serve.post = () => new Response(null, { status: 504 });
    await answerIn('Yes');
    await backWith(`Unconfirmed: ${GATEWAY_SENTENCE}`);
    expect(footNote()).not.toContain('Not sent');
  });

  it('says an answer that came back undecodable is unconfirmed', async () => {
    serve.post = () => json({ nonsense: true });
    await answerIn('Yes');
    await backWith(`Unconfirmed: ${MISMATCH_MESSAGE}`);
  });

  it('takes the reader to a failed answer’s question from a view without it', async () => {
    serve.post = () =>
      json({ _tag: 'AnswerRefused', message: 'too late' }, 409);
    await mounted();
    type('Yes');
    send();
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    await openRail();
    await waitFor(() => expect(note('answer')).not.toBeNull());
    const other = document.querySelector(
      `nav [data-rail-inbox="${B}"]`,
    ) as HTMLElement;
    fireEvent.click(other);
    await waitFor(() => expect(items()).toEqual([`${B}/1`]));
    await openRail();
    await waitFor(() => expect(note('answer')).not.toBeNull());
    fireEvent.click(within(note('answer') as HTMLElement).getByRole('button'));
    await waitFor(() => expect(litKey()).toBe(`${A}/1`));
  });

  it('lists a failed answer in the sidebar, as a link to its question', async () => {
    serve.post = () =>
      json({ _tag: 'AnswerRefused', message: 'too late' }, 409);
    await mounted();
    type('Yes');
    send();
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    await waitFor(() => expect(litKey()).toBe(`${A}/3`));
    await openRail();
    await waitFor(() => expect(note('answer')).not.toBeNull());
    fireEvent.click(within(note('answer') as HTMLElement).getByRole('button'));
    await waitFor(() => expect(litKey()).toBe(`${A}/1`));
    expect(box().value).toBe('Yes');
  });
});

describe('a rename', () => {
  const rename = async (): Promise<HTMLInputElement> => {
    await mounted();
    await openRail();
    await openRowMenu('orchard');
    fireEvent.click(await screen.findByRole('menuitem', { name: /Rename/ }));
    return (await screen.findByRole('textbox', {
      name: 'Inbox name',
    })) as HTMLInputElement;
  };

  const save = (field: HTMLInputElement, name: string): void => {
    fireEvent.change(field, { target: { value: name } });
    fireEvent.keyDown(field, { key: 'Enter' });
  };

  it('renames in place, and the row and the eyebrow take the new name', async () => {
    serve.post = () => {
      serve.board = board([{ ...VIEW_A, label: 'Markdown check' }, VIEW_B]);
      return json({ ...VIEW_A, label: 'Markdown check' });
    };
    const field = await rename();
    expect(field.value).toBe('orchard');
    save(field, 'Markdown check');
    await rail().findByRole('link', { name: 'Markdown check' });
    expect(serve.posts).toEqual([
      { path: `/api/inbox/${A}/rename`, body: { label: 'Markdown check' } },
    ]);
    expect(screen.queryByRole('textbox', { name: 'Inbox name' })).toBeNull();
    expect(document.querySelector('[data-zen-eyebrow]')?.textContent).toContain(
      'Markdown check',
    );
  });

  it('clears a failed rename’s outcome when the field is opened again', async () => {
    serve.post = () =>
      json({ _tag: 'RenameRefused', message: 'the name is taken' }, 409);
    const field = await rename();
    save(field, 'quarry');
    expect((await rail().findByRole('alert')).textContent).toBe(
      'Not renamed: the name is taken.',
    );
    fireEvent.keyDown(field, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Inbox name' })).toBeNull(),
    );
    await openRowMenu('orchard');
    fireEvent.click(await screen.findByRole('menuitem', { name: /Rename/ }));
    await screen.findByRole('textbox', { name: 'Inbox name' });
    expect(rail().queryByRole('alert')).toBeNull();
  });

  // The field's own line goes with the field, so a write that outlives it is
  // said in the sidebar's notes.
  it('runs a rename to its end when the field shuts, and says what it came to', async () => {
    const reply = vi.fn<(r: Response) => void>();
    serve.post = () =>
      new Promise<Response>((resolve) => reply.mockImplementation(resolve));
    const field = await rename();
    save(field, 'quarry');
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    fireEvent.keyDown(field, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Inbox name' })).toBeNull(),
    );
    await openRowMenu('orchard');
    fireEvent.click(await screen.findByRole('menuitem', { name: /Rename/ }));
    await screen.findByRole('textbox', { name: 'Inbox name' });
    reply(json({ _tag: 'RenameRefused', message: 'the name is taken' }, 409));
    await waitFor(() =>
      expect(note('stray')?.textContent).toContain(
        'Renaming orchard to “quarry” — Not renamed: the name is taken.',
      ),
    );
    expect(serve.posts).toHaveLength(1);
  });
});
