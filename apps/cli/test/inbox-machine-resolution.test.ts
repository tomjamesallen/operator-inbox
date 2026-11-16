import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import {
  type HerdrMachine,
  InboxMachinePort,
  inboxMachineEntries,
} from '@operator-inbox/core';
import { ConfigProvider, Duration, Effect, Fiber, Layer, Result } from 'effect';
import { envProvider } from '../src/env-config';
import {
  findInboxMachineEntry,
  type InboxMachinesRead,
  machinesOffOf,
  readInboxMachines,
} from '../src/inbox-machine-resolution';

// The one edge read of the Inbox machines that serve and tunnel share: config.json under a temp XDG_CONFIG_HOME,
// and herdr stood in for by a shell script named through OPERATOR_INBOX_HERDR_BIN.

const HERDR_MACHINES: ReadonlyArray<Record<string, unknown>> = [
  {
    id: 'm_1',
    label: 'LAPTOP',
    target: 'operator@laptop.local',
    session: 'main',
    enabled: true,
    selected: false,
  },
  {
    id: 'm_2',
    label: 'desktop',
    target: 'operator@desktop.local',
    session: 'main',
    enabled: true,
    selected: false,
  },
];

// A temp XDG_CONFIG_HOME holding `config` (raw text, or JSON of it), and a
// herdr running `herdrBody` that first marks it ran and records its pid.
const setup = (config: unknown, herdrBody: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'operator-inbox-machine-resolution-'));
  mkdirSync(join(dir, 'operator-inbox'));
  const configFile = join(dir, 'operator-inbox', 'config.json');
  writeFileSync(
    configFile,
    typeof config === 'string' ? config : JSON.stringify(config),
  );
  const ran = join(dir, 'herdr.pid');
  const herdr = join(dir, 'herdr');
  writeFileSync(herdr, `#!/bin/sh\necho $$ > '${ran}'\n${herdrBody}\n`);
  chmodSync(herdr, 0o755);
  const env = Layer.merge(
    NodeServices.layer,
    ConfigProvider.layer(
      envProvider({ XDG_CONFIG_HOME: dir, OPERATOR_INBOX_HERDR_BIN: herdr }),
    ),
  );
  return { env, ran, configFile };
};

const listing = `cat <<'EOF'\n${JSON.stringify(HERDR_MACHINES)}\nEOF`;

const read = (
  env: ReturnType<typeof setup>['env'],
  within: Duration.Input = '10 seconds',
) => readInboxMachines(within).pipe(Effect.provide(env));

const listed = (r: InboxMachinesRead) => {
  if (r._tag !== 'Listed') throw new Error(`expected Listed, got ${r._tag}`);
  return r;
};

