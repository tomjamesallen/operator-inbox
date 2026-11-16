import { Effect, Fiber } from 'effect';

// What the CLI shares with any headless `claude` child it spawns: the
// recursion marker and the bound that lets a timeout return at once.

// The one-level recursion marker. Set on a headless child's environment when
// the CLI spawns one; read on entry so a child with no operator never spawns
// another. Inbox mode's classifier (`question-classifier.ts`) sets and reads
// it.
export const RECURSION_MARKER = 'OPERATOR_INBOX_INSIDE_HEADLESS_AGENT';

// Run `self` on a detached fiber and join it; when the joiner is interrupted,
// interrupt the detached fiber on a fiber of its own, so the interruption
// returns at once instead of awaiting `self`'s finalisers. Effect 4 has no
// combinator for this, so it is built from `forkDetach`. A timeout around a hung child then
// returns immediately, and the child is reaped in the background.
export const disconnect = <A, E>(
  self: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(Effect.forkDetach(restore(self)), (fiber) =>
      restore(Fiber.join(fiber)).pipe(
        Effect.onInterrupt(() =>
          Effect.asVoid(Effect.forkDetach(Fiber.interrupt(fiber))),
        ),
      ),
    ),
  );
