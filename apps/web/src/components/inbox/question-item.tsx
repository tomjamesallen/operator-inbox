import { useAtomSet, useAtomValue } from '@effect/atom-react';
import {
  LOCAL_MACHINE_KEY,
  type MacroArg,
  type MacroInvoked,
  type QuestionComment,
  questionRef,
} from '@operator-inbox/core/api';
import { memo, type ReactNode } from 'react';
import {
  copyMarkAtom,
  copyQuestionAtom,
  DEFAULT_GROUP,
  drawnBoardAtom,
  groupOf,
  questionClipText,
} from '../../inbox';
import { pickCrumbAtom } from '../../inbox-rail';
import {
  answerOf,
  followUpsOf,
  headOf,
  heldKeyAtom,
  isSending,
  linkKeyAtom,
  type ReaderItem,
  railStateAtom,
  shownQueuesAtom,
} from '../../inbox-reader';
import { inboxReaderAtoms } from '../../inbox-reader-machine';
import { keyHintAtom } from '../../keymap';
import { QuestionBody } from '../question-body';
import { focusRing } from '../styles';
import { Colophon } from './colophon';
import { CommentableBody, CommentedBody } from './comment-body';
import { ICON_DONE, ICON_FAILED, Icon, Tip } from './icon';
import { HIGHLIGHT, type Mark, MarkStack, SELECTED } from './marks';
import { ReadoutLayer } from './readout-layer';
import {
  CRUMB_BOX,
  CrumbRow,
  crumbOf,
  crumbScopeAtom,
  MARKED,
} from './scope-crumb';

const highlightOf = (item: ReaderItem) =>
  'highlight' in item.question ? item.question.highlight : undefined;

/** A question's own marks, which stay findable while another is focused. */
export const useMarks = (item: ReaderItem): ReadonlyArray<Mark> => {
  const linkKey = useAtomValue(linkKeyAtom);
  return [
    ...(highlightOf(item) === undefined ? [] : [HIGHLIGHT]),
    ...(item.key === linkKey ? [SELECTED] : []),
  ];
};

// A question's code, `xyz#12` (`#12` while its Inbox has none), and the
// control that copies its text for discussing it with the agent's session:
// the code underlined, and ✓ or ✗ beside it for a moment once clicked, in a
// slot kept empty until then, so the click shifts nothing.
//
// It sits at the end of the eyebrow. With room in the reader's column
// (`@code-gutter:`, a container query on the flow), it moves out to the gutter
// left of the question's first line, right-aligned with the breadcrumb's
// queue icon: the breadcrumb row reaches s2 into the margin, so
// the code hangs from its edge, s2 from the text. Pinned, the sidebar holds
// that gutter, so the code stays in the eyebrow. Over the page (a hover's peek,
// or a drawer) the sidebar is passing, and the code stays where it was: moving
// it would reflow the question under the pointer.
const CodeCopy = ({ item }: { readonly item: ReaderItem }) => {
  const mark = useAtomValue(copyMarkAtom(item.key));
  const copy = useAtomSet(copyQuestionAtom(item.key));
  const hint = useAtomValue(keyHintAtom('copy_question'));
  const gutter = useAtomValue(railStateAtom) !== 'docked';
  const code = questionRef(item.inboxCode, item.question.number);
  return (
    <span
      data-question-code-place={gutter ? 'gutter' : 'eyebrow'}
      className={`flex shrink-0 items-center ${gutter ? '@code-gutter:absolute @code-gutter:top-full @code-gutter:right-full @code-gutter:mt-s2 @code-gutter:block @code-gutter:font-reading @code-gutter:text-18 @code-gutter:leading-card' : ''}`}
    >
      <Tip label="Copy for the agent session" keys={hint.first}>
        <button
          type="button"
          aria-label={`Copy ${code} for the agent session`}
          data-mark={mark}
          data-copy
          data-question-code={code}
          onClick={() => copy(questionClipText(item.inboxId, item.question))}
          className={`inline-flex cursor-pointer items-center gap-1 font-zen text-11 whitespace-nowrap tabular-nums underline decoration-current/40 underline-offset-2 focus-visible:decoration-current ${mark === 'ok' ? 'text-green' : mark === 'bad' ? 'text-red' : 'text-fg/40 hover:text-fg focus-visible:text-fg'}`}
        >
          {/* The mark's slot is always there, hidden while idle, so a click
              moves nothing: the icon is taller than the code's line. */}
          <span
            data-copy-mark
            className={`inline-flex ${mark === 'idle' ? 'invisible' : ''}`}
          >
            <Icon d={mark === 'bad' ? ICON_FAILED : ICON_DONE} />
          </span>
          {/* The button's baseline is the code's own, not the bottom of the
              mark's icon, which would sit the button lower than the
              eyebrow's text and make the eyebrow taller with the code in it
              than in the gutter: the question would move as the code does. */}
          <span data-question-code-text className="self-baseline">
            {code}
          </span>
        </button>
      </Tip>
    </span>
  );
};

