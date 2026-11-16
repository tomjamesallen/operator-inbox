import { createEffectActor, type EffectActor } from '@xstate/effect';
import { sendAndAwait } from '@xstate/effect/test';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  type PlayerSnapshot,
  playerMachine,
  playerStateOf,
} from '../src/readout/player';

// The player on a real actor, driven by the events the page sends.

type Player = EffectActor<typeof playerMachine>;
type Event = Parameters<Player['send']>[0];

const run = (events: ReadonlyArray<Event>): Promise<PlayerSnapshot> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const player = yield* createEffectActor(playerMachine);
        let s = player.getSnapshot() as PlayerSnapshot;
        for (const e of events)
          s = (yield* sendAndAwait(player, e)) as PlayerSnapshot;
        return s;
      }),
    ),
  );

const lit = (
  key: string,
  src: string | undefined,
  at = 0,
  script = `${key}-script`,
): Event => ({ type: 'Lit', key, script, src, at });

describe('the player', () => {
  it('waits for audio asked for before it is made, then plays from the top', async () => {
    const s = await run([
      lit('a', undefined),
      { type: 'Play', from: undefined },
    ]);
    expect(playerStateOf(s)).toBe('waiting');
    const t = await run([
      lit('a', undefined),
      { type: 'Play', from: undefined },
      lit('a', '/a.mp3'),
    ]);
    expect(playerStateOf(t)).toBe('playing');
    expect(t.context.src).toBe('/a.mp3');
    expect(t.context.seek.t).toBe(0);
  });

  it('pauses on another Question and keeps the place for coming back', async () => {
    const s = await run([
      lit('a', '/a.mp3'),
      { type: 'Play', from: undefined },
      lit('b', '/b.mp3', 24.46),
    ]);
    expect(playerStateOf(s)).toBe('stopped');
    expect(s.context.cues.a).toEqual({ script: 'a-script', t: 24.46 });
    expect(s.context.seek.t).toBe(0);
    const back = await run([
      lit('a', '/a.mp3'),
      { type: 'Play', from: undefined },
      lit('b', '/b.mp3', 24.46),
      lit('a', '/a.mp3', 0),
    ]);
    // Back on it, the cursor shows where it will go on from.
    expect(back.context.seek.t).toBe(24.46);
    const resumed = await run([
      lit('a', '/a.mp3'),
      { type: 'Play', from: undefined },
      lit('b', '/b.mp3', 24.46),
      lit('a', '/a.mp3', 0),
      { type: 'Play', from: undefined },
    ]);
    expect(playerStateOf(resumed)).toBe('playing');
    expect(resumed.context.seek.t).toBe(24.46);
  });

  it('forgets the place when the Question’s script changes', async () => {
    const s = await run([
      lit('a', '/a.mp3'),
      { type: 'Pause', at: 10 },
      { type: 'Play', from: undefined },
      { type: 'Pause', at: 10 },
      lit('a', undefined, 10, 'a-edited'),
      { type: 'Play', from: undefined },
    ]);
    expect(playerStateOf(s)).toBe('waiting');
    expect(s.context.from).toBe(0);
  });

  it('moves only the place on a jump while stopped, and plays from it', async () => {
    const s = await run([lit('a', '/a.mp3'), { type: 'Cue', t: 7 }]);
    expect(playerStateOf(s)).toBe('stopped');
    expect(s.context.seek.t).toBe(7);
    const p = await run([
      lit('a', '/a.mp3'),
      { type: 'Cue', t: 7 },
      { type: 'Play', from: undefined },
    ]);
    expect(playerStateOf(p)).toBe('playing');
    expect(p.context.seek.t).toBe(7);
  });

  it('plays on from a jump or a tap while playing', async () => {
    const s = await run([
      lit('a', '/a.mp3'),
      { type: 'Play', from: undefined },
      { type: 'Cue', t: 12 },
      { type: 'Seek', t: 3 },
    ]);
    expect(playerStateOf(s)).toBe('playing');
    expect(s.context.seek).toEqual({ id: 4, t: 3 });
  });

  it('clears the place at the end, and stops when listen mode goes off', async () => {
    const ended = await run([
      lit('a', '/a.mp3'),
      { type: 'Play', from: 5 },
      { type: 'Ended' },
    ]);
    expect(playerStateOf(ended)).toBe('stopped');
    expect(ended.context.cues.a).toBeUndefined();
    expect(ended.context.seek.t).toBe(0);
    const off = await run([
      lit('a', '/a.mp3'),
      { type: 'Play', from: undefined },
      { type: 'Off', at: 9 },
    ]);
    expect(playerStateOf(off)).toBe('stopped');
    expect(off.context.cues.a?.t).toBe(9);
  });
});