describe('readInboxMachines', () => {
  it.live('resolves each configured machine against Herdr, in order', () =>
    Effect.gen(function* () {
      const { env, configFile } = setup(
        {
          inboxMachines: [
            { herdrMachine: 'm_1', port: InboxMachinePort.make(3010) },
            { herdrMachine: 'nowhere', port: InboxMachinePort.make(3011) },
          ],
        },
        listing,
      );
      const r = listed(yield* read(env));
      expect(r.configPath).toBe(configFile);
      expect(r.herdrTimedOut).toBeUndefined();
      expect(r.entries.map((e) => [e.key, e.label, e.port])).toEqual([
        ['3010', 'LAPTOP', 3010],
        ['3011', 'nowhere', 3011],
      ]);
      expect(r.entries.map((e) => Result.isSuccess(e.resolved))).toEqual([
        true,
        false,
      ]);
      expect(machinesOffOf(r)).toBeUndefined();
    }),
  );

  it.live('none configured is an empty list, and Herdr is never run', () =>
    Effect.gen(function* () {
      const { env, ran } = setup({ repos: {} }, listing);
      expect(listed(yield* read(env)).entries).toEqual([]);
      expect(existsSync(ran)).toBe(false);
    }),
  );

  // A bad `inboxMachines` is its own problem, never config.json's.
  it.live(
    'a port clash in inboxMachines is Invalid, says why, and never runs Herdr',
    () =>
      Effect.gen(function* () {
        const { env, ran, configFile } = setup(
          {
            sessionHost: 'tmux',
            inboxMachines: [
              { herdrMachine: 'laptop', port: InboxMachinePort.make(3010) },
              { herdrMachine: 'desktop', port: InboxMachinePort.make(3010) },
            ],
          },
          listing,
        );
        const r = yield* read(env);
        expect(r).toMatchObject({ _tag: 'Invalid', configPath: configFile });
        expect(machinesOffOf(r)).toMatch(
          new RegExp(`^config\\.json at ${configFile}: inboxMachines — .*3010`),
        );
        expect(existsSync(ran)).toBe(false);
      }),
  );

  it.live('a config.json that does not load is Unreadable, naming it', () =>
    Effect.gen(function* () {
      const { env, configFile } = setup('{ not json', listing);
      const r = yield* read(env);
      expect(r._tag).toBe('Unreadable');
      expect(machinesOffOf(r)).toContain(`config.json at ${configFile}`);
    }),
  );

  it.live('a Herdr that fails leaves every entry unresolved with why', () =>
    Effect.gen(function* () {
      const { env } = setup(
        {
          inboxMachines: [
            { herdrMachine: 'laptop', port: InboxMachinePort.make(3010) },
          ],
        },
        'echo broken >&2; exit 4',
      );
      const r = listed(yield* read(env));
      expect(r.herdrTimedOut).toBeUndefined();
      const [entry] = r.entries;
      expect(entry?.label).toBe('laptop');
      expect(
        entry !== undefined && Result.isFailure(entry.resolved)
          ? entry.resolved.failure.reason
          : '',
      ).toBe("'herdr machine list --json' failed: broken");
    }),
  );

  // A Herdr that ignores SIGTERM held the bound open for as
  // long as it ran (8.2 s under 1 s). The read now returns at the bound, and
  // the process is SIGKILLed in the background after a 500 ms grace. The
  // bound is 2 s so the stand-in has started under a loaded test run, and
  // the check that does not depend on the machine's speed is that the read
  // came back while the process was still alive: a read that waited for its
  // ending could only return once it was dead.
  it.live(
    'a Herdr ignoring SIGTERM is given up on at the bound and leaves no process',
    () =>
      Effect.gen(function* () {
        const { env, ran } = setup(
          {
            inboxMachines: [
              { herdrMachine: 'laptop', port: InboxMachinePort.make(3010) },
            ],
          },
          "trap '' TERM\nexec sleep 8",
        );
        const [took, r] = yield* Effect.timed(read(env, '2 seconds'));
        const pid = Number(readFileSync(ran, 'utf8').trim());
        const alive = () => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        expect(alive()).toBe(true);
        expect(Duration.toMillis(took)).toBeGreaterThanOrEqual(2000);
        const sentence = "'herdr machine list --json' did not answer within 2s";
        const l = listed(r);
        expect(l.herdrTimedOut).toBe(sentence);
        const [entry] = l.entries;
        expect(
          entry !== undefined && Result.isFailure(entry.resolved)
            ? entry.resolved.failure.reason
            : '',
        ).toBe(sentence);
        // Ended in the background: past the grace, it is gone. Polled on
        // the real clock, bounded at 5 s, since Herdr is a real process.
        for (let i = 0; i < 100 && alive(); i += 1)
          yield* Effect.sleep('50 millis');
        expect(alive()).toBe(false);
      }),
    15_000,
  );

  // At tunnel's main fiber: Ctrl-C during the wait
  // on Herdr interrupts the read, and the command's Scope, closing, waits for
  // Herdr (in a process group of its own, ignoring SIGTERM) to be ended, so
  // it is gone by the time the command has stopped.
  it.live(
    'a read interrupted while Herdr hangs ends Herdr before its Scope closes',
    () =>
      Effect.gen(function* () {
        const { env, ran } = setup(
          {
            inboxMachines: [
              { herdrMachine: 'laptop', port: InboxMachinePort.make(3010) },
            ],
          },
          "trap '' TERM\nexec sleep 8",
        );
        const fiber = yield* Effect.forkChild(Effect.scoped(read(env)));
        // Polled on the real clock, bounded at 5 s, until the real Herdr
        // process has started.
        for (let i = 0; i < 100 && !existsSync(ran); i += 1)
          yield* Effect.sleep('50 millis');
        const pid = Number(readFileSync(ran, 'utf8').trim());
        const alive = () => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        try {
          expect(alive()).toBe(true);
          yield* Fiber.interrupt(fiber);
          expect(alive()).toBe(false);
        } finally {
          if (alive()) process.kill(pid, 'SIGKILL');
        }
      }),
    15_000,
  );
});

