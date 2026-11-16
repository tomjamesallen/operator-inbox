import { Dialog } from '@base-ui/react/dialog';
import { Menu } from '@base-ui/react/menu';
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import {
  type InboxId,
  type InboxMachineRef,
  type InboxMetadataRules,
  type Metadata,
  machineKeyOf,
} from '@operator-inbox/core/api';
import type { ReactNode } from 'react';
import { clockAtom, nowMillis } from '../../clock';
import { agoOf, drawnBoardAtom } from '../../inbox';
import {
  type MetaNode,
  type MetaPair,
  metaNodeOf,
  metaPairsOf,
  questionOnlyOf,
} from '../../inbox-metadata-view';
import {
  colophonOpenAtom,
  inboxMetaCardAtom,
  isAsked,
  metadataRulesAtom,
  type ReaderItem,
} from '../../inbox-reader';
import { keyHintAtom } from '../../keymap';
import { Icon, Tip } from './icon';
import { OpenSession } from './open-session';

// The end of a question, out of reading's way: when it last changed. Its `<>`
// sits over the box with its session, and brings up (as the keys do) a card of
// all its metadata, one key to a line under the Question's heading and the
// Inbox's, and its history. An empty queue has the Inbox's group alone, beside
// the Inbox's name over the box.

const Node = ({ node }: { readonly node: MetaNode }) => {
  switch (node._tag) {
    case 'Text':
      return node.text;
    case 'Link':
      return (
        <a
          href={node.href}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-fg/25 hover:text-fg"
        >
          {node.text}
        </a>
      );
    case 'List':
      return (
        <>
          {node.items.map((item, i) => (
            // A list is drawn in its order and never reordered.
            <span key={i} className="mr-s2 last:mr-0">
              <Node node={item} />
            </span>
          ))}
        </>
      );
    case 'Fields':
      return (
        <>
          {node.fields.map((f) => (
            <span key={f.key} className="mr-s2 last:mr-0">
              <span className="text-fg/30">{f.key}</span> <Node node={f.node} />
            </span>
          ))}
        </>
      );
  }
};

// A key's name and its value on one line, the names of a colophon in one
// column. A phone has no room for the column, so the name goes above.
const Line = ({
  name,
  children,
}: {
  readonly name: string;
  readonly children: ReactNode;
}) => (
  <>
    <span className="w-18 shrink-0 wrap-anywhere text-fg/30 compact:w-full">
      {name}
    </span>{' '}
    <span className="min-w-0 flex-1 wrap-anywhere text-fg/55 compact:w-full">
      {children}
    </span>
  </>
);

const LINE = 'flex items-baseline gap-s2 py-0.5 compact:flex-col compact:gap-0';

const Pairs = ({ pairs }: { readonly pairs: ReadonlyArray<MetaPair> }) =>
  pairs.map(({ key, value }) => (
    <div key={key} className={LINE} data-zen-meta-key={key}>
      <Line name={key}>
        <Node node={metaNodeOf(value)} />
      </Line>
    </div>
  ));

const Toggle = ({
  open,
  onToggle,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
}) => {
  const hint = useAtomValue(keyHintAtom('toggle_metadata'));
  // Not on a touch screen, by the device: there it is a line of the ⋯ menu.
  return (
    <span className="flex shrink-0 pointer-coarse:hidden">
      <Tip label="Metadata" keys={hint.first}>
        <button
          type="button"
          aria-label="Metadata"
          aria-keyshortcuts={hint.aria}
          data-zen-meta-more
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className={`flex cursor-pointer items-center ${open ? 'text-fg' : 'text-fg/30 hover:text-fg'}`}
        >
          <Icon d="M8 7l-5 5 5 5M16 7l5 5-5 5" />
        </button>
      </Tip>
    </span>
  );
};