// `desktop · atlas › group`: Local is not named, and one machine names nothing.
// Each crumb picks what it names, as its sidebar row would: the Inbox, or the
// Inbox narrowed to the group. The reader stays on this question.
//
// It also shows the page's scope (`scope-crumb.tsx`): the crumbs in it are
// underlined in yellow, a breadcrumb in the selected Inbox sticks under the
// header while its Question is in view, and while it is stuck the crumbs
// outside the scope fade.
const Eyebrow = ({ item }: { readonly item: ReaderItem }) => {
  const board = useAtomValue(drawnBoardAtom);
  const heldKey = useAtomValue(heldKeyAtom);
  const pick = useAtomSet(pickCrumbAtom);
  const held = item.key === heldKey;
  const greyed = board?.greyed.has(item.machine) === true;
  const machine =
    (board?.machines?.length ?? 0) > 1 && item.machine !== LOCAL_MACHINE_KEY
      ? board?.machines?.find((m) => m.key === item.machine)?.label
      : undefined;
  const group = groupOf(item.question);
  const note = highlightOf(item)?.note;
  const scope = crumbOf(useAtomValue(crumbScopeAtom), item.inboxId, group);
  const sticky = scope.inbox;
  const fades = sticky
    ? 'transition-opacity group-data-stuck/crumb:opacity-0'
    : '';
  const marks = useMarks(item);
  return (
    // On a narrow screen the inbox takes the first line and the rest the next.
    // `relative` (the row's own): the code's gutter place is measured from here.
    <CrumbRow
      sticky={sticky}
      marks={marks.length > 0 ? <MarkStack marks={marks} /> : undefined}
      className={`flex items-center gap-s1 text-11 text-fg/40 compact:flex-wrap ${CRUMB_BOX} ${sticky ? 'group/crumb sticky top-crumb-top z-20' : ''}`}
    >
      {/* Short of room the inbox's name gives way, so the group still shows.
          A crumb's click is its own: the card's would light the question. */}
      <button
        type="button"
        data-zen-eyebrow
        title={`Show only ${item.inboxLabel}`}
        onClick={(e) => {
          e.stopPropagation();
          pick({ key: item.key, inboxId: item.inboxId });
        }}
        data-crumb-scope={scope.inbox || undefined}
        className={`min-w-0 cursor-pointer truncate text-left hover:text-fg compact:w-full ${scope.inbox ? MARKED : ''} ${focusRing}`}
      >
        {machine !== undefined && (
          <>
            {(greyed || held) && (
              <span
                className={`mr-s1 inline-block size-1.5 rounded-full align-middle ${held ? 'bg-red' : 'bg-orange'}`}
              />
            )}
            <span data-zen-machine className="text-fg/70">
              {machine}
            </span>
            <span className="mx-s1">·</span>
          </>
        )}
        {item.inboxLabel}
      </button>
      {group !== DEFAULT_GROUP && (
        <>
          <span
            className={`shrink-0 compact:hidden ${scope.group ? '' : fades}`}
          >
            ›
          </span>
          <button
            type="button"
            data-zen-group
            title={`Show only ${group} in ${item.inboxLabel}`}
            onClick={(e) => {
              e.stopPropagation();
              pick({ key: item.key, inboxId: item.inboxId, group });
            }}
            data-crumb-scope={scope.group || undefined}
            className={`shrink-0 cursor-pointer text-fg/60 hover:text-fg ${scope.group ? MARKED : fades} ${focusRing}`}
          >
            {group}
          </button>
        </>
      )}
      {note !== undefined && (
        <span className={`min-w-0 truncate text-yellow ${fades}`}>
          · {note}
        </span>
      )}
      <span className={`ml-auto flex shrink-0 items-center gap-s2 ${fades}`}>
        <CodeCopy item={item} />
      </span>
    </CrumbRow>
  );
};

