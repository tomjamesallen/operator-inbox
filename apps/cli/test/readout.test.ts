import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import type {
  ReadoutScript,
  ReadoutSegment,
  ReadoutStatusDto,
} from '@operator-inbox/core/api';
import { Duration, Effect, Queue, Ref, Schedule } from 'effect';
import {
  chooseSweep,
  emptyReadoutState,
  entriesOf,
  makeReadout,
  nextToMake,
  paceOf,
  type ReadoutState,
  readoutHash,
  wantScripts,
} from '../src/readout';
import { launcherCandidates, pythonFromLauncher } from '../src/readout-kokoro';
import {
  type ReadoutPace,
  ReadoutVoice,
  ReadoutVoiceError,
} from '../src/readout-voice';

// Listen mode's queue and cache: the pure decisions over the state, and the
// service over a temp folder with an in-memory voice whose every `speak`
// waits for the case to say how it ends, so the case controls what is in
// flight.

const script = (label: string): ReadoutScript => ({
  segments: [{ id: 'title', text: label, pauseAfter: 0.4 }],
});

type Outcome = 'ok' | 'fail';

const makeFakeVoice = Effect.gen(function* () {
  const calls = yield* Ref.make<ReadonlyArray<string>>([]);
  const paces = yield* Ref.make<ReadonlyArray<ReadoutPace>>([]);
  const outcomes = yield* Queue.unbounded<Outcome>();
  const missing = yield* Ref.make(false);
  const voice = {
    id: 'fake/voice',
    voice: 'fake',
    available: Effect.gen(function* () {
      if (yield* Ref.get(missing)) {
        return yield* new ReadoutVoiceError({
          reason: 'unavailable',
          message: 'install the fake voice',
        });
      }
    }),
    speak: (
      segments: ReadonlyArray<ReadoutSegment>,
      to: string,
      pace: ReadoutPace,
    ) =>
      Effect.gen(function* () {
        const label = segments[0]?.text ?? '';
        yield* Ref.update(calls, (c) => [...c, label]);
        yield* Ref.update(paces, (p) => [...p, pace]);
        const outcome = yield* Queue.take(outcomes);
        if (outcome === 'fail') {
          return yield* new ReadoutVoiceError({
            reason: 'failed',
            message: `could not say ${label}`,
          });
        }
        writeFileSync(to, `ID3 ${label}`);
        return {
          duration: 1.5,
          segments: [
            {
              id: 'title',
              start: 0,
              end: 1.5,
              words: [{ from: 0, to: label.length, start: 0.1, end: 1.4 }],
            },
          ],
        };
      }),
  };
  return { voice, calls, paces, outcomes, missing };
});

const tempDir = () =>
  mkdtempSync(path.join(tmpdir(), 'operator-inbox-readout-'));

const tags = (status: ReadoutStatusDto) =>
  status.entries.map((e) =>
    e._tag === 'Queued' ? `Queued ${e.position}` : e._tag,
  );

// Ask again until `done` holds of the answer (the worker runs beside the
// case), for at most about two seconds.
const until = (
  want: Effect.Effect<ReadoutStatusDto>,
  done: (s: ReadoutStatusDto) => boolean,
) =>
  want.pipe(
    Effect.repeat({
      until: done,
      schedule: Schedule.spaced(Duration.millis(10)),
      times: 200,
    }),
  );

