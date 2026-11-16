import { useAtomSet, useAtomValue } from '@effect/atom-react';
import { LOCAL_MACHINE_KEY } from '@operator-inbox/core/api';
import { memo } from 'react';
import {
  copyMarkAtom,
  copyQuestionAtom,
  DEFAULT_GROUP,
  drawnBoardAtom,
  groupOf,
  questionClipText,
} from '../../inbox';
import {
  answerOf,
  followUpsOf,
  headOf,
  heldKeyAtom,
  linkKeyAtom,
  type ReaderItem,
  shownQueuesAtom,
} from '../../inbox-reader';
import { inboxReaderAtoms } from '../../inbox-reader-machine';
import { keyHintAtom } from '../../keymap';
import { QuestionBody } from '../question-body';
import { Colophon } from './colophon';
import { ICON_COPY, ICON_DONE, ICON_FAILED, Icon, Tip } from './icon';
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

// A question's ⧉: its text, for discussing it with the agent's session.
const CopyItem = ({ item }: { readonly item: ReaderItem }) => {
  const mark = useAtomValue(copyMarkAtom(item.key));
  const copy = useAtomSet(copyQuestionAtom(item.key));
  const hint = useAtomValue(keyHintAtom('copy_question'));
  const { number } = item.question;
  return (
    <Tip label="Copy for the agent session" keys={hint.first}>
      <button
        type="button"
        aria-label={`Copy #${number} for the agent session`}
        data-mark={mark}
        data-copy
        onClick={() => copy(questionClipText(item.inboxId, item.question))}
        className={`flex cursor-pointer items-center ${mark === 'ok' ? 'text-green' : mark === 'bad' ? 'text-red' : 'text-fg/30 hover:text-fg'}`}
      >
        <Icon
          d={
            mark === 'ok' ? ICON_DONE : mark === 'bad' ? ICON_FAILED : ICON_COPY
          }
        />
      </button>
    </Tip>
  );
};

// `desktop · atlas › group`: Local is not named, and one machine names nothing.
const Eyebrow = ({ item }: { readonly item: ReaderItem }) => {
  const board = useAtomValue(drawnBoardAtom);
  const heldKey = useAtomValue(heldKeyAtom);
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
    <div className="flex items-center gap-s1 text-11 text-fg/40 compact:flex-wrap">
      {/* Short of room the inbox's name gives way, so the group still shows. */}
      <span className="min-w-0 truncate compact:w-full" data-zen-eyebrow>
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
      </span>
      {group !== DEFAULT_GROUP && (
        <>
          <span className="shrink-0 compact:hidden">›</span>
          <span data-zen-group className="shrink-0 text-fg/60">
            {group}
          </span>
        </>
      )}
      {note !== undefined && (
        <span className="min-w-0 truncate text-yellow">· {note}</span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-s2">
        <CopyItem item={item} />
      </span>
    </div>
  );
};

const Said = ({
  label,
  text,
  className,
}: {
  readonly label: string;
  readonly text: string;
  readonly className: string;
}) => (
  <div className={`${className} max-w-measure text-14 leading-prose`}>
    <p className="font-zen text-11 text-fg/40">{label}</p>
    <p className="mt-s1 whitespace-pre-wrap text-fg/80">{text}</p>
  </div>
);

const Content = ({ item }: { readonly item: ReaderItem }) => {
  const queues = useAtomValue(shownQueuesAtom);
  const send = useAtomSet(inboxReaderAtoms.send);
  const { title, caption, followsUp } = headOf(item);
  const answer = answerOf(item);
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
      <QuestionBody
        question={item.question}
        className="mt-s4 text-14 leading-prose text-fg/80"
      />
      {answer !== undefined && answer.text !== '' && (
        <Said className="mt-s5" label={answer.label} text={answer.text} />
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
