import { Dialog } from '@base-ui/react/dialog';
import { useAtom, useAtomValue } from '@effect/atom-react';
import {
  drawingBox,
  type InboxId,
  type InboxOperatorQuestionDto,
} from '@operator-inbox/core/api';
import { Cause } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import type { ReactNode } from 'react';
import {
  drawingCanvasAtom,
  drawingDraftAtom,
  drawingKey,
  drawingOpenAtom,
  drawingPictureAtom,
} from '../drawings';
import { PictureFrame } from './picture-frame';
import { focusRing, headerButton, label } from './styles';

// An `<Excalidraw id="…"/>` line of a question's body: the Question's drawing
// of that id, inline as a static picture the column's width, in the frame
// every picture in a body shares (`PictureFrame`), sized from the scene
// itself (core's `drawingBox`) before Excalidraw has even loaded, so the
// question mounts at the height it keeps. It is edited only full screen (⤢,
// a Base UI Dialog), and only while the question waits on the operator.
//
// While it waits, the picture is the operator's edit when there is one
// (`drawings.ts`), marked as going with the answer, with REVERT beside it. An
// answered question shows what went with the answer, or the agent's drawing,
// read-only.

/** One of a Question's drawings: its scene, and the revision that last set it. */
type QuestionDrawing = NonNullable<
  InboxOperatorQuestionDto['drawings']
>[string];

/** The question a drawing belongs to, as far as the drawing needs it. */
export interface DrawingHost {
  readonly inboxId: InboxId;
  readonly number: InboxOperatorQuestionDto['number'];
  // Its key on the page (`answerKey`).
  readonly key: string;
  // `open`: it waits on the operator, so the drawing can be edited.
  // `sending`: the answer is on its way, with any edit. `answered`: done.
  readonly state: 'open' | 'sending' | 'answered';
}

export const DrawingBlock = ({
  id,
  host,
  drawing,
  sent,
}: {
  readonly id: string;
  readonly host: DrawingHost | undefined;
  // The Question's drawing of this id, and the revision that last set it.
  readonly drawing: QuestionDrawing | undefined;
  // What the operator sent with their answer, when they changed it.
  readonly sent: string | undefined;
}) => {
  if (drawing === undefined && sent === undefined)
    return (
      <p
        className="my-s2 border border-red/40 p-s2 text-12 text-red"
        data-drawing-missing={id}
      >
        This Question has no drawing named “{id}”.
      </p>
    );
  if (drawing !== undefined && host?.state === 'open')
    return <LiveDrawing id={id} host={host} drawing={drawing} />;
  if (host?.state === 'sending' && sent === undefined && drawing !== undefined)
    return <SendingDrawing id={id} host={host} scene={drawing.scene} />;
  return (
    <ShownDrawing
      id={id}
      scene={sent ?? drawing?.scene ?? ''}
      sent={sent !== undefined}
    />
  );
};

// --- the frame ------------------------------------------------------------------------

// The label row: the label and its marks wrap as whole items, each on one
// line, so on a narrow column a mark drops under the label rather than
// folding into a column of words; ⤢ (`open`) sits outside the wrap, pinned
// to the right edge, so it never leaves the frame.
const Figure = ({
  id,
  marks,
  open,
  notice,
  children,
}: {
  readonly id: string;
  readonly marks?: ReactNode;
  readonly open: ReactNode;
  readonly notice?: ReactNode;
  readonly children: ReactNode;
}) => (
  <figure className="my-s2 border border-fg/13" data-drawing={id}>
    <div className="flex items-center gap-s2 px-s2 py-0.5">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-s2 gap-y-0.5">
        <span
          className={`min-w-0 flex-auto truncate ${label}`}
          title={`Drawing · ${id}`}
        >
          Drawing · {id}
        </span>
        {marks}
      </div>
      {open}
    </div>
    {notice}
    <div className="border-t border-fg/10 p-s2">{children}</div>
  </figure>
);

const SentMark = () => (
  <span className="min-w-0 truncate text-11 text-fg/45" data-drawing-sent>
    Sent with your answer
  </span>
);

// --- an answered question's drawing -------------------------------------------------------

const ShownDrawing = ({
  id,
  scene,
  sent,
}: {
  readonly id: string;
  readonly scene: string;
  readonly sent: boolean;
}) => (
  <Figure
    id={id}
    marks={sent && <SentMark />}
    open={<Viewer id={id} scene={scene} />}
  >
    <DrawingPicture scene={scene} />
  </Figure>
);