describe('findInboxMachineEntry', () => {
  const herdr = HERDR_MACHINES as unknown as ReadonlyArray<HerdrMachine>;
  const entries = inboxMachineEntries(
    [
      { herdrMachine: 'm_1', port: InboxMachinePort.make(3010) },
      { herdrMachine: 'desktop', port: InboxMachinePort.make(3011) },
      { herdrMachine: 'gone', port: InboxMachinePort.make(3012) },
    ],
    Result.succeed(herdr),
  );
  const found = (selector: string) => {
    const r = findInboxMachineEntry(entries, selector);
    return Result.isSuccess(r) ? r.success.port : r.failure.map((e) => e.port);
  };

  it('finds a machine by its label, its Herdr id or its selector', () => {
    expect(found('LAPTOP')).toBe(3010);
    expect(found('m_2')).toBe(3011);
    expect(found('gone')).toBe(3012);
  });

  // Labels are unique regardless of case, so a label typed in another case
  // names one machine.
  it('ignores case', () => {
    expect(found('laptop')).toBe(3010);
    expect(found('Desktop')).toBe(3011);
    expect(found('M_1')).toBe(3010);
  });

  it('names nothing for a selector no machine answers to', () => {
    expect(found('elsewhere')).toEqual([]);
  });

  // A selector one machine has exactly and another only in another case
  // goes to the exact one; two only in another case is ambiguous.
  it('prefers an exact match, and refuses two loose ones', () => {
    const tricky = inboxMachineEntries(
      [
        { herdrMachine: 'm_1', port: InboxMachinePort.make(3010) },
        { herdrMachine: 'laptop', port: InboxMachinePort.make(3011) },
      ],
      Result.succeed([
        ...herdr.slice(0, 1),
        { ...herdr[1], id: 'laptop' } as HerdrMachine,
      ]),
    );
    const at = (s: string) => {
      const r = findInboxMachineEntry(tricky, s);
      return Result.isSuccess(r)
        ? r.success.port
        : r.failure.map((e) => e.port);
    };
    // m_1 is labelled LAPTOP; the second entry's selector and Herdr id are laptop.
    expect(at('laptop')).toBe(3011);
    expect(at('LAPTOP')).toBe(3010);
    expect(at('Laptop')).toEqual([3010, 3011]);
    // Each one named by its label, as the refusal advises.
    expect(tricky.map((e) => at(e.label))).toEqual([3010, 3011]);
  });

  // A second entry naming m_1 by its id is a duplicate, and its
  // section label is its selector, m_1, which is also the first entry's
  // Herdr id. Both match m_1 exactly, and naming either "as written" could
  // not tell them apart. A label names its entry outright, so m_1 is the
  // duplicate (whose refusal says to remove it), and laptop the first.
  it('names an entry by its label even where another’s Herdr id is the same', () => {
    const duplicate = inboxMachineEntries(
      [
        { herdrMachine: 'LAPTOP', port: InboxMachinePort.make(3010) },
        { herdrMachine: 'm_1', port: InboxMachinePort.make(3011) },
      ],
      Result.succeed(herdr),
    );
    expect(duplicate.map((e) => e.label)).toEqual(['LAPTOP', 'm_1']);
    const at = (s: string) => {
      const r = findInboxMachineEntry(duplicate, s);
      return Result.isSuccess(r)
        ? r.success.port
        : r.failure.map((e) => e.port);
    };
    expect(at('m_1')).toBe(3011);
    expect(at('LAPTOP')).toBe(3010);
  });
});
