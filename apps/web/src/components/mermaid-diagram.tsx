import { Dialog } from '@base-ui/react/dialog';
import { useAtomValue } from '@effect/atom-react';
import { Cause } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { mermaidImageAtom, mermaidReservedSizeAtom } from '../mermaid';
import { PictureFrame } from './picture-frame';
import { focusRing, headerButton, label } from './styles';

// A diagram, drawn inline as a picture the column's width, in the frame every
// picture in a body shares (`PictureFrame`), with a full-screen view one click
// away: Base UI's Dialog, which takes Escape to close and gives the caret back
// to ⤢. The drawing is started when the board arrives (`mermaidPrefetchAtom`),
// so by the time a question is drawn its diagram usually is too.
export const MermaidDiagram = ({ source }: { readonly source: string }) => (
  <figure className="my-s2 border border-fg/13" data-mermaid>
    <div className="flex items-center gap-s2 px-s2 py-0.5">
      <span className={`flex-1 ${label}`}>Diagram</span>
      <FullScreen source={source} />
    </div>
    <div className="border-t border-fg/10 p-s2">
      <MermaidPicture source={source} />
    </div>
  </figure>
);

const FullScreen = ({ source }: { readonly source: string }) => (
  <Dialog.Root>
    <Dialog.Trigger
      className={`${headerButton()} ${focusRing}`}
      aria-label="Show the diagram full screen"
      title="Full screen"
    >
      ⤢
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-30 bg-fg/20" />
      <Dialog.Popup
        className="fixed inset-s4 z-40 flex flex-col border border-fg/20 bg-bg p-s3"
        data-testid="mermaid-full-screen"
      >
        <div className="flex items-baseline gap-s2">
          <Dialog.Title className={`flex-1 ${label}`}>Diagram</Dialog.Title>
          <Dialog.Close className={`${headerButton()} ${focusRing}`}>
            CLOSE
          </Dialog.Close>
        </div>
        <div className="mt-s2 flex min-h-0 flex-1 items-center justify-center">
          <FullScreenImage source={source} />
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
);

const MERMAID_ALT = 'Mermaid diagram';

// The inline picture. Its frame is sized before the drawing arrives when the
// size is known, from this browser's memory of the source: so the question
// mounts at the height it will keep. With no size known yet, a line stands in.
// A diagram Mermaid cannot draw shows the reason and its source instead.
const MermaidPicture = ({ source }: { readonly source: string }) => {
  const result = useAtomValue(mermaidImageAtom(source));
  const reserved = useAtomValue(mermaidReservedSizeAtom(source));
  if (AsyncResult.isFailure(result))
    return <Failure source={source} cause={result.cause} />;
  const drawing = AsyncResult.isSuccess(result) ? result.value : undefined;
  const size = drawing?.size ?? reserved;
  if (drawing !== undefined && size === undefined)
    // An SVG with no size of its own: drawn at its own, never taller than a
    // framed picture.
    return (
      <img
        src={drawing.url}
        alt={MERMAID_ALT}
        className="mx-auto h-auto max-h-picture max-w-full"
        data-mermaid-image
      />
    );
  if (size === undefined) return <Drawing />;
  return (
    <PictureFrame width={size.width} height={size.height}>
      {drawing === undefined ? (
        <div className="flex size-full items-center justify-center">
          <Drawing />
        </div>
      ) : (
        <img
          src={drawing.url}
          alt={MERMAID_ALT}
          className="size-full object-contain"
          data-mermaid-image
        />
      )}
    </PictureFrame>
  );
};

// The full-screen picture, scaled to the space the view gives it.
const FullScreenImage = ({ source }: { readonly source: string }) => {
  const result = useAtomValue(mermaidImageAtom(source));
  if (AsyncResult.isSuccess(result))
    return (
      <img
        src={result.value.url}
        alt={MERMAID_ALT}
        className="size-full object-contain"
        data-mermaid-image
      />
    );
  if (AsyncResult.isFailure(result))
    return <Failure source={source} cause={result.cause} />;
  return <Drawing />;
};

const Drawing = () => (
  <p className="text-12 text-fg/45" data-mermaid-drawing>
    Drawing…
  </p>
);

const Failure = ({
  source,
  cause,
}: {
  readonly source: string;
  readonly cause: Cause.Cause<unknown>;
}) => (
  <div className="text-12" role="alert">
    <p className="text-red">
      Could not draw this diagram: {String(Cause.squash(cause) ?? 'unknown')}
    </p>
    <pre className="mt-s1 overflow-x-auto text-11 whitespace-pre text-fg/60">
      {source}
    </pre>
  </div>
);
