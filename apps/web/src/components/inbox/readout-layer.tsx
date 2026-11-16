import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react';
import type { ReadoutReady } from '@operator-inbox/core/api';
import { Atom } from 'effect/reactivity';
import { useContext, useEffect, useState } from 'react';
import type { ReaderItem } from '../../inbox-reader';
import { follow, followHandsOffAtom } from '../../readout/follow';
import {
  type Box,
  boxesOf,
  cursorAt,
  drawnBoxOf,
  locate,
  rangeOf,
  seekTargetAt,
  sentenceOf,
} from '../../readout/locate';
import {
  litReadyAtom,
  playerSnapshotAtom,
  playerStateAtom,
  readoutTimeAtom,
  seekAtom,
} from '../../readout/readout';
import type { Script, Segment } from '../../readout/script';

// The reading cursor over the lit Question while listen mode is on: a soft
// band behind the sentence being read and a line under the word, measured
// from the body's own text and never a change to its HTML. A table, a code
// block, a diagram or a drawing being described keeps its own look under
// the same band, which spans what it draws, with a tag naming it and a line
// along its foot filling as its description is said. A tap on a word seeks
// there; a tap anywhere on a described block, to its description.

// The cursor as a string, so the layer draws again only when it moves. None
// until the player has caught up with the lit Question: for the moment after
// the selection moves, the time is still the last Question's, and a cursor
// drawn from it would scroll the list to the wrong place.
const cursorKeyAtom = Atom.make((get) => {
  const lit = get(litReadyAtom);
  if (lit === undefined) return '';
  if (get(playerSnapshotAtom)?.context.key !== lit.key) return '';
  const c = cursorAt(lit.ready.segments, get(readoutTimeAtom));
  return `${lit.key}:${c.seg}:${c.word}`;
});

const WHAT: Readonly<Record<string, string>> = {
  table: 'table',
  code: 'code',
  image: 'image',
  diagram: 'diagram',
  drawing: 'drawing',
};

type Drawn =
  | {
      readonly kind: 'read';
      readonly word: ReadonlyArray<Box>;
      readonly sentence: ReadonlyArray<Box>;
    }
  | {
      readonly kind: 'described';
      readonly what: string;
      readonly block: Box;
      // How much of the description has been said, 0 to 1.
      readonly said: number;
    };

const measure = (
  root: Element,
  ready: ReadoutReady,
  segments: ReadonlyArray<Segment>,
  s: number,
  w: number,
): Drawn | undefined => {
  const seg = segments[s];
  const timed = ready.segments[s];
  if (seg === undefined || timed === undefined) return undefined;
  const located = locate(root, seg);
  if (located === undefined) return undefined;
  const word = timed.words[w];
  if (located.unit === undefined) {
    const block = drawnBoxOf(located.el, root)[0];
    return block === undefined
      ? undefined
      : {
          kind: 'described',
          what: WHAT[seg.what ?? ''] ?? 'block',
          block,
          said: seg.text.length === 0 ? 0 : (word?.to ?? 0) / seg.text.length,
        };
  }
  const wordRange =
    word === undefined ? undefined : rangeOf(located.unit, word.from, word.to);
  const sentence = sentenceOf(seg.text, word?.from ?? 0);
  const sentenceRange = rangeOf(located.unit, sentence.from, sentence.to);
  return {
    kind: 'read',
    word: wordRange === undefined ? [] : boxesOf(wordRange, root),
    sentence: sentenceRange === undefined ? [] : boxesOf(sentenceRange, root),
  };
};

// A measured place: runtime numbers no utility can hold.
const placed = (b: Box) => ({
  top: b.top,
  left: b.left,
  width: b.width,
  height: b.height,
});

