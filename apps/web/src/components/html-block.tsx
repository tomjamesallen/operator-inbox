import { Dialog } from '@base-ui/react/dialog';
import { useAtom, useAtomValue } from '@effect/atom-react';
import {
  HTML_BLOCK_DEFAULT_HEIGHT,
  HTML_BLOCK_MAX_HEIGHT,
  HTML_BLOCK_SANDBOX,
  type HtmlBlockLibraries,
  type HtmlBlockMeta,
  type HtmlBlocks,
  type HtmlBlockWheel,
  type HtmlBlockWidth,
  htmlBlockFailure,
  htmlBlockLibrariesOf,
  htmlBlockMetaOf,
  htmlBlockSrcdoc,
} from '@operator-inbox/core/api';
import { Cause, Result } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import {
  colourSchemeAtom,
  columnInset,
  frameRunAgain,
  frameStateAfter,
  type HtmlFrameState,
  htmlBlockHeightsAtom,
  htmlBlocksAtom,
  htmlBlocksKeyOf,
  htmlFrameAtom,
  isFrameMessage,
  pageTokens,
  rememberedHeights,
  vendorKeyOf,
  vendorLibrariesAtom,
  wheelPixels,
} from '../html-blocks';
import type { DrawingHost } from './drawing-block';
import { focusRing, headerButton, label } from './styles';

// An `<Html id="…" width="…"/>` line of a question's body: an agent's HTML
// document, run in a sandboxed frame (`allow-scripts` alone, so its origin is
// opaque) whose `srcdoc` the app writes, with a policy that lets no request
// leave at all (core's `htmlBlockSrcdoc`). The three.js and d3 it uses are
// read by the page and handed in as text. The documents come from their own endpoint, for the
// Question shown, never with the board (`html-blocks.ts`).
//
// It sits in the text as part of the Question: no border, the page's ground,
// a faint control row UNDER it (↻ runs it again, ⤢ runs a second copy full
// screen), so nothing ever sits over the document or the text below.
//
// Height, without the page jumping:
// - before the frame reports, it holds the height this block last had in this
//   browser (by Question, id and hash), else the document's declared height
//   or aspect, else 160px;
// - the frame reports at most once a frame, and not for under 2px; the page
//   ignores a change under 2px too;
// - when it changes while the block lies wholly above the reader's view, the
//   reader's scroll moves by as much, so what the operator reads stays put
//   (`useKeepPlace`);
// - the height is capped at 2400px, past which the document scrolls inside.
//
// It is covered, solid, until it has loaded: the frame's `load` event or the
// bootstrap's `ready`, whichever comes first. A script that fails is said
// once, outside the frame.

export const HtmlBlock = ({
  id,
  width,
  host,
  refs,
}: {
  readonly id: string;
  readonly width: HtmlBlockWidth;
  readonly host: DrawingHost | undefined;
  // The Question's blocks, by id: their hashes and sizes.
  readonly refs: HtmlBlocks | undefined;
}) => {
  const ref = refs?.[id];
  if (ref === undefined || refs === undefined) return <Missing id={id} />;
  if (host === undefined)
    return (
      <p className="my-s2 text-12 text-fg/45" data-html-block={id}>
        An HTML block, “{id}”, runs only in the Question’s own view.
      </p>
    );
  return <Fetched id={id} width={width} host={host} refs={refs} />;
};

const Missing = ({ id }: { readonly id: string }) => (
  <p
    className="my-s2 border border-red/40 p-s2 text-12 text-red"
    data-html-missing={id}
  >
    This Question has no HTML block named “{id}”.
  </p>
);

