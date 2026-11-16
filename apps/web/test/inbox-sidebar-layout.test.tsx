import { RegistryProvider, useAtomSet } from '@effect/atom-react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InboxPage } from '../src/components/inbox/page';
import { railMeasureAtom } from '../src/inbox-rail';
import {
  A,
  aside,
  burger,
  litKey,
  railShut,
  useInboxPage,
} from './inbox-page-harness';

// The sidebar sits over the page and never moves the question. jsdom lays nothing
// out, so this holds what it can see: the sidebar is outside the reader's tree,
// in a fixed layer, and no state of it changes a class, an element or a scroll
// anywhere from the reader up. Where the question is drawn in pixels is for the
// browser.

useInboxPage();

const WIDE = { room: 400, pushRoom: 300, design: 327, viewport: 1600 };

const Measure = () => {
  const measure = useAtomSet(railMeasureAtom);
  return (
    <button type="button" onClick={() => measure(WIDE)}>
      wide
    </button>
  );
};

const mount = async (): Promise<void> => {
  history.replaceState(null, '', `/inbox/${A}`);
  render(
    <RegistryProvider>
      <InboxPage />
      <Measure />
    </RegistryProvider>,
  );
  await waitFor(() => expect(litKey()).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: 'wide' }));
};

const reader = (): HTMLElement =>
  document.querySelector('main[data-inbox-reader]') as HTMLElement;

const flow = (): HTMLElement =>
  document.querySelector('[data-zen-flow]') as HTMLElement;

// Every class from the question's flow up to the document, and the flow's own
// inline style, as a string to compare between states.
const frame = (): string => {
  const chain: Array<string> = [flow().getAttribute('style') ?? ''];
  for (let e: Element | null = flow(); e !== null; e = e.parentElement)
    chain.push(`${e.tagName}.${e.className}`);
  return chain.join(' < ');
};

const railIs = (state: string) =>
  waitFor(() => expect(aside()?.dataset.inboxSidebar).toBe(state));

describe('the sidebar never moves the question', () => {
  it('sits in a fixed layer beside the reader, never around it', async () => {
    await mount();
    fireEvent.click(burger());
    await waitFor(() => expect(aside()).not.toBeNull());
    const sidebar = aside() as HTMLElement;
    expect(sidebar.contains(reader())).toBe(false);
    expect(reader().contains(sidebar)).toBe(false);
    const layer = sidebar.closest('[data-rail-layer]');
    expect(layer?.className).toContain('fixed');
    expect(layer?.contains(reader())).toBe(false);
  });

  // A sticky breadcrumb inside the reader carries the sidebar's own z-20, and
  // the later one wins a tie. The reader is its own stacking context, so no
  // `z-` inside it can rise above the sidebar's layer, whatever its number.
  it('keeps the reader in a stacking layer of its own, under the sidebar', async () => {
    await mount();
    fireEvent.click(burger());
    await waitFor(() => expect(aside()).not.toBeNull());
    expect(reader().className.split(' ')).toContain('isolate');
    const layer = aside()?.closest('[data-rail-layer]');
    expect(layer?.className).toMatch(/(^| )z-\d+( |$)/);
  });

  it('keeps the same element, classes, scroll and lit question in every state', async () => {
    await mount();
    const element = flow();
    const before = frame();
    const scroller = reader().querySelector<HTMLElement>('[data-zen-flow]');
    if (scroller === null) throw new Error('no flow');
    scroller.scrollTop = 120;
    const scrollTo = Element.prototype.scrollTo as unknown as {
      mockClear: () => void;
      mock: { calls: ReadonlyArray<unknown> };
    };
    await act(async () => {});
    scrollTo.mockClear();
    const still = () => {
      expect(flow()).toBe(element);
      expect(frame()).toBe(before);
      expect(scroller.scrollTop).toBe(120);
      expect(litKey()).toBe(`${A}/1`);
      expect(scrollTo.mock.calls).toEqual([]);
    };
    still();
    // Shut, to a peek by the burger's hover.
    fireEvent.mouseEnter(burger());
    await railIs('peeking');
    still();
    // Peek to pin, which fits at this width.
    fireEvent.click(burger());
    await railIs('docked');
    still();
    fireEvent.click(burger());
    await railShut();
    still();
  });

  // The question's code is inside the flow, so `frame` does not see it. Over
  // the page the sidebar is passing, and the code keeps its place; pinned, the
  // sidebar holds the gutter, and the code goes back to the eyebrow.
  it('moves the question’s code only for a pin, never for a peek or a drawer', async () => {
    await mount();
    const code = () => {
      const el = document.querySelector<HTMLElement>(
        '[data-zen-flow] [data-question-code-place]',
      );
      if (el === null) throw new Error('no code');
      return el;
    };
    const look = () => ({
      place: code().dataset.questionCodePlace,
      classes: code().className,
    });
    const shut = look();
    const shutFrame = frame();
    expect(shut.place).toBe('gutter');
    fireEvent.mouseEnter(burger());
    await railIs('peeking');
    expect(look()).toEqual(shut);
    expect(frame()).toBe(shutFrame);
    fireEvent.focus(screen.getByLabelText('Search inboxes and groups'));
    await railIs('drawer');
    expect(look()).toEqual(shut);
    expect(frame()).toBe(shutFrame);
    fireEvent.click(screen.getByLabelText('Close the inbox sidebar'));
    await railShut();
    fireEvent.click(burger());
    await railIs('docked');
    expect(look().place).toBe('eyebrow');
    expect(look().classes).not.toBe(shut.classes);
    fireEvent.click(burger());
    await railShut();
    expect(look()).toEqual(shut);
  });
});
