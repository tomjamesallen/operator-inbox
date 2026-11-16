// Class strings more than one component draws, as Tailwind utilities. A
// string lives here only when components in different files must look alike;
// a one-file style stays on its element.

// A small upper-case caption: a filter row's name, a group heading, a count.
export const label =
  'text-10.5 font-medium tracking-label text-fg/40 uppercase';

// Secondary text.
export const dim = 'text-fg/45';

// A search-led modal's panel, and the field across its top: the question
// search and the key bindings sheet are the same object.
export const modalPanel =
  'fixed inset-x-s4 top-s5 z-40 mx-auto min-h-search max-w-search border border-fg/20 bg-rail text-fg/90';
export const modalField =
  'w-full border-b border-fg/13 bg-transparent px-s3 py-s2 text-13 text-fg outline-none placeholder:text-fg/35 pointer-coarse:text-field';

// The keyboard focus ring every control here shares.
export const focusRing =
  'focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-blue';

// A header button (LIST / BOARD, REFRESH, INSTRUMENT, the rail's ☰). `on` is
// a pressed toggle; `waiting` is a button that ignores clicks until its work is back.
// A finger gets a taller, wider target than a pointer does.
export const headerButton = (state: 'off' | 'on' | 'waiting' = 'off'): string =>
  `border px-2 py-0.75 text-11 tracking-button pointer-coarse:px-s2 pointer-coarse:py-s2 ${
    state === 'on'
      ? 'cursor-pointer border-fg/50 text-fg'
      : state === 'waiting'
        ? 'cursor-progress border-fg/14 text-fg/55 opacity-55'
        : 'cursor-pointer border-fg/14 text-fg/55 hover:border-fg/35 hover:text-fg/90'
  }`;