const Fetched = ({
  id,
  width,
  host,
  refs,
}: {
  readonly id: string;
  readonly width: HtmlBlockWidth;
  readonly host: DrawingHost;
  readonly refs: HtmlBlocks;
}) => {
  const shas = Object.keys(refs)
    .sort()
    .map((k) => refs[k]?.sha ?? '');
  const documents = useAtomValue(
    htmlBlocksAtom(
      htmlBlocksKeyOf({ inboxId: host.inboxId, number: host.number, shas }),
    ),
  );
  const sha = refs[id]?.sha ?? '';
  // Its place in this browser's memory of heights.
  const memory = `${host.inboxId}/${host.number}/${id}/${sha}`;
  if (AsyncResult.isSuccess(documents)) {
    const doc = documents.value.blocks[id]?.doc;
    if (doc === undefined) return <Missing id={id} />;
    return <WithLibraries id={id} doc={doc} width={width} memory={memory} />;
  }
  if (AsyncResult.isFailure(documents))
    return (
      <p className="my-s2 text-12 text-red" role="alert">
        Could not read the HTML block “{id}”:{' '}
        {String(Cause.squash(documents.cause) ?? 'unknown')}
      </p>
    );
  return <Reserving memory={memory} />;
};

// The block once the libraries its document uses have been read: none, for
// a document that imports nothing.
const WithLibraries = ({
  id,
  doc,
  width,
  memory,
}: {
  readonly id: string;
  readonly doc: string;
  readonly width: HtmlBlockWidth;
  readonly memory: string;
}) => {
  const key = useMemo(() => vendorKeyOf(htmlBlockLibrariesOf(doc)), [doc]);
  const libraries = useAtomValue(vendorLibrariesAtom(key));
  if (AsyncResult.isSuccess(libraries))
    return (
      <Seamless
        id={id}
        doc={doc}
        width={width}
        memory={memory}
        libraries={libraries.value}
      />
    );
  if (AsyncResult.isFailure(libraries))
    return (
      <p className="my-s2 text-12 text-red" role="alert">
        Could not read the libraries the HTML block “{id}” uses:{' '}
        {String(Cause.squash(libraries.cause) ?? 'unknown')}
      </p>
    );
  return <Reserving memory={memory} />;
};

// The room a block keeps while its document is on its way.
const Reserving = ({ memory }: { readonly memory: string }) => {
  const heights = useAtomValue(htmlBlockHeightsAtom);
  const height = Math.min(
    heights[memory] ?? HTML_BLOCK_DEFAULT_HEIGHT,
    HTML_BLOCK_MAX_HEIGHT,
  );
  return (
    <div className="my-s3 w-full" data-html-reserving>
      <div
        className="flex items-center justify-center bg-bg text-12 text-fg/40"
        style={{ height }}
      >
        Loading…
      </div>
    </div>
  );
};

// --- the frame ---------------------------------------------------------------------

const metaOf = (doc: string): HtmlBlockMeta => {
  const meta = htmlBlockMetaOf(doc);
  // The CLI refused a document whose meta does not parse; one that slipped
  // past declares nothing.
  return Result.isSuccess(meta) ? meta.success : {};
};

const titleOf = (id: string, meta: HtmlBlockMeta) =>
  meta.title ?? `HTML block ${id}`;

interface Frame {
  readonly ref: RefObject<HTMLIFrameElement | null>;
  readonly srcDoc: string;
  readonly state: HtmlFrameState;
  readonly onLoad: () => void;
  readonly runAgain: () => void;
  // The mouse left the frame: the block lets the wheel go back to the page.
  readonly onMouseLeave: () => void;
}

// A line of a forwarded wheel, in pixels, where the scroller says none.
const WHEEL_LINE = 16;

// Scroll the reader by a wheel the block did not take.
const scrollReaderBy = (
  frame: HTMLIFrameElement | null,
  message: {
    readonly dx: unknown;
    readonly dy: unknown;
    readonly mode: unknown;
  },
) => {
  const scroller = frame?.closest('[data-zen-flow]');
  if (!(scroller instanceof HTMLElement)) return;
  const line =
    Number.parseFloat(getComputedStyle(scroller).lineHeight) || WHEEL_LINE;
  const { x, y } = wheelPixels(message, line, scroller.clientHeight);
  scroller.scrollTop += y;
  scroller.scrollLeft += x;
};