// An argument as the card showed it; one left empty went to the agent.
const argText = (value: MacroArg): string =>
  value === null
    ? '—'
    : Array.isArray(value)
      ? value.join(', ')
      : String(value);

// The macros an answer carried, one line each: `/name` and its arguments.
const SentMacros = ({
  macros,
}: {
  readonly macros: ReadonlyArray<MacroInvoked>;
}) => (
  <ul className="mt-s1 flex flex-col gap-0.5 font-zen text-12" data-sent-macros>
    {macros.map((m, i) => (
      <li
        // Macros carry no id of their own; their place is what they are.
        // biome-ignore lint/suspicious/noArrayIndexKey: the list never reorders
        key={`${i}:${m.macro}`}
        className="flex flex-wrap items-baseline gap-x-s2"
        title={`Tells the agent: ${m.instruction}`}
      >
        <span className="font-medium text-fg/80">/{m.macro}</span>
        {Object.entries(m.args).map(([name, value]) => (
          <span key={name} className="text-fg/55">
            <span className="text-fg/35">{name}</span> {argText(value)}
          </span>
        ))}
      </li>
    ))}
  </ul>
);

// The comments an answer carried, numbered as the body's highlights are: the
// quote, then what was said about it.
const SentComments = ({
  comments,
}: {
  readonly comments: ReadonlyArray<QuestionComment>;
}) => (
  <ol
    className="mt-s1 flex flex-col gap-0.5 font-zen text-12"
    data-sent-comments
  >
    {comments.map((c, i) => (
      <li
        // Comments carry no id of their own; their place is what they are.
        key={i}
        className="flex items-baseline gap-s2"
      >
        <span className="shrink-0 font-medium text-yellow">❝ {i + 1}</span>
        <span className="min-w-0">
          <span className="text-fg/40 italic">“{c.quote}”</span>{' '}
          <span className="whitespace-pre-wrap text-fg/70">{c.text}</span>
        </span>
      </li>
    ))}
  </ol>
);

const Said = ({
  label,
  text,
  macros = [],
  comments = [],
  className,
}: {
  readonly label: string;
  readonly text: string;
  readonly macros?: ReadonlyArray<MacroInvoked>;
  readonly comments?: ReadonlyArray<QuestionComment>;
  readonly className: string;
}) => (
  <div className={`${className} max-w-measure text-14 leading-prose`}>
    <p className="font-zen text-11 text-fg/40">{label}</p>
    {text !== '' && (
      <p className="mt-s1 whitespace-pre-wrap text-fg/80">{text}</p>
    )}
    {comments.length > 0 && <SentComments comments={comments} />}
    {macros.length > 0 && <SentMacros macros={macros} />}
  </div>
);

