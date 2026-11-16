import { Collapsible } from '@base-ui/react/collapsible';
import { Dialog } from '@base-ui/react/dialog';
import { useAtomValue } from '@effect/atom-react';
import type { InboxViewDto } from '@operator-inbox/core/api';
import { Cause } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { mermaidImageAtom } from '../mermaid';
import { RenderedBody } from './rendered-body';
import { focusRing, headerButton, label } from './styles';

// An inbox question's body. The server sends it as parts (core's
// `renderQuestionParts`): rendered markdown, and each ```mermaid fence as its
// source. Without parts, the body is its HTML alone.

type AnyQuestion =
  | InboxViewDto['awaitingOperator'][number]
  | InboxViewDto['awaitingAgent'][number]
  | InboxViewDto['processed'][number];

export const QuestionBody = ({
  question,
  className,
}: {
  readonly question: AnyQuestion;
  readonly className: string;
}) => {
  const parts = question.bodyParts;
  if (parts === undefined)
    // Server-rendered HTML; see `RenderedBody` for the escaping promise it
    // rests on.
    return <RenderedBody html={question.bodyHtml} className={className} />;
  return (
    <div className={className}>
      {parts.map((part, i) =>
        part.kind === 'html' ? (
          // Parts never reorder, so the index is a stable key.
          // biome-ignore lint/suspicious/noArrayIndexKey: as above
          <RenderedBody key={i} html={part.html} className="" />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: as above
          <MermaidDiagram key={i} source={part.source} />
        ),
      )}
    </div>
  );
};

// A diagram, folded by default: it opens like an accordion, and has a full
// screen view. Base UI's Collapsible is the fold and its Dialog the full
// screen view. The panel is mounted only while open, so a closed diagram is
// never drawn and Mermaid is not loaded for it.
const MermaidDiagram = ({ source }: { readonly source: string }) => (
  <Collapsible.Root className="my-s2 border border-fg/13" data-mermaid>
    <div className="flex items-center gap-s2 px-s2 py-0.5">
      <Collapsible.Trigger
        className={`group flex flex-1 cursor-pointer items-baseline gap-s1 text-left ${focusRing}`}
      >
        <span className="w-2 text-11 text-fg/45 group-data-panel-open:hidden">
          ▸
        </span>
        <span className="hidden w-2 text-11 text-fg/45 group-data-panel-open:inline">
          ▾
        </span>
        <span className={label}>Diagram</span>
      </Collapsible.Trigger>
      <FullScreen source={source} />
    </div>
    <Collapsible.Panel className="border-t border-fg/10 p-s2">
      <MermaidImage source={source} fill={false} />
    </Collapsible.Panel>
  </Collapsible.Root>
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
          <MermaidImage source={source} fill />
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
);

// The drawing, or what stands in for it: "Drawing…" while Mermaid works, and
// its reason with the source when it cannot draw. `fill` scales the image to
// the space it is given (the full-screen view); otherwise it is never wider
// than the card.
const MermaidImage = ({
  source,
  fill,
}: {
  readonly source: string;
  readonly fill: boolean;
}) => {
  const result = useAtomValue(mermaidImageAtom(source));
  if (AsyncResult.isSuccess(result))
    return (
      <img
        src={result.value}
        alt="Mermaid diagram"
        className={
          fill ? 'size-full object-contain' : 'mx-auto h-auto max-w-full'
        }
        data-mermaid-image
      />
    );
  if (AsyncResult.isFailure(result))
    return (
      <div className="text-12" role="alert">
        <p className="text-red">
          Could not draw this diagram:{' '}
          {String(Cause.squash(result.cause) ?? 'unknown')}
        </p>
        <pre className="mt-s1 overflow-x-auto text-11 whitespace-pre text-fg/60">
          {source}
        </pre>
      </div>
    );
  return <p className="text-12 text-fg/45">Drawing…</p>;
};