const withReadout = <A, E>(
  dir: string,
  body: (
    readout: {
      readonly want: (
        s: ReadonlyArray<ReadoutScript>,
      ) => Effect.Effect<ReadoutStatusDto>;
    },
    fake: Effect.Success<typeof makeFakeVoice>,
  ) => Effect.Effect<A, E>,
  coolOff = Duration.seconds(30),
) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeVoice;
    const readout = yield* makeReadout({ dir, coolOff }).pipe(
      Effect.provideService(ReadoutVoice, fake.voice),
    );
    return yield* body(readout, fake);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe('readout: the pure decisions', () => {
  const state = (over: Partial<ReadoutState>): ReadoutState => ({
    ...emptyReadoutState,
    ...over,
  });

  it('the hash is 24 hex digits of the voice and the script', () => {
    const a = readoutHash('v1', script('A').segments);
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(readoutHash('v1', script('A').segments)).toBe(a);
    expect(readoutHash('v2', script('A').segments)).not.toBe(a);
    expect(readoutHash('v1', script('B').segments)).not.toBe(a);
  });

  it('makes the first wanted script not made, being made or failed lately', () => {
    const s = state({
      wanted: ['a', 'b', 'c', 'd'],
      made: new Map([['a', { duration: 1, segments: [], generationMs: 5 }]]),
      making: 'b',
      failed: new Map([['c', { message: 'no', at: 1_000 }]]),
    });
    expect(nextToMake(s, 1_500, 1_000)).toBe('d');
    // Once the cool-off has passed, the failed one is tried again.
    expect(nextToMake(s, 2_500, 1_000)).toBe('c');
    expect(
      nextToMake(
        { ...s, unavailable: { message: 'x', at: 1_000 } },
        1_500,
        1_000,
      ),
    ).toBeUndefined();
  });

  it('makes the Question the operator is on now, and the lookahead in the background', () => {
    const s = state({ wanted: ['a', 'b', 'c'] });
    expect(paceOf(s, 'a')).toBe('now');
    expect(paceOf(s, 'b')).toBe('background');
    expect(paceOf(s, 'c')).toBe('background');
  });

  it('counts the one being made in each queued position', () => {
    const s = state({ wanted: ['a', 'b', 'c'], making: 'a' });
    expect(entriesOf(s, 0, 1_000).map((e) => e._tag)).toEqual([
      'Generating',
      'Queued',
      'Queued',
    ]);
    expect(
      entriesOf(s, 0, 1_000).flatMap((e) =>
        e._tag === 'Queued' ? [e.position] : [],
      ),
    ).toEqual([1, 2]);
    // The one being made need not be wanted any more: still ahead.
    const moved = state({ wanted: ['x'], making: 'a' });
    expect(entriesOf(moved, 0, 1_000)).toEqual([
      { _tag: 'Queued', hash: 'x', position: 1 },
    ]);
  });

  it('a new want keeps what is made and what is being made', () => {
    const s = wantScripts(state({ wanted: ['a', 'b'], making: 'a' }), [
      { hash: 'c', segments: [] },
    ]);
    expect(s.wanted).toEqual(['c']);
    expect(s.making).toBe('a');
    expect(wantScripts(s, []).wanted).toEqual([]);
  });

  it('every entry is Failed while the voice is unavailable', () => {
    const s = state({
      wanted: ['a'],
      made: new Map([['a', { duration: 1, segments: [], generationMs: 0 }]]),
      unavailable: { message: 'install it', at: 0 },
    });
    expect(entriesOf(s, 10, 1_000)).toEqual([
      { _tag: 'Failed', hash: 'a', message: 'install it' },
    ]);
  });

  describe('the sweep', () => {
    const h = (c: string) => c.repeat(24);
    const DAY = 86_400_000;
    const limits = {
      maxAgeMs: 30 * DAY,
      maxBytes: 100,
      keep: new Set<string>(),
    };

    it('drops a script untouched for the max age, both its files', () => {
      const now = 40 * DAY;
      expect(
        chooseSweep(
          [
            { name: `${h('a')}.mp3`, size: 10, mtimeMs: 5 * DAY },
            { name: `${h('a')}.json`, size: 1, mtimeMs: 5 * DAY },
            { name: `${h('b')}.mp3`, size: 10, mtimeMs: 39 * DAY },
          ],
          now,
          limits,
        ),
      ).toEqual([`${h('a')}.mp3`, `${h('a')}.json`]);
    });

    it('over the size, drops the oldest first until under it', () => {
      const files = [
        { name: `${h('a')}.mp3`, size: 60, mtimeMs: 3 },
        { name: `${h('b')}.mp3`, size: 60, mtimeMs: 1 },
        { name: `${h('c')}.mp3`, size: 60, mtimeMs: 2 },
      ];
      expect(chooseSweep(files, 10, limits)).toEqual([
        `${h('b')}.mp3`,
        `${h('c')}.mp3`,
      ]);
      // A wanted script is never dropped, even when it is the oldest.
      expect(
        chooseSweep(files, 10, { ...limits, keep: new Set([h('b')]) }),
      ).toEqual([`${h('c')}.mp3`, `${h('a')}.mp3`]);
    });

    it('drops a stale temporary file and leaves other names alone', () => {
      expect(
        chooseSweep(
          [
            { name: `${h('a')}.mp3.3.part`, size: 1, mtimeMs: 0 },
            { name: `${h('b')}.mp3.4.part`, size: 1, mtimeMs: 9_000_000 },
            { name: 'notes.txt', size: 1_000, mtimeMs: 0 },
          ],
          10_000_000,
          limits,
        ),
      ).toEqual([`${h('a')}.mp3.3.part`]);
    });
  });

  it('finds the Python in a launcher, plain or trampolined', () => {
    expect(
      pythonFromLauncher('#!/u/tools/mlx-audio/bin/python\nimport x'),
    ).toBe('/u/tools/mlx-audio/bin/python');
    expect(
      pythonFromLauncher(
        `#!/bin/sh\n'''exec' '/u/a b/bin/python3' "$0" "$@"\n' '''`,
      ),
    ).toBe('/u/a b/bin/python3');
    expect(
      pythonFromLauncher(`#!/bin/sh\n'''exec' "/u/long/bin/python3" "$0" "$@"`),
    ).toBe('/u/long/bin/python3');
    expect(pythonFromLauncher('not a script')).toBeUndefined();
    expect(launcherCandidates('/a:rel:/b', '/h')).toEqual([
      '/a/mlx_audio.tts.generate',
      '/b/mlx_audio.tts.generate',
      '/h/.local/bin/mlx_audio.tts.generate',
    ]);
  });
});