// A body waiting on the operator takes comments; an answered one shows the
// comments its answer carried, read-only; any other is the body alone.
const BodyFrame = ({
  item,
  state,
  comments,
  children,
}: {
  readonly item: ReaderItem;
  readonly state: 'open' | 'sending' | 'answered';
  readonly comments: ReadonlyArray<QuestionComment>;
  readonly children: ReactNode;
}) =>
  state === 'open' ? (
    <CommentableBody itemKey={item.key}>{children}</CommentableBody>
  ) : comments.length > 0 ? (
    <CommentedBody itemKey={item.key} comments={comments}>
      {children}
    </CommentedBody>
  ) : (
    children
  );

const Content = ({ item }: { readonly item: ReaderItem }) => {
  const queues = useAtomValue(shownQueuesAtom);
  const send = useAtomSet(inboxReaderAtoms.send);
  const { title, caption, followsUp } = headOf(item);
  const answer = answerOf(item);
  const state = isSending(item)
    ? 'sending'
    : 'answeredSeq' in item.question || 'processedSeq' in item.question
      ? 'answered'
      : 'open';
  return (
    <>
      {caption !== undefined && (
        <p className="font-zen text-11 text-fg/40">{caption}</p>
      )}
      <h1 className="text-18 leading-card font-medium text-balance text-fg">
        {title}
      </h1>
      {followsUp !== undefined && (
        <button
          type="button"
          data-zen-follows-up
          onClick={(e) => {
            e.stopPropagation();
            send({ type: 'MovedTo', key: followsUp });
          }}
          className="mt-s1 cursor-pointer font-zen text-11 text-fg/40 underline decoration-fg/25 hover:text-fg"
        >
          Follow-up to #{followsUp.slice(followsUp.lastIndexOf('/') + 1)}
        </button>
      )}
      <BodyFrame item={item} state={state} comments={answer?.comments ?? []}>
        {/* Where listen mode finds the body's parts (`readout/locate.ts`). */}
        <div data-readout-body>
          <QuestionBody
            question={item.question}
            className="mt-s4 text-14 leading-prose text-fg/80"
            drawingHost={{
              inboxId: item.inboxId,
              number: item.question.number,
              key: item.key,
              state,
            }}
          />
        </div>
      </BodyFrame>
      {answer !== undefined &&
        (answer.text !== '' ||
          answer.macros.length > 0 ||
          answer.comments.length > 0) && (
          <Said
            className="mt-s5"
            label={answer.label}
            text={answer.text}
            macros={answer.macros}
            comments={answer.comments}
          />
        )}
      {followUpsOf(queues, item).map((f) => (
        <Said
          key={f.key}
          className="mt-s4"
          label="You followed up:"
          text={f.text}
        />
      ))}
    </>
  );
};

// The flow sets how much of each question shows (`paint`), straight on this div
// and before the browser draws it, so nothing here says so. The div reaches
// into the gutter on its left (`-ml-code-gutter pl-code-gutter`), so the code
// that hangs there is inside its box as well as inside it: WebKit drops a
// box's opacity from a repaint that does not touch the box, and drew the code
// at full strength beside its faded question.
export const QuestionItem = memo(
  ({
    item,
    lit,
    onPick,
  }: {
    readonly item: ReaderItem;
    readonly lit: boolean;
    readonly onPick: (key: string) => void;
  }) => (
    <div
      data-zen-item={item.key}
      className="-ml-code-gutter pl-code-gutter data-zen-dark:pointer-events-none"
    >
      {/* `relative`: listen mode's cursor is drawn over the question, not the
          gutter. While a tap seeks, the question shows a pointer. */}
      <div className="relative data-readout-scrub:cursor-pointer">
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the keys and the minimap move the focus too */}
        <article
          data-zen-lit={lit || undefined}
          onClick={() => {
            if (!lit) onPick(item.key);
          }}
          className={lit ? undefined : 'cursor-pointer'}
        >
          <Eyebrow item={item} />
          <div className="mt-s2 font-reading">
            <Content item={item} />
          </div>
          <Colophon item={item} lit={lit} />
        </article>
        {/* After the article, so it draws over the body's own positioned
            blocks (a wide table, a figure). */}
        <ReadoutLayer item={item} />
      </div>
    </div>
  ),
);
