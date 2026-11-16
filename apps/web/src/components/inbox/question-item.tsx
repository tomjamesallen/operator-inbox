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
// left of the question's first line, past its dots. Pinned, the sidebar holds
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
      className={`flex shrink-0 items-center ${gutter ? '@code-gutter:absolute @code-gutter:top-full @code-gutter:right-full @code-gutter:mt-s2 @code-gutter:mr-s5 @code-gutter:block @code-gutter:font-reading @code-gutter:text-18 @code-gutter:leading-card' : ''}`}
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
          {code}
        </button>
      </Tip>
    </span>
  );
};

// `desktop · atlas › group`: Local is not named, and one machine names nothing.
// Each crumb picks what it names, as its sidebar row would: the Inbox, or the
// Inbox narrowed to the group. The reader stays on this question.
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
  return (
    // On a narrow screen the inbox takes the first line and the rest the next.
    // `relative`: the code's gutter place is measured from here.
    <div className="relative flex items-center gap-s1 text-11 text-fg/40 compact:flex-wrap">
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
        className={`min-w-0 cursor-pointer truncate text-left hover:text-fg compact:w-full ${focusRing}`}
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
          <span className="shrink-0 compact:hidden">›</span>
          <button
            type="button"
            data-zen-group
            title={`Show only ${group} in ${item.inboxLabel}`}
            onClick={(e) => {
              e.stopPropagation();
              pick({ key: item.key, inboxId: item.inboxId, group });
            }}
            className={`shrink-0 cursor-pointer text-fg/60 hover:text-fg ${focusRing}`}
          >
            {group}
          </button>
        </>
      )}
      {note !== undefined && (
        <span className="min-w-0 truncate text-yellow">· {note}</span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-s2">
        <CodeCopy item={item} />
      </span>
    </div>
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
      <h1 className="text-18 leading-card font-medium text-fg">{title}</h1>
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

// Beside a question, and it fades with it.
const Dots = ({ item }: { readonly item: ReaderItem }) => (
  <MarkStack marks={useMarks(item)} className="absolute top-s1 -left-s4" />
);

// The flow sets how much of each question shows (`paint`), straight on this div
// and before the browser draws it, so nothing here says so.
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
      className="relative data-zen-dark:pointer-events-none"
    >
      <Dots item={item} />
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
    </div>
  ),
);
