// Every action the inbox screen's keymap can bind, with the keys it has by
// default. The names are Ghostty's style (snake_case, a parameter after `:`,
// as in `goto_tab:3`), and the new keys are tmux's: a prefix, then one key with
// tmux's meaning where tmux has one. The chords that were on the screen before
// the keymap (⌘B, Ctrl+R, Ctrl+N, ⌘P, Ctrl+[ and Ctrl+], Ctrl+C, ⌘↩) are the
// defaults for their actions, unchanged, but for Ctrl+N, which became Ctrl+A to
// match ask_agent's prefix>a.

export type KeymapSection = 'Navigate' | 'Questions' | 'Inbox' | 'Help';

export interface KeymapAction {
  readonly id: string;
  readonly section: KeymapSection;
  readonly description: string;
  // A parameter the action takes after `:`, when it takes one.
  readonly param?: {
    readonly name: string;
    readonly min: number;
    readonly max: number;
  };
}

export const KEYMAP_ACTIONS: ReadonlyArray<KeymapAction> = [
  {
    id: 'toggle_sidebar',
    section: 'Navigate',
    description: 'Open or close the inbox sidebar',
  },
  {
    id: 'close_drawer',
    section: 'Navigate',
    description: 'Close the sidebar when it lies over the page, or stop asking',
  },
  {
    id: 'focus_sidebar',
    section: 'Navigate',
    description: 'Focus the selected inbox in the sidebar',
  },
  {
    id: 'focus_inbox_column',
    section: 'Navigate',
    description: 'Go to Your inbox and put the caret in the answer box',
  },
  {
    id: 'focus_sidebar_search',
    section: 'Navigate',
    description: 'Focus the sidebar’s inbox search',
  },
  {
    id: 'next_inbox',
    section: 'Navigate',
    description: 'Select the next inbox in the sidebar',
  },
  {
    id: 'previous_inbox',
    section: 'Navigate',
    description: 'Select the previous inbox in the sidebar',
  },
  { id: 'all_inboxes', section: 'Navigate', description: 'Select All inboxes' },
  {
    id: 'goto_inbox',
    section: 'Navigate',
    description: 'Select the nth inbox in the sidebar',
    param: { name: 'n', min: 1, max: 99 },
  },
  {
    id: 'go_to_session',
    section: 'Navigate',
    description:
      'Pick an inbox or its session: Enter selects the inbox, Ctrl+Enter opens its session',
  },
  {
    id: 'previous_queue',
    section: 'Navigate',
    description:
      'Switch to the previous view: Ask the agent, Your inbox, With the agent, Processed',
  },
  {
    id: 'next_queue',
    section: 'Navigate',
    description:
      'Switch to the next view: Ask the agent, Your inbox, With the agent, Processed',
  },
  {
    id: 'search_questions',
    section: 'Questions',
    description: 'Search every question',
  },
  {
    id: 'previous_question',
    section: 'Questions',
    description: 'Select the previous question',
  },
  {
    id: 'next_question',
    section: 'Questions',
    description: 'Select the next question',
  },
  {
    id: 'previous_highlighted',
    section: 'Questions',
    description: 'Select the previous highlighted question',
  },
  {
    id: 'next_highlighted',
    section: 'Questions',
    description: 'Select the next highlighted question',
  },
  {
    id: 'first_question',
    section: 'Questions',
    description:
      'Select the first question in the list; while asking, the inbox above',
  },
  {
    id: 'last_question',
    section: 'Questions',
    description:
      'Select the last question in the list; while asking, the inbox below',
  },
  {
    id: 'scroll_up',
    section: 'Questions',
    description: 'Scroll the list up a little; while asking, the inbox above',
  },
  {
    id: 'scroll_down',
    section: 'Questions',
    description: 'Scroll the list down a little; while asking, the inbox below',
  },
  {
    id: 'toggle_metadata',
    section: 'Questions',
    description: 'Show or hide the card of the question’s metadata',
  },
  {
    id: 'clear_selection',
    section: 'Questions',
    description: 'Clear the selected question',
  },
  {
    id: 'send_response',
    section: 'Questions',
    description: 'Send, from a response box or the ask box',
  },
  {
    id: 'defer_to_agent',
    section: 'Questions',
    description:
      'Defer to the agent: it decides, with what is in the box as a note',
  },
  {
    id: 'toggle_highlight_reply',
    section: 'Questions',
    description:
      'Ask the agent to highlight the question it asks in reply to this send',
  },
  {
    id: 'toggle_macro_info',
    section: 'Questions',
    description:
      'In a macro card under the answer box: show or hide what the macro tells the agent',
  },
  {
    id: 'copy_question',
    section: 'Questions',
    description: 'Copy the selected question',
  },
  {
    id: 'open_session',
    section: 'Questions',
    description: 'Open the session working the question’s inbox',
  },
  {
    id: 'dismiss_highlight',
    section: 'Questions',
    description: 'Dismiss the selected question’s highlight',
  },
  {
    id: 'ask_agent',
    section: 'Questions',
    description: 'Ask an agent a question',
  },
  {
    id: 'refresh',
    section: 'Inbox',
    description: 'Refresh the questions and the key bindings',
  },
  {
    id: 'toggle_group',
    section: 'Inbox',
    description: 'On a focused group in the sidebar: add it or take it away',
  },
  {
    id: 'toggle_pin',
    section: 'Inbox',
    description:
      'Pin or unpin the selected inbox, or its one group; in All, the question’s inbox',
  },
  {
    id: 'toggle_pinned_only',
    section: 'Inbox',
    description: 'Show only what is pinned in the sidebar',
  },
  {
    id: 'rename_inbox',
    section: 'Inbox',
    description: 'Rename the selected inbox; in All, the question’s inbox',
  },
  {
    id: 'toggle_archive',
    section: 'Inbox',
    description:
      'Archive the selected inbox, or bring it back; in All, the question’s inbox',
  },
  { id: 'show_help', section: 'Help', description: 'Show these key bindings' },
];

