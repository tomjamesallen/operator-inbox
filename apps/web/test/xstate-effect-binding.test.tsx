import { RegistryProvider, useAtomSet, useAtomValue } from '@effect/atom-react';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  createEffectActor,
  createEffectLogic,
  send,
  setupEffect,
  waitFor,
} from '@xstate/effect';
import { createActorAtoms } from '@xstate/effect/atom';
import { Deferred, Effect, Layer, Schema } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';

// A pin of the binding the inbox reader's machine rests on, not a machine the
// app uses: the xstate and @xstate/effect pins are alpha, so a bump that
// breaks either case below breaks the inbox page's flow. All names are invented.

const flow = setupEffect({
  schemas: {
    events: { COMPOSE: Schema.Struct({}), CANCEL: Schema.Struct({}) },
  },
}).createMachine({
  initial: 'reading',
  states: {
    reading: { on: { COMPOSE: { target: 'composing' } } },
    composing: { on: { CANCEL: { target: 'reading' } } },
  },
});

const flowAtoms = createActorAtoms(Atom.runtime(Layer.empty), flow);

const Flow = () => {
  const state = useAtomValue(flowAtoms.state);
  const dispatch = useAtomSet(flowAtoms.send);
  return (
    <button type="button" onClick={() => dispatch({ type: 'COMPOSE' })}>
      {AsyncResult.isSuccess(state) ? state.value._tag : 'starting'}
    </button>
  );
};

describe('the machine binding', () => {
  it('reads a state change through an Atom after an event', async () => {
    // StrictMode and RegistryProvider as in main.tsx: its double mount must
    // leave one live actor behind, or the click below goes nowhere.
    render(
      <StrictMode>
        <RegistryProvider>
          <Flow />
        </RegistryProvider>
      </StrictMode>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'reading' }));

    expect(
      await screen.findByRole('button', { name: 'composing' }),
    ).toBeDefined();
  });

  it('interrupts an invoked Effect when its state is left', async () => {
    // Why a write is never invoked from a leavable state. The
    // outcome is read before the scope closes, because closing it interrupts
    // the Effect too and would pass this for the wrong reason.
    const program = Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const write = createEffectLogic(
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      );
      const saving = setupEffect({
        schemas: { events: { LEAVE: Schema.Struct({}) } },
        actors: { write },
      }).createMachine({
        initial: 'saving',
        states: {
          saving: {
            invoke: { src: 'write' },
            on: { LEAVE: { target: 'left' } },
          },
          left: {},
        },
      });

      const actor = yield* createEffectActor(saving);
      yield* Deferred.await(started);
      yield* send(actor, { type: 'LEAVE' });
      yield* waitFor(actor, (snapshot) => snapshot.matches('left'));
      yield* Deferred.await(interrupted).pipe(Effect.timeout('1 second'));
      return actor.getSnapshot().value;
    });

    await expect(Effect.runPromise(Effect.scoped(program))).resolves.toBe(
      'left',
    );
  });
});
