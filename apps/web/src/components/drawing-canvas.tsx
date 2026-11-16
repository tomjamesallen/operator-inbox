import {
  convertToExcalidrawElements,
  Excalidraw,
  exportToCanvas,
  exportToSvg,
  restore,
  restoreElements,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type {
  AppState,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types';
import {
  DRAWING_EXPORT_PADDING,
  drawingFormat,
  keepIdsThroughDuplicates,
} from '@operator-inbox/core/api';
import { type KeyboardEvent, useEffect, useRef } from 'react';

// Everything that imports Excalidraw. The page loads this module with a
// dynamic import (`drawings.ts`), so the library and its stylesheet are
// chunks of their own, fetched the first time a drawing is drawn, and the
// service worker leaves them out of its shell (`LIBRARY_DOORS` in
// `vite.config.ts`).
//
// The hooks here are the escape hatch: Excalidraw is an imperative canvas
// that reports its scene through `onChange`.

type Elements = ReadonlyArray<ReturnType<typeof restoreElements>[number]>;

// A stored scene is either a full scene (every element has a `version`), or
// Excalidraw's shorter skeleton form (`{type, id, x, y, width, height,
// label: {text}}`, arrows bound with `start`/`end` ids), which Excalidraw
// fills out. The agent's ids are kept, so it can match boxes on read-back.
const loadScene = (text: string) => {
  const parsed = JSON.parse(text) as
    | {
        readonly elements?: ReadonlyArray<unknown>;
        readonly appState?: Record<string, unknown>;
      }
    | ReadonlyArray<unknown>;
  const raw = Array.isArray(parsed)
    ? parsed
    : ((parsed as { elements?: ReadonlyArray<unknown> }).elements ?? []);
  const elements =
    drawingFormat(text) === 'scene'
      ? raw
      : convertToExcalidrawElements(
          raw as Parameters<typeof convertToExcalidrawElements>[0],
          { regenerateIds: false },
        );
  const appState = Array.isArray(parsed)
    ? {}
    : ((parsed as { appState?: Record<string, unknown> }).appState ?? {});
  return restore({ elements: elements as never, appState }, null, null);
};

// Excalidraw measures a label with whatever font the document has when it
// lays the label out, and its own fonts are added to the document only when
// it first needs them: text measured before then is measured in a fallback,
// comes out too narrow, and clips once drawn in the hand-drawn face. Exporting
// to a canvas is the one public call that adds the fonts a set of elements
// uses to the document and waits for them to load, so it runs first, and the
// scene is laid out again after it.
const fontsLoaded = async (elements: Elements): Promise<void> => {
  try {
    await exportToCanvas({ elements, files: null, appState: {} });
  } catch {
    // Nothing to draw, or no canvas: the scene is laid out as it is.
  }
};

// The scene, laid out once its fonts have loaded.
const laidOut = async (text: string): Promise<Elements> => {
  await fontsLoaded(loadScene(text).elements);
  return restoreElements(loadScene(text).elements, null, {
    refreshDimensions: true,
  });
};

const live = (elements: Elements): Elements =>
  elements.filter((e) => !e.isDeleted);

/**
 * The scene as SVG text, with its fonts inline (Excalidraw's export embeds
 * them as data), padded by `DRAWING_EXPORT_PADDING`, the padding core's
 * `drawingBox` reserves.
 */
export const drawingSvg = async (
  text: string,
  dark: boolean,
): Promise<string> => {
  const elements = live(await laidOut(text));
  const svg = await exportToSvg({
    elements,
    appState: { exportBackground: false, exportWithDarkMode: dark },
    files: null,
    exportPadding: DRAWING_EXPORT_PADDING,
  });
  return svg.outerHTML;
};

/**
 * The scene the operator's edit is kept and sent as: its live elements, and
 * nothing of the editor's own state, so it stays small (a few kilobytes for a
 * few boxes) and well under core's `DRAWING_MAX_BYTES`.
 */
export const sceneText = (elements: Elements): string =>
  JSON.stringify({ type: 'excalidraw', version: 2, elements: live(elements) });

// The non-deleted elements' ids and versions: what "changed" turns on.
const signature = (elements: Elements): string =>
  live(elements)
    .map((e) => `${e.id}:${e.version}`)
    .join(',');

// Whether Escape has nothing in the editor to cancel: no element being drawn
// or written, no selection, no menu or dialog of its own, the selection tool
// in hand. Then Escape closes the full-screen view; otherwise it is
// Excalidraw's.
const idle = (s: AppState): boolean =>
  s.newElement === null &&
  s.multiElement === null &&
  s.editingTextElement === null &&
  s.editingLinearElement === null &&
  Object.keys(s.selectedElementIds).length === 0 &&
  s.openMenu === null &&
  s.openPopup === null &&
  s.openDialog === null &&
  s.contextMenu === null &&
  s.activeTool.type === 'selection';

const isTyping = (target: EventTarget): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT');

// A burst of changes (a drag) is kept once it rests.
const KEEP_AFTER_MS = 300;

const prefersDark = (): boolean =>
  typeof matchMedia !== 'undefined' &&
  matchMedia('(prefers-color-scheme: dark)').matches;

/**
 * The full-screen editor. It opens on `scene` (the operator's edit if there
 * is one, else the agent's) and reports each change as the whole scene's
 * text (`sceneText`): moving a box and putting it back still counts. An
 * Alt-drag duplicate is reported with its ids put back against `scene`
 * (`keepIdsThroughDuplicates`), so the shape that stayed keeps its id.
 */
export const DrawingEditor = ({
  scene,
  onEdit,
  onClose,
}: {
  readonly scene: string;
  readonly onEdit: (scene: string) => void;
  readonly onClose: () => void;
}) => {
  const api = useRef<ExcalidrawImperativeAPI | undefined>(undefined);
  const baseline = useRef<string | undefined>(undefined);
  const pending = useRef<string | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const report = useRef(onEdit);
  report.current = onEdit;
  const flush = () => {
    clearTimeout(timer.current);
    const next = pending.current;
    pending.current = undefined;
    if (next !== undefined) report.current(next);
  };
  // Closing keeps what the last burst changed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on unmount only
  useEffect(() => flush, []);
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    const state = api.current?.getAppState();
    if (
      e.key !== 'Escape' ||
      state === undefined ||
      isTyping(e.target) ||
      !idle(state)
    )
      return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };
  return (
    <div
      className="size-full"
      data-drawing-canvas
      onKeyDownCapture={onKeyDownCapture}
    >
      <Excalidraw
        // Empty at first: the scene goes in once its fonts have loaded
        // (`laidOut`), so its text is measured in the face it is drawn in.
        initialData={{ appState: { viewBackgroundColor: 'transparent' } }}
        excalidrawAPI={(handle) => {
          api.current = handle;
          void laidOut(scene).then((elements) => {
            handle.updateScene({ elements });
            handle.scrollToContent(undefined, {
              fitToViewport: true,
              viewportZoomFactor: 0.9,
              animate: false,
            });
            // Only now are the operator's changes watched.
            baseline.current = signature(handle.getSceneElements());
          });
        }}
        theme={prefersDark() ? 'dark' : 'light'}
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            export: false,
            saveAsImage: false,
            toggleTheme: false,
            changeViewBackgroundColor: false,
          },
          // A drawing carries no files, so no images.
          tools: { image: false },
        }}
        onChange={(elements) => {
          if (baseline.current === undefined) return;
          const sig = signature(elements);
          if (sig === baseline.current) return;
          baseline.current = sig;
          pending.current = keepIdsThroughDuplicates(
            scene,
            sceneText(elements),
          );
          clearTimeout(timer.current);
          timer.current = setTimeout(flush, KEEP_AFTER_MS);
        }}
      />
    </div>
  );
};