// On its way with the answer: the operator's edit, if they made one.
const SendingDrawing = ({
  id,
  host,
  scene,
}: {
  readonly id: string;
  readonly host: DrawingHost;
  readonly scene: string;
}) => {
  const draft = useAtomValue(drawingDraftAtom(drawingKey(host.key, id)));
  return (
    <ShownDrawing
      id={id}
      scene={draft?.scene ?? scene}
      sent={draft !== undefined}
    />
  );
};

// The read-only full-screen view: the picture, scaled to the space it has.
const Viewer = ({
  id,
  scene,
}: {
  readonly id: string;
  readonly scene: string;
}) => (
  <Dialog.Root>
    <Dialog.Trigger
      className={`shrink-0 ${headerButton()} ${focusRing}`}
      aria-label="Show the drawing full screen"
      title="Full screen"
    >
      ⤢
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-30 bg-fg/20" />
      <Dialog.Popup
        className="fixed inset-s4 z-40 flex flex-col border border-fg/20 bg-bg p-s3"
        data-testid="drawing-full-screen"
      >
        <div className="flex items-baseline gap-s2">
          <Dialog.Title className={`flex-1 ${label}`}>
            Drawing · {id}
          </Dialog.Title>
          <Dialog.Close className={`${headerButton()} ${focusRing}`}>
            CLOSE
          </Dialog.Close>
        </div>
        <div className="mt-s2 flex min-h-0 flex-1 items-center justify-center">
          <FullScreenPicture scene={scene} />
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
);

// --- a drawing the operator can change ----------------------------------------------------

const LiveDrawing = ({
  id,
  host,
  drawing,
}: {
  readonly id: string;
  readonly host: DrawingHost;
  readonly drawing: QuestionDrawing;
}) => {
  const key = drawingKey(host.key, id);
  const [draft, setDraft] = useAtom(drawingDraftAtom(key));
  const opened = useAtomValue(drawingOpenAtom(key));
  const conflict = draft !== undefined && drawing.revision > draft.revision;
  const edit = (scene: string) =>
    setDraft({
      inboxId: host.inboxId,
      number: host.number,
      id,
      scene,
      // An edit keeps the revision it began on, so a conflict stands until
      // the operator settles it.
      revision: draft?.revision ?? drawing.revision,
    });
  return (
    <Figure
      id={id}
      marks={
        <>
          {draft !== undefined && (
            // On a phone it reads "Changed", the rest kept for a screen
            // reader and as the title.
            <span
              className="min-w-0 truncate text-11 text-orange"
              title="Changed · goes with your answer"
              data-drawing-changed
            >
              Changed
              <span className="compact:sr-only"> · goes with your answer</span>
            </span>
          )}
          {draft !== undefined && (
            <button
              type="button"
              className={`whitespace-nowrap ${headerButton()} ${focusRing}`}
              onClick={() => setDraft(undefined)}
              title="Throw your changes away and show the agent’s drawing"
            >
              REVERT
            </button>
          )}
        </>
      }
      open={
        <Editor
          id={id}
          drawingKey={key}
          scene={draft?.scene ?? drawing.scene}
          onEdit={edit}
        />
      }
      notice={
        conflict && (
          <Conflict
            onKeep={() => {
              if (draft !== undefined)
                setDraft({ ...draft, revision: drawing.revision });
            }}
            onTake={() => setDraft(undefined)}
          />
        )
      }
    >
      <DrawingPicture scene={opened ?? draft?.scene ?? drawing.scene} />
    </Figure>
  );
};

const Conflict = ({
  onKeep,
  onTake,
}: {
  readonly onKeep: () => void;
  readonly onTake: () => void;
}) => (
  <div
    role="alert"
    className="flex flex-wrap items-center gap-s2 border-t border-fg/10 px-s2 py-s1 text-12 text-orange"
    data-drawing-conflict
  >
    <span className="flex-1">
      The agent changed this drawing since you edited it.
    </span>
    <button
      type="button"
      className={`${headerButton()} ${focusRing}`}
      onClick={onKeep}
      title="Send your drawing, over the agent’s change"
    >
      KEEP MINE
    </button>
    <button
      type="button"
      className={`${headerButton()} ${focusRing}`}
      onClick={onTake}
      title="Throw your changes away and take the agent’s drawing"
    >
      TAKE THEIRS
    </button>
  </div>
);

// Excalidraw draws some of its own popovers and dialogs in containers of its
// own at the end of the page, outside the full-screen view: a press in one is
// not a press outside the editor.
const inExcalidraw = (event: Event | undefined): boolean =>
  event?.target instanceof Element &&
  event.target.closest('.excalidraw') !== null;

