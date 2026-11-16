import {
  useAtom,
  useAtomMount,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@effect/atom-react';
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';
import {
  activeQueueAtom,
  askingAtom,
  dimmedOpacity,
  flowEndsAtom,
  flowStepAskedAtom,
  jumpAtom,
  litKeyAtom,
  placingAtom,
  readerIntroAtom,
  SPRING_MAX_STEP_S,
  type Spring,
  shownQueuesAtom,
  springSettled,
  springStep,
} from '../../inbox-reader';
import { inboxReaderAtoms } from '../../inbox-reader-machine';
import { mermaidPrefetchAtom } from '../../mermaid';
import { introFade } from './composer';
import { QuestionItem } from './question-item';
import { NoQuestion } from './reader-states';

// Every question of the queue in one scroll. The machine says who is moving the
// list and where to; this measures the DOM and moves it, which only an element
// can do, so the refs and effects here are measurement and the painting that
// follows from it, and nothing else.

// A jump centres a question that fits between the header and the answer, and
// puts a taller one this far under the header.
const TOP_GAP_PX = 24;
// One press of `scroll_up` or `scroll_down`: about a paragraph. Held, the key
// repeats and they add up.
const STEP_PX = 120;

interface Bars {
  readonly header: RefObject<HTMLDivElement | null>;
  readonly foot: RefObject<HTMLDivElement | null>;
}

// The space a question has: under the header, above the answer.
const areaOf = (s: HTMLElement, { header, foot }: Bars) => {
  const head = header.current?.offsetHeight ?? 0;
  const under = foot.current?.offsetHeight ?? 0;
  return { head, under, height: s.clientHeight - head - under };
};

const marginOf = (el: HTMLElement, height: number) =>
  el.offsetHeight <= height ? (height - el.offsetHeight) / 2 : TOP_GAP_PX;

const articleOf = (s: HTMLElement, key: string) =>
  [...s.querySelectorAll<HTMLElement>('[data-zen-item]')].find(
    (a) => a.dataset.zenItem === key,
  );

// Where the list rests with `el` brought up: centred in the space, or under
// the header when it is taller.
const restingTopOf = (s: HTMLElement, el: HTMLElement, bars: Bars) => {
  const { head, height } = areaOf(s, bars);
  return Math.max(0, el.offsetTop - head - marginOf(el, height));
};

// A smooth jump still sliding: which jump, to which question, and the top it
// was last aimed at.
interface Flight {
  readonly id: number;
  readonly key: string;
  readonly top: number;
}

export const QuestionFlow = ({ header, foot }: Bars) => {
  const queue = useAtomValue(activeQueueAtom);
  const items = useAtomValue(shownQueuesAtom)[queue];
  const lit = useAtomValue(litKeyAtom);
  const asking = useAtomValue(askingAtom);
  const jump = useAtomValue(jumpAtom);
  const placing = useAtomValue(placingAtom);
  const intro = useAtomValue(readerIntroAtom);
  const send = useAtomSet(inboxReaderAtoms.send);
  // Each diagram on the board is drawn as the board arrives, so a question
  // mounts with its picture's size, not short of it.
  useAtomMount(mermaidPrefetchAtom);
  const scroller = useRef<HTMLDivElement>(null);
  // The read question's top in the list, and the list's scroll when it was
  // taken. The scroll is kept rather than read again when correcting: a
  // question above shrinking can pull the end of the list up past the scroll,
  // and the browser clamps the scroll before this sees the change, so a
  // correction added to the clamped scroll would count the shrink twice.
  const anchor = useRef<
    { key: string; top: number; scroll: number } | undefined
  >(undefined);
  // Where the steps are heading, so quick presses add up.
  const pagingTo = useRef<number | undefined>(undefined);
  // The jump already under way, so measuring again does not start it over.
  const jumped = useRef<number | undefined>(undefined);
  // The smooth jump still sliding, from its `scrollTo` to its `scrollend`, so
  // a question changing size on its way re-aims it rather than leaving it to
  // land where its target used to be.
  const flight = useRef<Flight | undefined>(undefined);
  // The focused key as `paint` reads it, from a scroll or a resize alike.
  const litKey = useRef<string | undefined>(undefined);
  // Each question's fade, and those still moving. Not state: see `paint`.
  const fades = useRef(
    new WeakMap<HTMLElement, Spring & { readonly target: number }>(),
  );
  const moving = useRef(new Set<HTMLElement>());
  const frame = useRef<number | undefined>(undefined);

  // Runs every moving fade to its target, a frame at a time. Its clock is the
  // frame's own timestamp, not `DateTime.now`: an exception to the repo's rule,
  // since this is a display's refresh and no test or log reads the time.
  const spring = useCallback(() => {
    if (moving.current.size === 0 || frame.current !== undefined) return;
    let last: number | undefined;
    const step = (now: number) => {
      const dt =
        last === undefined
          ? 0
          : Math.min((now - last) / 1000, SPRING_MAX_STEP_S);
      last = now;
      for (const el of moving.current) {
        const fade = fades.current.get(el);
        if (fade === undefined) continue;
        const next = springStep(fade, fade.target, dt);
        const done = springSettled(next, fade.target);
        const value = done ? fade.target : next.value;
        fades.current.set(el, {
          value,
          velocity: done ? 0 : next.velocity,
          target: fade.target,
        });
        el.style.opacity = Math.max(0, Math.min(1, value)).toFixed(3);
        if (done) moving.current.delete(el);
      }
      frame.current =
        moving.current.size > 0 ? requestAnimationFrame(step) : undefined;
    };
    frame.current = requestAnimationFrame(step);
  }, []);

  // Gives each question the opacity it should reach from where it sits now, and
  // its spring runs there. Straight to the element, not through React, so a
  // scroll renders nothing. An inline style, since a value that varies
  // continuously cannot be a utility; a plain opacity and not a custom property,
  // which every element inside would inherit and restyle. All the reads come
  // before any write, so layout is not forced.
  const paint = useCallback(() => {
    const s = scroller.current;
    if (s === null) return;
    const { head, height: area } = areaOf(s, { header, foot });
    const top = s.scrollTop + head;
    const items = [...s.querySelectorAll<HTMLElement>('[data-zen-item]')];
    const opacities = items.map((el) => {
      if (el.dataset.zenItem === litKey.current) return 1;
      const height = el.offsetHeight;
      const start = el.offsetTop;
      const visible =
        Math.min(start + height, top + area) - Math.max(start, top);
      return dimmedOpacity({
        visible: Math.max(0, visible),
        height,
        area,
        vh: s.clientHeight,
      });
    });
    items.forEach((el, i) => {
      const target = opacities[i] ?? 0;
      const fade = fades.current.get(el);
      if (fade?.target === target) return;
      // At 0% it is not there, so it must not catch a click, even on its way out.
      el.toggleAttribute('data-zen-dark', target === 0);
      if (fade === undefined) {
        // New to the page: it starts where it belongs, with nothing to fade from.
        fades.current.set(el, { value: target, velocity: 0, target });
        el.style.opacity = String(target);
      } else {
        fades.current.set(el, { ...fade, target });
        moving.current.add(el);
      }
    });
    spring();
  }, [header, foot, spring]);

  // The room at each end of the list: enough for the first and last questions
  // to rest where a jump would put them, and no more, so a scroll stops there.
  const [ends, setEnds] = useAtom(flowEndsAtom);
  const firstKey = items[0]?.key;
  const lastKey = items.at(-1)?.key;
  // `asking` too: the list comes back as a long ask's box goes, and left to the
  // observer it would show for a frame at the room the box left it. It is also
  // how the foot gets watched at all: on the first mount its ref is not set yet.
  useLayoutEffect(() => {
    const s = scroller.current;
    // An empty queue's stand-in is centred by CSS, but the foot is watched for
    // it here too, so it keeps clear of the foot.
    const none = s?.querySelector<HTMLElement>('[data-zen-none]') ?? undefined;
    const first = s && firstKey ? articleOf(s, firstKey) : none;
    const last = s && lastKey ? articleOf(s, lastKey) : none;
    if (s === null || first === undefined || last === undefined) {
      setEnds(undefined);
      return;
    }
    const measure = () => {
      const { head, under, height } = areaOf(s, { header, foot });
      setEnds({
        lead: head + marginOf(first, height),
        trail: under + marginOf(last, height),
        foot: under,
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(measure);
    watch.observe(s);
    watch.observe(first);
    watch.observe(last);
    if (foot.current !== null) watch.observe(foot.current);
    return () => watch.disconnect();
  }, [firstKey, lastKey, queue, asking, header, foot, setEnds]);

  // The machine asked for a question to come up. A slide starts once. A placement
  // goes again if the ends are measured while it holds: an answer that takes the
  // first or last question away changes them only after this has run, and the
  // room above is what the question's place is counted from.
  const jumpId = jump?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: per jump and per measure
  useLayoutEffect(() => {
    const s = scroller.current;
    if (jump === undefined || s === null) return;
    if (jumped.current === jump.id && (jump.smooth || !placing)) return;
    jumped.current = jump.id;
    flight.current = undefined;
    const el = articleOf(s, jump.key);
    if (el === undefined) return;
    const top = restingTopOf(s, el, { header, foot });
    if (!jump.smooth) {
      s.scrollTop = top;
      // Placed from these numbers: the anchor below must not correct for them.
      anchor.current = {
        key: jump.key,
        top: el.offsetTop,
        scroll: s.scrollTop,
      };
    }
    // No distance to go is no `scrollend`, and the lock would sit out its time.
    else if (Math.abs(top - s.scrollTop) < 1)
      send({ type: 'JumpEnded', id: jump.id });
    else {
      flight.current = { id: jump.id, key: jump.key, top };
      s.scrollTo({ top, behavior: 'smooth' });
    }
  }, [jumpId, ends]);

  // The queue emptied under the reader, most often by their own last answer:
  // the stand-in takes the list's place at the top of the scroll. The scroll
  // the list left behind is put back to the top here rather than left for the
  // browser to clamp, since an engine that clamps only once a slide or a
  // fling has run out draws the stand-in out of view until then. Whatever was
  // moving the list goes with it, and a slide's lock is let go, as no
  // `scrollend` comes for a slide cut short.
  const empty = items.length === 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: on emptying
  useLayoutEffect(() => {
    const s = scroller.current;
    if (!empty || s === null) return;
    pagingTo.current = undefined;
    flight.current = undefined;
    anchor.current = undefined;
    s.scrollTop = 0;
    if (jumpId !== undefined) send({ type: 'JumpEnded', id: jumpId });
  }, [empty]);

  // A question changing size above the one being read must not push it out
  // of place: one arriving, or a picture in one drawn late. Run on a render
  // and on a resize alike, since a picture loading renders nothing here. The
  // anchor is the question's top in the list, which a scroll does not move,
  // so the reader's own scroll is never undone: only a move of the question
  // itself is. While a smooth jump slides, the slide is re-aimed instead,
  // since setting `scrollTop` would stop it dead; and a keyed step still
  // under way is carried by the same distance, for the same reason.
  const hold = useCallback(
    (key: string | undefined) => {
      const s = scroller.current;
      const el =
        s === null || key === undefined ? undefined : articleOf(s, key);
      if (s === null || el === undefined || key === undefined) {
        anchor.current = undefined;
        return;
      }
      const flying = flight.current;
      const was = anchor.current;
      if (flying !== undefined) {
        const target = articleOf(s, flying.key);
        const top =
          target === undefined
            ? flying.top
            : restingTopOf(s, target, { header, foot });
        if (Math.abs(top - flying.top) >= 1) {
          flight.current = { ...flying, top };
          s.scrollTo({ top, behavior: 'smooth' });
        }
      } else if (was?.key === key && was.top !== el.offsetTop) {
        const by = el.offsetTop - was.top;
        s.scrollTop = was.scroll + by;
        if (pagingTo.current !== undefined) {
          pagingTo.current += by;
          s.scrollTo({ top: pagingTo.current, behavior: 'smooth' });
        }
      }
      anchor.current = { key, top: el.offsetTop, scroll: s.scrollTop };
    },
    [header, foot],
  );

  useLayoutEffect(() => {
    hold(lit);
  });

  // Any render can move the focus or the questions. Before the browser paints,
  // so a new question never shows at the wrong strength.
  useLayoutEffect(() => {
    litKey.current = lit;
    paint();
  });

  // A question or the answer box changing size moves what is in view with no
  // scroll: typing, a fold opening, a picture drawn, the window. The read
  // question is held in place first, so the paint sees where it rests.
  const itemKeys = items.map((i) => i.key).join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new list
  useLayoutEffect(() => {
    const s = scroller.current;
    if (s === null || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => {
      hold(litKey.current);
      paint();
    });
    watch.observe(s);
    if (foot.current !== null) watch.observe(foot.current);
    for (const el of s.querySelectorAll('[data-zen-item]')) watch.observe(el);
    return () => watch.disconnect();
  }, [itemKeys, queue, foot, hold, paint]);

  useEffect(
    () => () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
    },
    [],
  );

  // A key steps the list. It is a scroll like the wheel's, so the focus follows
  // the reading line as it goes.
  useAtomSubscribe(flowStepAskedAtom, ({ by }) => {
    const s = scroller.current;
    if (s === null) return;
    const end = s.scrollHeight - s.clientHeight;
    const top = (pagingTo.current ?? s.scrollTop) + by * STEP_PX;
    pagingTo.current = Math.max(0, Math.min(end, top));
    flight.current = undefined;
    send({ type: 'ScrollTaken' });
    s.scrollTo({ top: pagingTo.current, behavior: 'smooth' });
  });

  const onScroll = () => {
    const s = scroller.current;
    if (s === null) return;
    // Held first: a picture may have moved the read question since the last
    // frame's observer ran, and the reading line below must not see it out of
    // place, or it takes the question above for the one being read. A scroll
    // of the reader's own moves the list, not the question, so this only
    // takes the new scroll as the anchor's, and never undoes it.
    hold(litKey.current);
    paint();
    // A slide that has come to rest needs no more aiming, though its
    // `scrollend` may not have come yet. Its top may lie past the end.
    const flying = flight.current;
    if (
      flying !== undefined &&
      Math.abs(
        Math.min(flying.top, s.scrollHeight - s.clientHeight) - s.scrollTop,
      ) < 1
    )
      flight.current = undefined;
    // The reading line is the middle of the space, where a jump centres.
    const { head, height } = areaOf(s, { header, foot });
    const line = s.scrollTop + head + height / 2;
    const articles = [...s.querySelectorAll<HTMLElement>('[data-zen-item]')];
    const reading =
      articles.filter((a) => a.offsetTop <= line).at(-1) ?? articles[0];
    const key = reading?.dataset.zenItem;
    if (key !== undefined) send({ type: 'ScrolledTo', key });
  };

  const taken = () => {
    pagingTo.current = undefined;
    flight.current = undefined;
    send({ type: 'ScrollTaken' });
  };

  const onPick = useCallback(
    (key: string) => send({ type: 'MovedTo', key }),
    [send],
  );

  return (
    // A queue draws its own list. Kept mounted but invisible while asking, so
    // it holds its place.
    <div
      key={queue}
      ref={scroller}
      onScroll={onScroll}
      onScrollEnd={() => {
        pagingTo.current = undefined;
        flight.current = undefined;
        if (jumpId !== undefined) send({ type: 'JumpEnded', id: jumpId });
      }}
      onWheel={taken}
      onTouchStart={taken}
      data-zen-flow
      className={`scrollbar-none overflow-anchor-none @container relative h-full overflow-x-hidden overflow-y-auto px-s5 wrap-break-word ${asking ? 'invisible' : ''}`}
    >
      {items.length === 0 ? (
        // An empty queue's stand-in is centred by CSS in the room between the
        // header and the foot, not by the measured ends: it moves only when that
        // room or the stand-in itself changes size, and a stand-in taller than
        // the room rests under the header and scrolls. The foot's height is a
        // runtime value Tailwind cannot express.
        <div
          className="flex min-h-full flex-col pt-header"
          style={{ paddingBottom: ends?.foot ?? 0 }}
        >
          <div
            data-zen-none
            className={`mx-auto my-auto w-full max-w-measure py-6 ${introFade(intro)}`}
          >
            <NoQuestion />
          </div>
        </div>
      ) : (
        <>
          {/* Measured, so each end of the list is its question's resting
              place: a runtime height Tailwind cannot express. */}
          <div
            className={ends === undefined ? 'h-1/2' : undefined}
            style={ends === undefined ? undefined : { height: ends.lead }}
          />
          <div
            data-zen-questions
            className={`mx-auto flex max-w-measure flex-col gap-30 ${introFade(intro)}`}
          >
            {items.map((item) => (
              <QuestionItem
                key={item.key}
                item={item}
                lit={item.key === lit}
                onPick={onPick}
              />
            ))}
          </div>
          <div
            className={ends === undefined ? 'h-full' : undefined}
            style={ends === undefined ? undefined : { height: ends.trail }}
          />
        </>
      )}
    </div>
  );
};