// One running copy of a document, by its place on the page (inline, or full
// screen). Its state is an Atom (`htmlFrameAtom`); the frame itself is an
// imperative thing that talks by postMessage, so listening to it is the
// escape hatch below.
const useFrame = (
  place: string,
  doc: string,
  libraries: HtmlBlockLibraries,
  wheel: HtmlBlockWheel,
): Frame => {
  const [state, setState] = useAtom(htmlFrameAtom(place));
  const scheme = useAtomValue(colourSchemeAtom);
  const ref = useRef<HTMLIFrameElement>(null);
  // Built again, and so run again, when the scheme changes or ↻ is pressed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `run` rebuilds it
  const srcDoc = useMemo(
    () =>
      htmlBlockSrcdoc(doc, { scheme, tokens: pageTokens(), libraries, wheel }),
    [doc, libraries, wheel, scheme, state.run],
  );
  // The escape hatch: a frame's messages arrive on the window. Only a message
  // whose `source` is this frame's own window is read; every frame's origin
  // is "null", so the origin cannot tell them apart.
  // biome-ignore lint/correctness/useExhaustiveDependencies: listens per build
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const own = ref.current?.contentWindow;
      if (own == null || e.source !== own || !isFrameMessage(e.data)) return;
      const message = e.data;
      if (message.oi === 'wheel') scrollReaderBy(ref.current, message);
      else setState((s) => frameStateAfter(s, message));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [srcDoc, setState]);
  return {
    ref,
    srcDoc,
    state,
    onLoad: () => setState((s) => (s.loaded ? s : { ...s, loaded: true })),
    runAgain: () => setState(frameRunAgain),
    // The frame's origin is opaque, so a message to it names no origin.
    onMouseLeave: () =>
      ref.current?.contentWindow?.postMessage({ oi: 'disengage' }, '*'),
  };
};

const FrameElement = ({
  frame,
  title,
  className,
  style,
}: {
  readonly frame: Frame;
  readonly title: string;
  readonly className: string;
  readonly style?: CSSProperties;
}) => (
  <iframe
    key={frame.state.run}
    ref={frame.ref}
    title={title}
    sandbox={HTML_BLOCK_SANDBOX}
    srcDoc={frame.srcDoc}
    // No referrer, and no `allow`: camera, microphone, geolocation and the
    // rest are refused to a cross-origin frame unless `allow` names them.
    referrerPolicy="no-referrer"
    loading="lazy"
    onLoad={frame.onLoad}
    onMouseLeave={frame.onMouseLeave}
    className={`block border-0 bg-transparent ${className}`}
    style={style}
    data-html-frame
  />
);

// Over a frame that has not loaded, and so has drawn nothing: solid, saying
// it is loading, or why it failed before it loaded.
const Veil = ({ frame }: { readonly frame: Frame }) =>
  frame.state.loaded ? null : (
    <div
      className="absolute inset-0 flex items-center justify-center bg-bg p-s3 text-center text-12"
      data-html-veil
    >
      {frame.state.error === undefined ? (
        <span className="text-fg/40">Loading…</span>
      ) : (
        <span className="text-red" role="alert">
          {htmlBlockFailure(frame.state.error)}
          <button
            type="button"
            className={`ml-s2 ${headerButton()} ${focusRing}`}
            onClick={frame.runAgain}
          >
            RUN AGAIN
          </button>
        </span>
      )}
    </div>
  );

// A block that loaded, drew and then failed: its failure goes in a bar of its
// own under the frame, never over what it drew.
const FailureBar = ({ frame }: { readonly frame: Frame }) => {
  if (!frame.state.loaded || frame.state.error === undefined) return null;
  const said = htmlBlockFailure(frame.state.error);
  return (
    <div
      className="mt-s1 flex contain-inline-size items-center gap-s2 border border-red/40 bg-red/5 px-s2 py-0.5 text-11 text-red"
      role="alert"
      data-html-failure
    >
      <span className="min-w-0 flex-1 truncate" title={said}>
        {said}
      </span>
      <button
        type="button"
        className={`shrink-0 ${headerButton()} ${focusRing}`}
        onClick={frame.runAgain}
      >
        RUN AGAIN
      </button>
    </div>
  );
};

