import { Collapsible } from '@base-ui/react/collapsible';
import { useAtom } from '@effect/atom-react';
import type { ReactNode } from 'react';
import {
  archivedSectionOpenAtom,
  type MachineSection,
  machineHintOf,
  machineSectionOpen,
  machineSectionsOpenAtom,
} from '../../inbox';
import { Icon } from './icon';
import { MachineHint } from './reader-states';

// The sidebar's two folds. They differ on purpose: Archived is a quiet caret, a
// machine is a heading with a rule above it and its status.

/** The archived Inboxes of one machine, shut until asked for or searched. */
export const ArchivedFold = ({
  machine,
  count,
  searching,
  children,
}: {
  readonly machine: MachineSection['key'];
  readonly count: number;
  readonly searching: boolean;
  readonly children: ReactNode;
}) => {
  const [stored, setOpen] = useAtom(archivedSectionOpenAtom(machine));
  const open = stored || searching;
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className="mt-s2"
      data-archived-section
    >
      <Collapsible.Trigger className="flex w-full cursor-pointer items-center gap-s1 px-s2 py-s1 text-left text-11 text-fg/35 hover:text-fg/70">
        <span className="w-2 text-11" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        Archived ({count})
      </Collapsible.Trigger>
      <Collapsible.Panel>{children}</Collapsible.Panel>
    </Collapsible.Root>
  );
};

/**
 * The archived groups of one Inbox, under its groups: shut until asked for,
 * searched, or one of them is picked. Quieter still than Archived, and nested
 * as its groups are.
 */
export const ArchivedGroupsFold = ({
  count,
  open,
  onOpenChange,
  children,
}: {
  readonly count: number;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly children: ReactNode;
}) => (
  <Collapsible.Root
    open={open}
    onOpenChange={onOpenChange}
    data-archived-groups
  >
    <Collapsible.Trigger className="flex w-full cursor-pointer items-center gap-s1 py-s1 pr-s2 pl-s4 text-left text-11 text-fg/30 hover:text-fg/70">
      <span className="w-2 text-11" aria-hidden="true">
        {open ? '▾' : '▸'}
      </span>
      Archived groups ({count})
    </Collapsible.Trigger>
    <Collapsible.Panel>{children}</Collapsible.Panel>
  </Collapsible.Root>
);

const dotOf = (section: MachineSection): string => {
  if (section.status === 'reachable' || section.status === 'local')
    return 'bg-green';
  return section.status === 'unreachable' && !section.greyed
    ? 'bg-red'
    : 'bg-orange';
};

const greyedNoteId = (key: MachineSection['key']): string =>
  `machine-greyed:${key}`;

/**
 * One machine's section. It opens as the operator left it, else open, except an
 * unreachable machine. A greyed machine stays open and searched, its
 * rows on the page; its fix is hidden, since one miss is a flap and the fix is
 * for a machine that stays gone.
 */
export const MachineFold = ({
  section,
  searching,
  children,
}: {
  readonly section: MachineSection;
  readonly searching: boolean;
  readonly children: ReactNode;
}) => {
  const [stored, setStored] = useAtom(machineSectionsOpenAtom);
  const reachable =
    section.status === 'reachable' || section.status === 'local';
  const hint = machineHintOf(section);
  const port = 'port' in section ? section.port : undefined;
  const open =
    machineSectionOpen(stored, section) ||
    (searching && (reachable || section.greyed));
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={(next) => setStored({ ...stored, [section.key]: next })}
      className="group/greyed mt-s3 border-t border-fg/10 pt-s1"
      data-machine-section={section.label}
      data-machine-key={section.key}
      data-machine-status={section.status}
      data-greyed={section.greyed || undefined}
    >
      {/* `relative` keeps the `sr-only` status inside the sidebar's scroller:
          absolute, it would land far down a long list and scroll the page. */}
      <Collapsible.Trigger
        className="group/machine relative flex w-full cursor-pointer items-center gap-s1 px-s2 py-s1 text-left"
        title={
          port === undefined
            ? `${section.label}: this machine`
            : `${section.label}: 127.0.0.1:${port}, ${section.status}`
        }
      >
        <span
          data-machine-dot
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${dotOf(section)}`}
        />
        <span className="min-w-0 flex-1 truncate text-10 tracking-label text-fg/60 uppercase group-hover/machine:text-fg">
          {section.label}
        </span>
        <span className="sr-only" data-machine-status>
          {section.greyed
            ? `${section.status}, showing what it held at the last read`
            : section.status}
        </span>
        <span
          aria-hidden="true"
          className={`flex shrink-0 text-fg/30 transition-transform group-hover/machine:text-fg/70 ${open ? 'rotate-90' : ''}`}
        >
          <Icon d="M9 6l6 6-6 6" />
        </span>
      </Collapsible.Trigger>
      {/* A greyed panel is a group described by its note, so someone moving
          into its rows hears why they are greyed, and that they still work. */}
      <Collapsible.Panel
        {...(section.greyed
          ? {
              role: 'group',
              'aria-label': section.label,
              'aria-describedby': greyedNoteId(section.key),
            }
          : {})}
      >
        {hint !== undefined && !section.greyed && (
          <div className="px-s2 py-s1" data-machine-hint>
            <MachineHint machine={section} />
          </div>
        )}
        {section.greyed && (
          <p
            id={greyedNoteId(section.key)}
            className="px-s2 pb-s1 text-11 text-fg/70"
            data-machine-greyed-note
          >
            Showing what it held at the last read.
          </p>
        )}
        {(hint === undefined || section.greyed) && children}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
};
