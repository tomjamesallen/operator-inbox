import { Dialog } from '@base-ui/react/dialog';
import { Input } from '@base-ui/react/input';
import { useAtom, useAtomValue } from '@effect/atom-react';
import type { InboxId } from '@operator-inbox/core/api';
import {
  type Binding,
  bindingsOf,
  type Chord,
  chordCaps,
  KEYMAP_ACTIONS,
  KEYMAP_SECTIONS,
  keysLabel,
  MACRO_KEYS,
  sequenceText,
  WIDGET_KEYS,
} from '@operator-inbox/core/keymap';
import { useRef } from 'react';
import {
  inboxBadgeAtom,
  keyBadgeAtom,
  keymapAtom,
  keymapHelpOpenAtom,
  keymapHelpQueryAtom,
  keymapPendingAtom,
  keymapSourceAtom,
} from '../keymap';
import { macrosSourceAtom } from '../macros';
import { dim, label, modalField, modalPanel } from './styles';

// The key bindings, as the keymap holds them now: every action by section,
// its keys (the ones the keybindings file set are marked), the file it read
// and any line in it that did not parse, then the keys a widget owns. `prefix
// ?` by default opens it, as tmux's `prefix ?` lists its keys.

const Caps = ({ chord }: { readonly chord: Chord }) => (
  <span className="inline-flex gap-0.5">
    {chordCaps(chord).map((cap) => (
      <kbd
        key={cap}
        className="min-w-4 border border-fg/20 px-1 text-center font-sans text-11 leading-snug text-fg/80"
      >
        {cap}
      </kbd>
    ))}
  </span>
);

// A sequence's chords, one after another, with › between the steps so
// `Ctrl Space › Z` never reads as one chord.
const Steps = ({ sequence }: { readonly sequence: ReadonlyArray<Chord> }) => (
  <>
    {sequence.map((chord, i) => (
      <span
        key={`${i}:${sequenceText([chord])}`}
        className="inline-flex items-center gap-1"
      >
        {i > 0 && <span className="text-fg/35">›</span>}
        <Caps chord={chord} />
      </span>
    ))}
  </>
);

const Keys = ({ binding }: { readonly binding: Binding }) => (
  <span
    className="inline-flex items-center gap-1 whitespace-nowrap"
    title={sequenceText(binding.sequence)}
    data-binding={sequenceText(binding.sequence)}
    data-source={binding.source}
  >
    <Steps sequence={binding.sequence} />
    {binding.source === 'config' && (
      <span className="text-10 text-blue" title="Set in your keybindings file">
        ●
      </span>
    )}
  </span>
);