/** When it was asked, answered and processed. */
const timesOf = (item: ReaderItem, now: number) => {
  const q = item.question;
  const answered = 'answeredAt' in q ? q.answeredAt : undefined;
  const processed = 'processedAt' in q ? q.processedAt : undefined;
  const withdrawn = 'withdrawn' in q && q.withdrawn;
  // An operator's question is asked and answered at once: one time.
  const asked = isAsked(q);
  return [
    { verb: 'Asked', at: q.askedAt },
    { verb: 'Answered', at: asked ? undefined : answered },
    { verb: withdrawn ? 'Withdrawn' : 'Processed', at: processed },
  ].flatMap((t) => {
    const ago = agoOf(t.at, now);
    return ago === undefined ? [] : [{ ...t, ago }];
  });
};

interface Group {
  readonly level: string;
  readonly title: string;
  readonly pairs: ReadonlyArray<MetaPair>;
}

type Times = ReturnType<typeof timesOf>;

const History = ({ times }: { readonly times: Times }) => (
  <section data-zen-meta-level="history">
    <p className="pb-0.5 font-medium text-fg/55">History</p>
    <ul>
      {times.map((t) => (
        <li
          key={t.verb}
          title={t.at}
          className="flex items-center gap-s2 py-0.5 text-fg/55"
          data-zen-history
        >
          <span className="size-1 shrink-0 rounded-full bg-fg/30" />
          {t.verb} {t.ago}
        </li>
      ))}
    </ul>
  </section>
);

