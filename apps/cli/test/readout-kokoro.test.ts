import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import type { ReadoutSegment } from '@operator-inbox/core/api';
import { ConfigProvider, Duration, Effect } from 'effect';
import { envProvider } from '../src/env-config';
import { makeKokoroVoice, READOUT_PYTHON_VAR } from '../src/readout-kokoro';

// The Kokoro adapter's child, over a stub script that speaks the same JSON
// lines protocol with no model: each start and each request's pace is logged,
// so a case can see when the child was started again and what it was asked.
// The voice's name is the log's path, since the script is given it.

const PYTHON = '/usr/bin/python3';

const STUB = `
import json, sys
log = open(sys.argv[1], "a", buffering=1)
log.write("start\\n")
print(json.dumps({"type": "ready"}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    log.write("pace " + request.get("pace", "") + "\\n")
    open(request["out"], "wb").write(b"ID3")
    print(json.dumps({"type": "done", "duration": 1, "segments": []}), flush=True)
`;

const segments: ReadonlyArray<ReadoutSegment> = [
  { id: 'title', text: 'Hello.', pauseAfter: 0 },
];

const withStub = <A, E>(
  idleStop: Duration.Duration,
  body: (
    voice: Effect.Success<ReturnType<typeof makeKokoroVoice>>,
    dir: string,
    log: () => ReadonlyArray<string>,
  ) => Effect.Effect<A, E>,
) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'operator-inbox-kokoro-'));
  const script = path.join(dir, 'stub.py');
  const logFile = path.join(dir, 'log');
  writeFileSync(script, STUB);
  writeFileSync(logFile, '');
  const log = () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  return Effect.scoped(
    Effect.flatMap(makeKokoroVoice(logFile, script, idleStop), (voice) =>
      body(voice, dir, log),
    ),
  ).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      envProvider({ [READOUT_PYTHON_VAR]: PYTHON }),
    ),
    Effect.provide(NodeServices.layer),
  );
};

describe.skipIf(!existsSync(PYTHON))('readout: the Kokoro child', () => {
  it.live('passes each request its pace', () =>
    withStub(Duration.minutes(5), (voice, dir, log) =>
      Effect.gen(function* () {
        yield* voice.speak(segments, path.join(dir, 'a.mp3'), 'now');
        yield* voice.speak(segments, path.join(dir, 'b.mp3'), 'background');
        expect(log()).toEqual(['start', 'pace now', 'pace background']);
      }),
    ),
  );

  it.live('stops the child once idle, and starts it again when asked', () =>
    withStub(Duration.millis(300), (voice, dir, log) =>
      Effect.gen(function* () {
        yield* voice.speak(segments, path.join(dir, 'a.mp3'), 'now');
        // Requests closer together than the idle time keep the one child.
        yield* Effect.sleep(Duration.millis(100));
        yield* voice.speak(segments, path.join(dir, 'b.mp3'), 'now');
        expect(log().filter((l) => l === 'start')).toHaveLength(1);
        yield* Effect.sleep(Duration.millis(700));
        yield* voice.speak(segments, path.join(dir, 'c.mp3'), 'now');
        expect(log().filter((l) => l === 'start')).toHaveLength(2);
      }),
    ),
  );
});