// The escape hatch: keeping the reader's place is a scroll position, read and
// set in the same frame as the layout that changed it. The reader turns the
// browser's own scroll anchoring off, and WebKit has none to turn on.
const useKeepPlace = (
  box: RefObject<HTMLDivElement | null>,
  height: number,
) => {
  // The block's laid-out height as last seen, so the change is measured
  // whatever reserved its room before (a remembered height or an aspect).
  const seen = useRef<number | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on each report
  useLayoutEffect(() => {
    const el = box.current;
    if (el === null) return;
    const now = (el.querySelector('iframe') ?? el).getBoundingClientRect()
      .height;
    const delta = seen.current === undefined ? 0 : now - seen.current;
    seen.current = now;
    if (Math.abs(delta) < 2) return;
    const scroller = el.closest('[data-zen-flow]');
    if (!(scroller instanceof HTMLElement)) return;
    const top = scroller.getBoundingClientRect().top;
    // Where the block's bottom was before it changed: wholly above the view's
    // top edge means everything in view has just moved by `delta`.
    const oldBottom = el.getBoundingClientRect().bottom - delta;
    if (oldBottom <= top + 1) scroller.scrollTop += delta;
  }, [height]);
};

// The label while the reader has clicked into the block, and the wheel is
// the block's: `label`, in the text colour.
const labelEngaged = 'text-10.5 font-medium tracking-label text-fg uppercase';

// The escape hatch: where the text column sits in the frame is a measured
// box, posted into the running frame whenever the layout moves (a sidebar
// pinned, the window resized) and once it has loaded, so its document can
// line a caption up with the prose (`--oi-column-left`). No reload.
const useColumnInset = (
  room: RefObject<HTMLDivElement | null>,
  frame: Frame,
) => {
  const loaded = frame.state.loaded;
  // biome-ignore lint/correctness/useExhaustiveDependencies: per run and load
  useEffect(() => {
    const el = room.current;
    const iframe = frame.ref.current;
    if (el === null || iframe === null || !loaded) return;
    const post = () =>
      iframe.contentWindow?.postMessage(
        columnInset(el.getBoundingClientRect(), iframe.getBoundingClientRect()),
        // The frame's origin is opaque, so a message to it names no origin.
        '*',
      );
    post();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(post);
    watch.observe(el);
    watch.observe(iframe);
    return () => watch.disconnect();
  }, [loaded, frame.state.run]);
};

const WIDTH_CLASSES: Readonly<Record<HtmlBlockWidth, string>> = {
  // The text column.
  constrain: 'w-full',
  // As a table or a diagram: past the column both ways, or right only, as
  // the reader's `wideBlocks` says.
  wide: 'in-data-zen-flow:min-w-full in-data-zen-flow:wide-both:max-w-figure-wide in-data-zen-flow:wide-both:-ml-figure-wide-inset in-data-zen-flow:wide-both:translate-x-figure-wide-inset in-data-zen-flow:wide-right:max-w-figure-bleed',
  // The reader's full width, both ways, whatever `wideBlocks` says.
  full: 'w-full in-data-zen-flow:w-figure-wide in-data-zen-flow:-ml-figure-wide-inset in-data-zen-flow:translate-x-figure-wide-inset',
};
// `wide` with no declared width: as far as it may go.
const WIDE_MAX =
  'in-data-zen-flow:wide-both:w-figure-wide in-data-zen-flow:wide-right:w-figure-bleed';