const Source = () => {
  const source = useAtomValue(keymapSourceAtom);
  const { issues } = useAtomValue(keymapAtom);
  return (
    <div className={`mt-s1 text-11.5 ${dim}`} data-testid="keymap-source">
      {source._tag === 'Loading' && <p>Reading your keybindings file…</p>}
      {source._tag === 'Failed' && (
        <p className="text-red" role="alert">
          Could not read your keybindings file, so these are the defaults:{' '}
          {source.message}
        </p>
      )}
      {source._tag === 'Defaults' && (
        <p>
          The defaults. To change them, write{' '}
          <code className="text-fg/70">{source.path}</code>: one{' '}
          <code className="text-fg/70">keybind = trigger=action</code> line
          each, as in Ghostty.
        </p>
      )}
      {source._tag === 'File' && (
        <p>
          The defaults, with <code className="text-fg/70">{source.path}</code>{' '}
          applied (<span className="text-blue">●</span> marks its keys). Edit
          it, then Ctrl+R or reload.
        </p>
      )}
      {issues.length > 0 && (
        <ul className="mt-s1 text-orange" data-testid="keymap-issues">
          {issues.map((issue) => (
            <li key={issue.line}>
              Line {issue.line} skipped: {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

// Where the macros came from: the file, none, or why it cannot be used, as
// `Source` says it for the keybindings.
const MacrosSource = () => {
  const source = useAtomValue(macrosSourceAtom);
  return (
    <div className={`mt-s1 text-11.5 ${dim}`} data-testid="macros-source">
      {source._tag === 'Loading' && <p>Reading your macros file…</p>}
      {source._tag === 'Failed' && (
        <p className="text-red" role="alert">
          No macros, since your macros file cannot be used: {source.message}
        </p>
      )}
      {source._tag === 'None' && (
        <p>
          No macros. To add some, write{' '}
          <code className="text-fg/70">{source.path}</code>, then Ctrl+R or
          reload.
        </p>
      )}
      {source._tag === 'Loaded' && (
        <p>
          {source.macros.length === 0
            ? 'No macros'
            : source.macros.map((m) => `/${m.name}`).join(', ')}{' '}
          from <code className="text-fg/70">{source.path}</code>. Edit it, then
          Ctrl+R or reload.
        </p>
      )}
    </div>
  );
};

// Every word of the query, anywhere in what a row says or in its keys.
const matchesQuery = (query: string, ...texts: ReadonlyArray<string>) => {
  const haystack = texts.join(' ').toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
};

export const KeymapHelp = () => {
  const [open, setOpen] = useAtom(keymapHelpOpenAtom);
  const [query, setQuery] = useAtom(keymapHelpQueryAtom);
  const keymap = useAtomValue(keymapAtom);
  const search = useRef<HTMLInputElement>(null);
  const q = query.trim();
  const sections = KEYMAP_SECTIONS.map((section) => ({
    section,
    actions: KEYMAP_ACTIONS.filter(
      (a) =>
        a.section === section &&
        matchesQuery(
          q,
          section,
          a.description,
          a.id,
          ...bindingsOf(keymap, a.id).map((b) => sequenceText(b.sequence)),
        ),
    ),
  })).filter((s) => s.actions.length > 0);
  const widgets = WIDGET_KEYS.filter((w) =>
    matchesQuery(q, 'in place', w.what, w.where, w.keys),
  );
  // The card's own keys, and the three of the keymap's that act in it, as
  // the keymap binds them now.
  const macroKeys = [
    ...MACRO_KEYS,
    {
      keys: keysLabel(keymap, 'toggle_macro_info') ?? 'unbound',
      what: 'Show or hide what the macro tells the agent',
    },
    {
      keys: keysLabel(keymap, 'undo_card_removal') ?? 'unbound',
      what: 'Bring back the card last removed, while nothing is typed since',
    },
    {
      keys: keysLabel(keymap, 'send_response', 1) ?? 'unbound',
      what: 'Send; with a required field empty, go to it first; again, send it as it is',
    },
  ].filter((k) => matchesQuery(q, 'macros', k.what, k.keys));
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          className="fixed inset-0 z-30 bg-fg/20"
          data-testid="modal-backdrop"
        />
        <Dialog.Popup
          initialFocus={search}
          className={`${modalPanel} flex max-h-dialog flex-col text-12.5`}
          data-testid="keymap-help"
        >
          <Dialog.Title className="sr-only">Key bindings</Dialog.Title>
          <Input
            ref={search}
            type="search"
            value={query}
            onValueChange={setQuery}
            placeholder="Search key bindings"
            aria-label="Search key bindings"
            className={`${modalField} shrink-0`}
            data-keymap-search
          />
          <div className="min-h-0 flex-1 overflow-y-auto px-s3 pb-s3">
            <Source />
            {macroKeys.length > 0 && (
              <section className="mt-s3" aria-label="Macros">
                <h3 className={label}>Macros</h3>
                <MacrosSource />
                <table className="mt-s1 w-full border-collapse">
                  <tbody>
                    {macroKeys.map((k) => (
                      <tr
                        key={k.what}
                        className="border-t border-fg/8 align-baseline"
                      >
                        <td className="py-0.75 pr-s2 text-fg/80">
                          {k.what}
                          <div className="text-10.5 text-fg/35">
                            Answer box, macro card
                          </div>
                        </td>
                        <td className="py-0.75 text-right text-11 whitespace-nowrap text-fg/70">
                          {k.keys}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
            {sections.map(({ section, actions }) => (
              <section key={section} className="mt-s3" aria-label={section}>
                <h3 className={label}>{section}</h3>
                <table className="mt-s1 w-full border-collapse">
                  <tbody>
                    {actions.map((action) => {
                      const bound = bindingsOf(keymap, action.id);
                      return (
                        <tr
                          key={action.id}
                          className="border-t border-fg/8 align-baseline"
                          data-action={action.id}
                        >
                          <td className="py-0.75 pr-s2 text-fg/80">
                            {action.description}
                            <div className="text-10.5 text-fg/35">
                              {action.id}
                              {action.param === undefined
                                ? ''
                                : `:${action.param.name}`}
                            </div>
                          </td>
                          <td className="py-0.75 text-right">
                            {bound.length === 0 ? (
                              <span className={`text-11 ${dim}`}>unbound</span>
                            ) : (
                              <span className="inline-flex flex-wrap justify-end gap-x-s2 gap-y-0.5">
                                {bound.map((b) => (
                                  <Keys
                                    key={`${sequenceText(b.sequence)}:${b.action.param ?? ''}`}
                                    binding={b}
                                  />
                                ))}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>
            ))}
            {widgets.length > 0 && (
              <section className="mt-s3" aria-label="In place">
                <h3 className={label}>In place</h3>
                <table className="mt-s1 w-full border-collapse">
                  <tbody>
                    {widgets.map((w) => (
                      <tr
                        key={`${w.where}:${w.keys}`}
                        className="border-t border-fg/8 align-baseline"
                      >
                        <td className="py-0.75 pr-s2 text-fg/80">
                          {w.what}
                          <div className="text-10.5 text-fg/35">{w.where}</div>
                        </td>
                        <td className="py-0.75 text-right text-11 whitespace-nowrap text-fg/70">
                          {w.keys}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
            {sections.length === 0 &&
              widgets.length === 0 &&
              macroKeys.length === 0 && (
                <p className={`mt-s3 text-12 ${dim}`} data-keymap-no-match>
                  No key binding matches.
                </p>
              )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

// The prefix waiting for its next key, as tmux's status line shows it: fixed
// at the foot of the window, out of the page's flow, so it moves nothing.
export const PendingKeys = () => {
  const pending = useAtomValue(keymapPendingAtom);
  if (pending.length === 0) return null;
  return (
    <output
      className="pointer-events-none fixed bottom-s4 left-1/2 z-50 inline-flex -translate-x-1/2 items-center gap-1 border border-yellow bg-bg px-1.5 py-0.5 text-11 text-yellow"
      data-testid="keymap-pending"
    >
      <Steps sequence={pending} />
      <span>…</span>
    </output>
  );
};

// A key laid over its control while a sequence waits: absolutely placed, so it
// never moves the page, and placed where it covers no other label. The parent
// carries `relative`; `at` places it. A yellow square, so it never reads as
// one of the page's blue counts.
const Badge = ({ keys, at }: { keys: string | undefined; at: string }) =>
  keys === undefined ? null : (
    <kbd
      aria-hidden
      className={`pointer-events-none absolute z-50 grid h-4 min-w-4 place-items-center bg-yellow px-0.5 font-mono text-10 leading-none font-semibold text-bg ${at}`}
      data-key-badge={keys}
    >
      {keys}
    </kbd>
  );

// Over a sidebar row's count, which is as wide as the badge: the count is the
// one label the row can spare while the prefix waits.
const RIGHT = 'top-1/2 right-s3 -translate-y-1/2';

/** Inside a field's right-hand end, clear of its placeholder. */
export const INSIDE_END = 'top-1/2 right-1 -translate-y-1/2';

/** Over an icon button's icon, which the key stands in for while it waits. */
export const OVER_ICON = 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2';

export const KeyBadge = ({
  action,
  at = RIGHT,
}: {
  action: string;
  at?: string;
}) => <Badge keys={useAtomValue(keyBadgeAtom(action))} at={at} />;

export const InboxKeyBadge = ({
  inboxId,
  at = RIGHT,
}: {
  inboxId: InboxId;
  at?: string;
}) => <Badge keys={useAtomValue(inboxBadgeAtom(inboxId))} at={at} />;