describe('readout: the service', () => {
  it.live('makes the wanted scripts one at a time, in the order wanted', () =>
    withReadout(tempDir(), (readout, fake) =>
      Effect.gen(function* () {
        const want = readout.want([script('A'), script('B'), script('C')]);
        const first = yield* until(
          want,
          (s) => s.entries[0]?._tag === 'Generating',
        );
        expect(tags(first)).toEqual(['Generating', 'Queued 1', 'Queued 2']);
        yield* Queue.offer(fake.outcomes, 'ok');
        yield* Queue.offer(fake.outcomes, 'ok');
        yield* Queue.offer(fake.outcomes, 'ok');
        const done = yield* until(want, (s) =>
          s.entries.every((e) => e._tag === 'Ready'),
        );
        expect(yield* Ref.get(fake.calls)).toEqual(['A', 'B', 'C']);
        expect(yield* Ref.get(fake.paces)).toEqual([
          'now',
          'background',
          'background',
        ]);
        expect(done.voice).toBe('fake');
        const a = done.entries[0];
        expect(a?._tag).toBe('Ready');
        if (a?._tag === 'Ready') {
          expect(a.audio).toBe(`/api/readout/audio/${a.hash}.mp3`);
          expect(a.duration).toBe(1.5);
          expect(a.segments[0]?.words).toHaveLength(1);
          expect(a.generationMs).toBeGreaterThanOrEqual(0);
        }
      }),
    ),
  );

  it.live(
    'a new want drops a queued script, but finishes the one in flight',
    () =>
      withReadout(tempDir(), (readout, fake) =>
        Effect.gen(function* () {
          yield* until(
            readout.want([script('A'), script('B'), script('C')]),
            (s) => s.entries[0]?._tag === 'Generating',
          );
          const moved = yield* readout.want([script('D')]);
          // A is still being made, ahead of D.
          expect(tags(moved)).toEqual(['Queued 1']);
          yield* Queue.offer(fake.outcomes, 'ok');
          yield* Queue.offer(fake.outcomes, 'ok');
          yield* until(
            readout.want([script('D')]),
            (s) => s.entries[0]?._tag === 'Ready',
          );
          expect(yield* Ref.get(fake.calls)).toEqual(['A', 'D']);
          // A was finished and cached, though no longer wanted.
          const a = yield* readout.want([script('A')]);
          expect(tags(a)).toEqual(['Ready']);
        }),
      ),
  );

  it.live(
    'wanting nothing drops every queued script, and still finishes the one in flight',
    () =>
      withReadout(tempDir(), (readout, fake) =>
        Effect.gen(function* () {
          yield* until(
            readout.want([script('A'), script('B')]),
            (s) => s.entries[0]?._tag === 'Generating',
          );
          const none = yield* readout.want([]);
          expect(none.entries).toEqual([]);
          yield* Queue.offer(fake.outcomes, 'ok');
          const a = yield* until(
            readout.want([script('A')]),
            (s) => s.entries[0]?._tag === 'Ready',
          );
          expect(tags(a)).toEqual(['Ready']);
          expect(yield* Ref.get(fake.calls)).toEqual(['A']);
        }),
      ),
  );

  it.live('a script made by an earlier service is served from disk', () => {
    const dir = tempDir();
    return Effect.gen(function* () {
      yield* withReadout(dir, (readout, fake) =>
        Effect.gen(function* () {
          yield* Queue.offer(fake.outcomes, 'ok');
          yield* until(
            readout.want([script('A')]),
            (s) => s.entries[0]?._tag === 'Ready',
          );
        }),
      );
      const names = readdirSync(dir).sort();
      expect(names.some((n) => n.endsWith('.part'))).toBe(false);
      expect(names.map((n) => path.extname(n))).toEqual(['.json', '.mp3']);
      yield* withReadout(dir, (readout, fake) =>
        Effect.gen(function* () {
          const hit = yield* readout.want([script('A')]);
          expect(hit.entries[0]).toMatchObject({
            _tag: 'Ready',
            generationMs: 0,
            duration: 1.5,
          });
          expect(yield* Ref.get(fake.calls)).toEqual([]);
        }),
      );
    });
  });

  it.live(
    'a failed script is not tried again until asked after the cool-off',
    () =>
      withReadout(
        tempDir(),
        (readout, fake) =>
          Effect.gen(function* () {
            yield* Queue.offer(fake.outcomes, 'fail');
            const want = readout.want([script('A'), script('B')]);
            const failed = yield* until(
              want,
              (s) => s.entries[0]?._tag === 'Failed',
            );
            expect(failed.entries[0]).toMatchObject({
              message: 'could not say A',
            });
            // The worker moved on to B rather than trying A again.
            yield* Queue.offer(fake.outcomes, 'ok');
            const b = yield* until(want, (s) => s.entries[1]?._tag === 'Ready');
            expect(tags(b)).toEqual(['Failed', 'Ready']);
            expect(yield* Ref.get(fake.calls)).toEqual(['A', 'B']);
            yield* Effect.sleep(Duration.millis(350));
            yield* Queue.offer(fake.outcomes, 'ok');
            const again = yield* until(
              want,
              (s) => s.entries[0]?._tag === 'Ready',
            );
            expect(tags(again)).toEqual(['Ready', 'Ready']);
            expect(yield* Ref.get(fake.calls)).toEqual(['A', 'B', 'A']);
          }),
        Duration.millis(300),
      ),
  );

  it.live(
    'an unavailable voice fails every entry, and is asked again after the cool-off',
    () =>
      withReadout(
        tempDir(),
        (readout, fake) =>
          Effect.gen(function* () {
            yield* Ref.set(fake.missing, true);
            const want = readout.want([script('A'), script('B')]);
            const off = yield* want;
            expect(off.unavailable).toBe('install the fake voice');
            expect(tags(off)).toEqual(['Failed', 'Failed']);
            // Installed meanwhile: still unavailable until the cool-off passes.
            yield* Ref.set(fake.missing, false);
            expect((yield* want).unavailable).toBe('install the fake voice');
            expect(yield* Ref.get(fake.calls)).toEqual([]);
            yield* Effect.sleep(Duration.millis(350));
            const on = yield* want;
            expect(on.unavailable).toBeUndefined();
            expect(on.entries[0]?._tag).not.toBe('Failed');
          }),
        Duration.millis(300),
      ),
  );
});
