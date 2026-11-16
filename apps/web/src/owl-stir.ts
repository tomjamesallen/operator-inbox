import { Effect, Random } from 'effect';
import { Atom } from 'effect/reactivity';

// The empty state's owl sleeps through most of it and stirs now and then. The
// gap runs from one stir's start to the next's, and is drawn afresh each time,
// so the owl never settles into a rhythm anyone could notice.
export const STIR_GAP_MIN_MS = 15_000;
export const STIR_GAP_MAX_MS = 20_000;

// As long as one stir: `index.css`'s `--animate-owl-tip`, `--animate-owl-stir-eye`
// and `--animate-owl-stir-lid` say the same.
export const STIR_MS = 3_600;

const stirGap = Random.nextIntBetween(STIR_GAP_MIN_MS, STIR_GAP_MAX_MS);

// Whether the owl is stirring. Its timers live and die with the Atom node, so
// they run only while an owl is on the page.
export const owlStirringAtom: Atom.Atom<boolean> = Atom.readable((get) => {
  let next: ReturnType<typeof setTimeout>;
  let settle: ReturnType<typeof setTimeout>;
  const wait = () => {
    next = setTimeout(stir, Effect.runSync(stirGap));
  };
  const stir = () => {
    get.setSelf(true);
    settle = setTimeout(() => get.setSelf(false), STIR_MS);
    wait();
  };
  wait();
  get.addFinalizer(() => {
    clearTimeout(next);
    clearTimeout(settle);
  });
  return false;
});