const Card = ({
  groups,
  times,
  open,
  onOpenChange,
}: {
  readonly groups: ReadonlyArray<Group>;
  readonly times: Times;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) => (
  <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-30 bg-fg/20" />
      <Dialog.Popup
        className="fixed inset-x-s4 top-1/2 z-40 mx-auto flex max-h-dialog max-w-subtitle -translate-y-1/2 flex-col gap-s3 overflow-y-auto border border-fg/20 bg-rail p-s4 text-left font-zen text-11 text-fg/90"
        data-zen-meta-card
      >
        <Dialog.Title className="sr-only">Metadata</Dialog.Title>
        {groups.map(({ level, title, pairs }) => (
          <section key={level} data-zen-meta-level={level}>
            <p className="pb-0.5 font-medium text-fg/55">{title}</p>
            <Pairs pairs={pairs} />
          </section>
        ))}
        {times.length > 0 && <History times={times} />}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
);

// `<>` and the card it brings up, when there is anything to put on it.
const MetaToggle = ({
  groups,
  times,
  lit,
}: {
  readonly groups: ReadonlyArray<Group>;
  readonly times: Times;
  readonly lit: boolean;
}) => {
  const [wanted, setOpen] = useAtom(colophonOpenAtom);
  const drawn = groups.filter((g) => g.pairs.length > 0);
  if (drawn.length + times.length === 0) return null;
  const open = wanted && lit;
  return (
    <>
      <Toggle open={open} onToggle={() => setOpen(!wanted)} />
      <Card groups={drawn} times={times} open={open} onOpenChange={setOpen} />
    </>
  );
};

/** An Inbox's group: its metadata, and the machine it is on. */
const inboxGroupOf = (
  rules: InboxMetadataRules,
  machines: ReadonlyArray<InboxMachineRef> | undefined,
  metadata: Metadata,
  key: string,
): Group => {
  const machine = machines?.find((m) => m.key === key)?.label;
  const named =
    (machines?.length ?? 0) > 1 && machine !== undefined
      ? [{ key: 'machine', value: machine }]
      : [];
  return {
    level: 'inbox',
    title: 'Inbox',
    pairs: [...named, ...metaPairsOf(rules, metadata)],
  };
};

export const Colophon = ({
  item,
  lit,
}: {
  readonly item: ReaderItem;
  readonly lit: boolean;
}) => {
  const rules = useAtomValue(metadataRulesAtom);
  const board = useAtomValue(drawnBoardAtom);
  const now = nowMillis(useAtomValue(clockAtom));
  const inboxMeta =
    board?.views.find((v) => v.inboxId === item.inboxId)?.metadata ?? {};
  const [open, setOpen] = useAtom(colophonOpenAtom);
  const times = timesOf(item, now);
  const latest = times.at(-1);
  return (
    <div
      className="mt-s4 flex items-center justify-between gap-s2 font-zen text-11 text-fg/40"
      data-zen-meta="colophon"
    >
      {latest !== undefined && (
        <span title={latest.at} data-zen-when>
          {latest.verb} {latest.ago}
        </span>
      )}
      {/* Its `<>` is over the box (`LitActions`); the card is the lit question's. */}
      <Card
        open={open && lit}
        onOpenChange={setOpen}
        times={times}
        groups={[
          {
            level: 'question',
            title: 'Question',
            pairs: metaPairsOf(
              rules,
              questionOnlyOf(item.question.metadata, inboxMeta),
            ),
          },
          inboxGroupOf(rules, board?.machines, inboxMeta, item.machine),
        ].filter((g) => g.pairs.length > 0)}
      />
    </div>
  );
};

// An Inbox's own group, for what has no question to carry it.
const useInboxGroup = (inboxId: string | undefined): Group | undefined => {
  const rules = useAtomValue(metadataRulesAtom);
  const board = useAtomValue(drawnBoardAtom);
  const view = board?.views.find((v) => v.inboxId === inboxId);
  return view === undefined
    ? undefined
    : inboxGroupOf(rules, board?.machines, view.metadata, machineKeyOf(view));
};

/**
 * The lit question's session and `<>`, over the box. The `<>` opens the card
 * the lit question's colophon draws, so there is one card, not two.
 */
export const LitActions = ({ inboxId }: { readonly inboxId: string }) => {
  const [open, setOpen] = useAtom(colophonOpenAtom);
  return (
    <>
      <OpenSession inboxId={inboxId} />
      <Toggle open={open} onToggle={() => setOpen(!open)} />
    </>
  );
};

/** An Inbox's session and metadata, with no question to carry them. */
export const InboxActions = ({ inboxId }: { readonly inboxId: string }) => {
  const group = useInboxGroup(inboxId);
  if (group === undefined) return null;
  return (
    <>
      <OpenSession inboxId={inboxId} />
      <MetaToggle lit times={[]} groups={[group]} />
    </>
  );
};

/** `<>`, as a line of a sidebar row's menu, when the Inbox has anything to show. */
export const MetaItem = ({
  inboxId,
  className,
}: {
  readonly inboxId: InboxId;
  readonly className: string;
}) => {
  const group = useInboxGroup(inboxId);
  const show = useAtomSet(inboxMetaCardAtom);
  const hint = useAtomValue(keyHintAtom('toggle_metadata'));
  if (group === undefined || group.pairs.length === 0) return null;
  return (
    <Menu.Item className={className} onClick={() => show(inboxId)}>
      Metadata
      <span className="text-fg/30">{hint.first}</span>
    </Menu.Item>
  );
};

/** `<>` over the box, as a line of the ⋯ menu: the lit question's card. */
export const LitMetaItem = ({ className }: { readonly className: string }) => {
  const setOpen = useAtomSet(colophonOpenAtom);
  const hint = useAtomValue(keyHintAtom('toggle_metadata'));
  return (
    <Menu.Item className={className} onClick={() => setOpen(true)}>
      Metadata
      <span className="text-fg/30">{hint.first}</span>
    </Menu.Item>
  );
};

/** The card a row's menu opens. On the page, as the menu and a drawer both go. */
export const InboxMetaCard = () => {
  const [inboxId, show] = useAtom(inboxMetaCardAtom);
  const group = useInboxGroup(inboxId);
  return (
    <Card
      groups={group === undefined ? [] : [group]}
      times={[]}
      open={group !== undefined}
      onOpenChange={(open) => {
        if (!open) show(undefined);
      }}
    />
  );
};