export const KEYMAP_SECTIONS: ReadonlyArray<KeymapSection> = [
  'Navigate',
  'Questions',
  'Inbox',
  'Help',
];

/** A common tmux prefix, and so the default here. */
export const DEFAULT_PREFIX = 'ctrl+space';

// The default bindings, in the config file's own syntax: each is a line a
// config could carry after `keybind = `.
export const DEFAULT_BINDINGS: ReadonlyArray<string> = [
  'super+b=toggle_sidebar',
  'ctrl+b=toggle_sidebar',
  'escape=close_drawer',
  // b for the sidebar ("bar"), j to jump to the answer box; h and i are
  // highlight_reply's and the inbox picker's, which s opens too.
  'prefix>b=focus_sidebar',
  'prefix>j=focus_inbox_column',
  'prefix>i=go_to_session',
  'prefix>/=focus_sidebar_search',
  'prefix>n=next_inbox',
  'prefix>p=previous_inbox',
  'prefix>0=all_inboxes',
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `prefix>${n}=goto_inbox:${n}`),
  'prefix>s=go_to_session',
  'super+p=search_questions',
  'ctrl+p=search_questions',
  'ctrl+[=previous_question',
  'ctrl+]=next_question',
  // Shift for the highlighted ones, Alt for a nudge, the arrows for the ends, and
  // the angle brackets for the views. `<` and `>` are written `less` and `greater`, since a bare
  // `>` is the sequence separator.
  'ctrl+shift+[=previous_highlighted',
  'ctrl+shift+]=next_highlighted',
  'ctrl+alt+[=scroll_up',
  'ctrl+alt+]=scroll_down',
  'super+up=first_question',
  'super+down=last_question',
  'ctrl+less=previous_queue',
  'ctrl+greater=next_queue',
  'ctrl+m=toggle_metadata',
  'ctrl+c=clear_selection',
  'super+enter=send_response',
  'ctrl+enter=send_response',
  // Send's chord with shift; prefix>u, for "up to you", from anywhere.
  'super+shift+enter=defer_to_agent',
  'ctrl+shift+enter=defer_to_agent',
  'prefix>u=defer_to_agent',
  'prefix>h=toggle_highlight_reply',
  // Matched by the key's place, as every letter is, so a Mac's ⌥I, a dead key
  // that types nothing of its own, still counts.
  'alt+i=toggle_macro_info',
  'prefix>y=copy_question',
  'prefix>o=open_session',
  'prefix>d=dismiss_highlight',
  'ctrl+a=ask_agent',
  'prefix>a=ask_agent',
  'ctrl+r=refresh',
  'space=toggle_group',
  'prefix>m=toggle_pin',
  'prefix>,=rename_inbox',
  'prefix>&=toggle_archive',
  'prefix>?=show_help',
];

// Keys a widget owns while it has focus. They are not the keymap's, so they
// cannot be rebound, but the help lists them so the screen is learnable.
export const WIDGET_KEYS: ReadonlyArray<{
  readonly keys: string;
  readonly where: string;
  readonly what: string;
}> = [
  {
    keys: '↑ ↓ ↩',
    where: 'Search, ask',
    what: 'Move through the matches and open one',
  },
  {
    keys: '↑ ↓ ↩ / Ctrl+↩',
    where: 'Inbox picker',
    what: 'Move through the inboxes and select one / open its session, staying open',
  },
  {
    keys: '↑ ↓ ↩ / Ctrl+↩',
    where: 'Other inboxes, under the owl',
    what: 'Move through them and open one / open its session',
  },
  { keys: 'Esc', where: 'Any dialog', what: 'Close it' },
  {
    keys: '↩ / Esc',
    where: 'Sidebar search',
    what: 'Open the first match / clear the box',
  },
  {
    keys: '← → / ↩',
    where: 'Sidebar edge',
    what: 'Resize the sidebar / reset its width',
  },
  {
    keys: '↑ ↓',
    where: 'Response box grip',
    what: 'Make the box taller or shorter',
  },
  { keys: 'Tab', where: 'Anywhere', what: 'Move through what can be clicked' },
];

// The keys a macro card and the macro menu own while they have the focus,
// for the help sheet's Macros section. Like `WIDGET_KEYS`, they cannot be
// rebound; the card's ⌥I is the keymap's `toggle_macro_info`, and Send's
// chord is the keymap's too, so the help lists those from the keymap.
export const MACRO_KEYS: ReadonlyArray<{
  readonly keys: string;
  readonly what: string;
}> = [
  { keys: '/', what: 'Open the macros, at the start of a word' },
  {
    keys: '↑ ↓ · ↩ or Tab · Esc',
    what: 'In the macro menu: choose one · add its card · close the menu',
  },
  {
    keys: 'Tab · ⇧Tab',
    what: 'From the text into the cards, then field to field',
  },
  { keys: '← →', what: 'Choose in a one-of; move in a many-of' },
  { keys: 'Space', what: 'Pick or drop an option in a many-of' },
  { keys: '↑ ↓', what: 'Step a number' },
  {
    keys: 'Esc',
    what: 'Shut what the macro tells the agent; again, back to the text',
  },
  { keys: '⌘⌫ / Ctrl+⌫', what: 'Remove the card' },
];