const Seamless = ({
  id,
  doc,
  width,
  memory,
  libraries,
}: {
  readonly id: string;
  readonly doc: string;
  readonly width: HtmlBlockWidth;
  readonly memory: string;
  readonly libraries: HtmlBlockLibraries;
}) => {
  const meta = useMemo(() => metaOf(doc), [doc]);
  const frame = useFrame(memory, doc, libraries, 'page');
  const [heights, setHeights] = useAtom(htmlBlockHeightsAtom);
  const reported = frame.state.height;
  const known = reported ?? heights[memory];
  // Before any report: the remembered height; else the declared height; else
  // the declared aspect at the width the block is given (CSS, so right from
  // the first paint); else 160px. These are measured values, set per block,
  // so they are inline styles rather than theme tokens.
  const reserve: CSSProperties =
    known !== undefined
      ? { height: Math.min(known, HTML_BLOCK_MAX_HEIGHT) }
      : meta.height !== undefined
        ? { height: meta.height }
        : meta.aspect !== undefined
          ? { aspectRatio: String(meta.aspect) }
          : { height: HTML_BLOCK_DEFAULT_HEIGHT };
  const box = useRef<HTMLDivElement>(null);
  useKeepPlace(box, known ?? 0);
  const room = useRef<HTMLDivElement>(null);
  useColumnInset(room, frame);
  // The escape hatch: a report is remembered for the next load, after it
  // has been drawn.
  useEffect(() => {
    if (reported !== undefined)
      setHeights((h) => rememberedHeights(h, memory, reported));
  }, [memory, reported, setHeights]);
  const declaredWidth: CSSProperties | undefined =
    width === 'wide' && meta.width !== undefined
      ? { width: meta.width }
      : undefined;
  return (
    // The block runs as wide as its `width`; the failure bar and the control
    // row stay in the room, the text column, so they keep to the prose's
    // left edge however far the block runs.
    <div ref={room} className="group picture-room my-s3" data-html-block={id}>
      <div
        ref={box}
        className={`${WIDTH_CLASSES[width]} ${
          width === 'wide' && declaredWidth === undefined ? WIDE_MAX : ''
        }`}
        style={declaredWidth}
        data-html-width={width}
      >
        <div className="relative">
          <FrameElement
            frame={frame}
            title={titleOf(id, meta)}
            className="w-full"
            style={reserve}
          />
          <Veil frame={frame} />
        </div>
      </div>
      <FailureBar frame={frame} />
      <div
        className={`mt-0.5 flex contain-inline-size items-center gap-s1 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 ${
          frame.state.engaged === true ? 'opacity-100' : 'opacity-40'
        }`}
        data-html-controls
        data-html-engaged={frame.state.engaged === true ? '' : undefined}
      >
        <span
          className={`shrink-0 whitespace-nowrap ${
            frame.state.engaged === true ? labelEngaged : label
          }`}
        >
          html · {id}
        </span>
        <button
          type="button"
          className={`${headerButton()} ${focusRing}`}
          onClick={frame.runAgain}
          title="Run again"
          aria-label={`Run the block ${id} again`}
        >
          ↻
        </button>
        <FullScreen
          id={id}
          doc={doc}
          meta={meta}
          memory={memory}
          libraries={libraries}
        />
      </div>
    </div>
  );
};

// --- full screen -------------------------------------------------------------------

// A second run of the document, filling the view, in a Base UI Dialog (Escape
// closes it, and focus goes back to ⤢). The inline run keeps going behind it;
// nothing carries across.
interface FullScreenProps {
  readonly id: string;
  readonly doc: string;
  readonly meta: HtmlBlockMeta;
  readonly memory: string;
  readonly libraries: HtmlBlockLibraries;
}

const FullScreen = (props: FullScreenProps) => (
  <Dialog.Root>
    <Dialog.Trigger
      className={`shrink-0 ${headerButton()} ${focusRing}`}
      aria-label={`Show the block ${props.id} full screen`}
      title="Full screen"
    >
      ⤢
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-30 bg-fg/20" />
      <Dialog.Popup
        className="fixed inset-s4 z-40 flex flex-col border border-fg/20 bg-bg p-s3"
        data-html-full-screen={props.id}
      >
        <FullScreenBody {...props} />
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
);

const FullScreenBody = ({
  id,
  doc,
  meta,
  memory,
  libraries,
}: FullScreenProps) => {
  // Full screen there is no page to scroll: every wheel is the block's.
  const frame = useFrame(`${memory}/full-screen`, doc, libraries, 'block');
  return (
    <>
      <div className="flex items-baseline gap-s2">
        <Dialog.Title className={`min-w-0 flex-1 truncate ${label}`}>
          HTML · {id} · {titleOf(id, meta)}
        </Dialog.Title>
        <button
          type="button"
          className={`${headerButton()} ${focusRing}`}
          onClick={frame.runAgain}
          aria-label={`Run the block ${id} again`}
        >
          ↻
        </button>
        <Dialog.Close className={`${headerButton()} ${focusRing}`}>
          CLOSE
        </Dialog.Close>
      </div>
      <div className="relative mt-s2 min-h-0 flex-1">
        <FrameElement
          frame={frame}
          title={titleOf(id, meta)}
          className="h-full w-full"
        />
        <Veil frame={frame} />
      </div>
      <FailureBar frame={frame} />
    </>
  );
};
