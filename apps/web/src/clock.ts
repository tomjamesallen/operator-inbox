import { Clock, DateTime, Effect } from 'effect';
import { Atom } from 'effect/reactivity';

// The client's clock edge. The page reads the clock HERE, through
// `DateTime.now`, never the platform `Date`.
//
// The clock itself is an Atom, so the registry decides which clock the page
// reads: the live one by default, and a `TestClock` when a test seeds this
// Atom through `RegistryProvider`'s `initialValues`. Each read runs
// `DateTime.now` against that clock (provided as `Clock.Clock`), so setting
// the test clock's time is what the component sees.
export const clockAtom: Atom.Writable<Clock.Clock> = Atom.make<Clock.Clock>(
  Clock.Clock.defaultValue(),
).pipe(Atom.keepAlive);

export const nowUtc = (clock: Clock.Clock): DateTime.Utc =>
  Effect.runSync(DateTime.now.pipe(Effect.provideService(Clock.Clock, clock)));

export const nowMillis = (clock: Clock.Clock): number =>
  DateTime.toEpochMillis(nowUtc(clock));
