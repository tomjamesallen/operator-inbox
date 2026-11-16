import { Atom } from 'effect/reactivity';

// A signal that ticks every `ms` while anything is mounted on it. Its timer
// lives and dies with the Atom node, never with a render, so a StrictMode
// double mount cannot leave two of them running.
export const tickEvery = (ms: number): Atom.Atom<number> =>
  Atom.readable((get) => {
    let ticks = 0;
    const id = setInterval(() => get.setSelf(++ticks), ms);
    get.addFinalizer(() => clearInterval(id));
    return ticks;
  });