const Band = ({ d }: { readonly d: Drawn }) =>
  d.kind === 'described' ? (
    <>
      <div
        style={placed(d.block)}
        className="absolute rounded-sm bg-yellow/8 outline-1 outline-yellow/50"
      />
      <span
        style={{ top: d.block.top, left: d.block.left + d.block.width }}
        className="absolute -translate-x-full -translate-y-full bg-yellow px-s1 font-zen text-10 whitespace-nowrap text-bg"
      >
        ♪ describing the {d.what}
      </span>
      <div
        style={{
          top: d.block.top + d.block.height,
          left: d.block.left,
          width: d.block.width * d.said,
        }}
        className="absolute h-0.5 -translate-y-full bg-yellow transition-all duration-150 ease-out"
      />
    </>
  ) : (
    <>
      {d.sentence.map((b) => (
        <div
          key={`s${b.top}:${b.left}`}
          style={placed(b)}
          className="absolute bg-yellow/12"
        />
      ))}
      {d.word.map((b) => (
        <div
          key={`w${b.top}:${b.left}`}
          style={placed(b)}
          className="absolute border-b-2 border-yellow transition-all duration-100 ease-out"
        />
      ))}
    </>
  );

const Cursor = ({
  root,
  ready,
  script,
}: {
  readonly root: Element;
  readonly ready: ReadoutReady;
  readonly script: Script;
}) => {
  const registry = useContext(RegistryContext);
  const key = useAtomValue(cursorKeyAtom);
  const state = useAtomValue(playerStateAtom);
  const time = useAtomValue(readoutTimeAtom);
  const [, s, w] = key.split(':').map(Number);
  const hidden = key === '' || (state === 'stopped' && time === 0);
  // Measured while drawing: the body's layout is the last commit's, which a
  // cursor move does not change.
  const d =
    hidden || s === undefined || w === undefined
      ? undefined
      : measure(root, ready, script.segments, s, w);
  const playing = state === 'playing';
  // The escape hatch: the list scrolls to follow the cursor each time it
  // moves to another word while it plays, by the word's box or a described
  // block's, measured on the page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the cursor moving should scroll, not each frame's redraw
  useEffect(() => {
    if (!playing || d === undefined) return;
    const box = d.kind === 'described' ? d.block : (d.word[0] ?? d.sentence[0]);
    if (box === undefined) return;
    const origin = root.getBoundingClientRect().top;
    follow(
      root.ownerDocument,
      {
        get: () => registry.get(followHandsOffAtom),
        set: (b) => registry.set(followHandsOffAtom, b),
      },
      origin + box.top,
      origin + box.top + box.height,
    );
  }, [key, playing]);
  return d === undefined ? null : <Band d={d} />;
};

// What a tap in listen mode must leave alone: a real control keeps its own
// click, so a diagram's expand button still opens it full screen.
const OWN_CLICK =
  'a, button, input, textarea, [role="button"], [data-zen-eyebrow], [data-zen-group], [data-copy]';

/** In each Question's item; draws only in the lit one, while its audio is made. */
export const ReadoutLayer = ({ item }: { readonly item: ReaderItem }) => {
  const lit = useAtomValue(litReadyAtom);
  const seek = useAtomSet(seekAtom);
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const mine = lit !== undefined && lit.key === item.key ? lit : undefined;
  const root = layer?.parentElement ?? null;
  // The escape hatch: a capture-phase click on the item, so a tap seeks
  // before the body's own handlers (a drawing's editor) see it.
  useEffect(() => {
    if (mine === undefined || root === null) return;
    root.setAttribute('data-readout-scrub', '');
    const onClick = (e: MouseEvent) => {
      if ((root.ownerDocument.getSelection()?.toString() ?? '') !== '') return;
      const target = e.target instanceof Element ? e.target : null;
      if (target === null || target.closest(OWN_CLICK) !== null) return;
      const t = seekTargetAt(
        root,
        mine.script.segments,
        mine.ready.segments,
        target,
        e.clientX,
        e.clientY,
      );
      if (t === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      seek(t);
    };
    root.addEventListener('click', onClick, true);
    return () => {
      root.removeAttribute('data-readout-scrub');
      root.removeEventListener('click', onClick, true);
    };
  }, [mine, root, seek]);
  return (
    <div
      ref={setLayer}
      aria-hidden="true"
      data-readout-layer
      className="pointer-events-none absolute inset-0 z-1"
    >
      {mine !== undefined && root !== null && (
        <Cursor root={root} ready={mine.ready} script={mine.script} />
      )}
    </div>
  );
};