// The full-screen editor. Escape closes it when Excalidraw has nothing of its
// own to cancel (`DrawingEditor`); Base UI's Dialog closes it on CLOSE, on a
// press outside, and on an Escape the canvas did not take, and gives the
// caret back to ⤢.
const Editor = ({
  id,
  drawingKey: key,
  scene,
  onEdit,
}: {
  readonly id: string;
  readonly drawingKey: string;
  readonly scene: string;
  readonly onEdit: (scene: string) => void;
}) => {
  const [opened, setOpened] = useAtom(drawingOpenAtom(key));
  return (
    <Dialog.Root
      open={opened !== undefined}
      onOpenChange={(open, details) => {
        if (open) setOpened(scene);
        else if (
          details.reason === 'outside-press' &&
          inExcalidraw(details.event)
        )
          details.cancel();
        else setOpened(undefined);
      }}
    >
      <Dialog.Trigger
        className={`shrink-0 ${headerButton()} ${focusRing}`}
        aria-label="Edit the drawing full screen"
        title="Edit full screen"
      >
        ⤢
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-30 bg-fg/20" />
        <Dialog.Popup
          className="fixed inset-s4 z-40 flex flex-col border border-fg/20 bg-bg p-s3"
          data-drawing-editor={key}
          data-testid="drawing-editor"
        >
          <div className="flex items-baseline gap-s2">
            <Dialog.Title className={`flex-1 ${label}`}>
              Drawing · {id}
            </Dialog.Title>
            <Dialog.Close className={`${headerButton()} ${focusRing}`}>
              CLOSE
            </Dialog.Close>
          </div>
          <div className="mt-s2 min-h-0 flex-1 border border-fg/10">
            {opened !== undefined && (
              <EditorCanvas
                scene={opened}
                onEdit={onEdit}
                onClose={() => setOpened(undefined)}
              />
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

const EditorCanvas = ({
  scene,
  onEdit,
  onClose,
}: {
  readonly scene: string;
  readonly onEdit: (scene: string) => void;
  readonly onClose: () => void;
}) => {
  const canvas = useAtomValue(drawingCanvasAtom);
  if (AsyncResult.isSuccess(canvas)) {
    const { DrawingEditor } = canvas.value;
    return <DrawingEditor scene={scene} onEdit={onEdit} onClose={onClose} />;
  }
  if (AsyncResult.isFailure(canvas)) return <Failure cause={canvas.cause} />;
  return <Waiting text="Loading…" />;
};

// --- the picture ----------------------------------------------------------------------

const DRAWING_ALT = 'Excalidraw drawing';

const Waiting = ({ text }: { readonly text: string }) => (
  <p className="text-12 text-fg/45" data-drawing-waiting>
    {text}
  </p>
);

const Failure = ({ cause }: { readonly cause: Cause.Cause<unknown> }) => (
  <p className="text-12 text-red" role="alert">
    Could not draw this drawing: {String(Cause.squash(cause) ?? 'unknown')}
  </p>
);

// The inline picture, in a frame of the scene's own shape from the first
// render: the picture fills it when it arrives.
const DrawingPicture = ({ scene }: { readonly scene: string }) => {
  const result = useAtomValue(drawingPictureAtom(scene));
  const box = drawingBox(scene);
  if (AsyncResult.isFailure(result)) return <Failure cause={result.cause} />;
  const url = AsyncResult.isSuccess(result) ? result.value : undefined;
  if (box === undefined)
    // Nothing on it to measure: drawn at its own size, never taller than a
    // framed picture.
    return url === undefined ? (
      <Waiting text="Drawing…" />
    ) : (
      <img
        src={url}
        alt={DRAWING_ALT}
        className="mx-auto h-auto max-h-picture max-w-full"
        data-drawing-image
      />
    );
  return (
    <PictureFrame width={box.width} height={box.height}>
      {url === undefined ? (
        <div className="flex size-full items-center justify-center">
          <Waiting text="Drawing…" />
        </div>
      ) : (
        <img
          src={url}
          alt={DRAWING_ALT}
          className="size-full object-contain"
          data-drawing-image
        />
      )}
    </PictureFrame>
  );
};

const FullScreenPicture = ({ scene }: { readonly scene: string }) => {
  const result = useAtomValue(drawingPictureAtom(scene));
  if (AsyncResult.isSuccess(result))
    return (
      <img
        src={result.value}
        alt={DRAWING_ALT}
        className="size-full object-contain"
        data-drawing-image
      />
    );
  if (AsyncResult.isFailure(result)) return <Failure cause={result.cause} />;
  return <Waiting text="Drawing…" />;
};
