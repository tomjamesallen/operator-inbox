import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { ConfigProvider, Effect, FileSystem, Result, Schema } from 'effect';
import {
  AppConfig,
  ConfigError,
  configHome,
  configPath,
  decodeMetadataRules,
  describeConfigFailure,
  inboxMachinesOf,
  keybindingsPath,
  loadConfig,
  loadMetadataRules,
  loadXdgConfigHome,
  metadataPath,
} from '../src/config';
import {
  BUILT_IN_METADATA_KEYS,
  DEFAULT_INBOX_METADATA,
  type InboxMetadataRules,
  withBuiltInKeys,
} from '../src/inbox-metadata';
import { envProvider } from './env-provider';

// A config file that does not decode must end a command with a sentence that
// names the file, the key, what was expected and what was there, never with
// the app's name and nothing after it. Pinned here at both altitudes: the pure
// describer over a thrown cause, and the real loader over a temp XDG dir,
// whose error must carry the same sentence as its `message` (what the CLI
// boundary prints).

const P = '/home/u/.config/operator-inbox/config.json';

// The cause exactly as `loadConfig` sees it: whatever decodeUnknownSync threw,
// with the same `errors: 'all'` and `reportInput: true` the loader passes.
const thrownBy = (input: unknown): unknown => {
  try {
    Schema.decodeUnknownSync(AppConfig, {
      errors: 'all',
      reportInput: true,
    })(input);
  } catch (e) {
    return e;
  }
  throw new Error('expected the decode to throw');
};

describe('where the files are', () => {
  it('puts all three under operator-inbox in the config base', () => {
    expect(configPath('/c')).toBe('/c/operator-inbox/config.json');
    expect(metadataPath('/c')).toBe('/c/operator-inbox/metadata.json');
    expect(keybindingsPath('/c')).toBe('/c/operator-inbox/keybindings');
  });

  it('counts a blank or relative XDG_CONFIG_HOME as unset, so it stays absolute', () => {
    for (const xdgConfigHome of [undefined, '', '  ', 'relative/dir'])
      expect(configHome({ xdgConfigHome, home: '/home/u' })).toBe(
        '/home/u/.config',
      );
    expect(configHome({ xdgConfigHome: '/xdg', home: '/home/u' })).toBe('/xdg');
  });

  it.effect('reads XDG_CONFIG_HOME through Config', () =>
    Effect.gen(function* () {
      const set = yield* loadXdgConfigHome.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          envProvider({ XDG_CONFIG_HOME: '/xdg' }),
        ),
      );
      expect(set).toBe('/xdg');
    }),
  );

  it.effect('reads HOME through Config too, never the real home', () =>
    Effect.gen(function* () {
      const unset = yield* loadXdgConfigHome.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          envProvider({ HOME: '/home/u', XDG_CONFIG_HOME: '  ' }),
        ),
      );
      expect(unset).toBe('/home/u/.config');
      const none = yield* Effect.flip(
        loadXdgConfigHome.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, envProvider()),
        ),
      );
      expect(none._tag).toBe('ConfigError');
      expect(none.message).toMatch(/HOME is not set.*XDG_CONFIG_HOME/);
    }),
  );
});

describe('describeConfigFailure (pure)', () => {
  it('a wrongly typed databasePath names the key, the type and the value', () => {
    expect(describeConfigFailure(P, thrownBy({ databasePath: 42 }))).toBe(
      `config.json at ${P}: databasePath — expected string, got 42`,
    );
  });

  it('a nested miss carries the dotted path', () => {
    expect(
      describeConfigFailure(
        P,
        thrownBy({ serve: { tailnet: { host: 3, allowFrom: [] } } }),
      ),
    ).toBe(`config.json at ${P}: serve.tailnet.host — expected string, got 3`);
  });

  it('two bad keys are two clauses in one message (errors: all)', () => {
    expect(
      describeConfigFailure(P, thrownBy({ databasePath: 42, serve: 7 })),
    ).toBe(
      `config.json at ${P}: databasePath — expected string, got 42; serve — expected an object, got 7`,
    );
  });

  it('a non-object, at the top or under a key, is "an object" — never Effect’s type text', () => {
    expect(describeConfigFailure(P, thrownBy([]))).toBe(
      `config.json at ${P}: (top level) — expected an object, got []`,
    );
    expect(describeConfigFailure(P, thrownBy({ serve: 'x' }))).toBe(
      `config.json at ${P}: serve — expected an object, got "x"`,
    );
  });

  it('a file that is not JSON says so with the parser’s own reason', () => {
    let cause: unknown;
    try {
      JSON.parse('{ nope');
    } catch (e) {
      cause = e;
    }
    const msg = describeConfigFailure(P, cause);
    expect(msg.startsWith(`config.json at ${P} is not valid JSON: `)).toBe(
      true,
    );
    expect(msg.length).toBeGreaterThan(
      `config.json at ${P} is not valid JSON: `.length,
    );
  });
});

// An XDG_CONFIG_HOME whose operator-inbox/<file> holds exactly `text`.
const xdgWith = (text: string, file = 'config.json') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const xdg = yield* fs.makeTempDirectory();
    yield* fs.makeDirectory(path.join(xdg, 'operator-inbox'));
    yield* fs.writeFileString(path.join(xdg, 'operator-inbox', file), text);
    return xdg;
  });

const withXdg = <A, E, R>(xdg: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      envProvider({ XDG_CONFIG_HOME: xdg }),
    ),
  );

const load = (xdg: string) => withXdg(xdg, loadConfig()).pipe(Effect.result);

describe('loadConfig (the real loader)', () => {
  it.effect('the positive control: a valid file loads', () =>
    Effect.gen(function* () {
      const r = yield* load(yield* xdgWith('{"databasePath":"/x.sqlite"}'));
      expect(Result.isSuccess(r)).toBe(true);
      if (Result.isSuccess(r)) {
        expect(r.success.config.databasePath).toBe('/x.sqlite');
        expect(r.success.loaded).toBe(true);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('no file is every default, and says it loaded nothing', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const xdg = yield* fs.makeTempDirectory();
      const r = yield* load(xdg);
      expect(Result.isSuccess(r)).toBe(true);
      if (Result.isSuccess(r))
        expect(r.success).toEqual({
          config: {},
          path: path.join(xdg, 'operator-inbox', 'config.json'),
          loaded: false,
        });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    'a bad value: a ConfigError whose message names the file, the key and the value',
    () =>
      Effect.gen(function* () {
        const xdg = yield* xdgWith('{"databasePath":42}');
        const r = yield* load(xdg);
        expect(Result.isFailure(r)).toBe(true);
        if (Result.isFailure(r)) {
          expect(r.failure).toBeInstanceOf(ConfigError);
          // The Error's own `message`: the field the CLI prints.
          expect(r.failure.message).toBe(
            `config.json at ${path.join(xdg, 'operator-inbox', 'config.json')}: databasePath — expected string, got 42`,
          );
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('two typos in one file: the LOADER reports both', () =>
    Effect.gen(function* () {
      const r = yield* load(yield* xdgWith('{"databasePath":42,"serve":7}'));
      expect(Result.isFailure(r)).toBe(true);
      if (Result.isFailure(r)) {
        expect(r.failure.message).toContain(
          'databasePath — expected string, got 42',
        );
        expect(r.failure.message).toContain(
          'serve — expected an object, got 7',
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('not JSON at all — the message says so and names the file', () =>
    Effect.gen(function* () {
      const xdg = yield* xdgWith('{ nope');
      const r = yield* load(xdg);
      expect(Result.isFailure(r)).toBe(true);
      if (Result.isFailure(r)) {
        expect(r.failure.message).toContain(
          `config.json at ${path.join(xdg, 'operator-inbox', 'config.json')} is not valid JSON: `,
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// Inbox machines: the decode refuses a clash, and the refusal is a sentence
// under the `inboxMachines` key. It is read apart from the rest of
// config.json: a bad value is `Invalid` with that sentence, and the rest of
// the file still decodes.
describe('inboxMachines', () => {
  const decode = Schema.decodeUnknownSync(AppConfig);
  // The sentence a value comes to, or the machines it lists.
  const read = (inboxMachines: unknown) =>
    inboxMachinesOf(decode({ inboxMachines }));
  const problemOf = (inboxMachines: unknown): string => {
    const r = read(inboxMachines);
    if (Result.isSuccess(r)) throw new Error('expected inboxMachines to fail');
    return r.failure;
  };

  it('decodes a valid list in its order, and is none when absent', () => {
    expect(
      read([
        { herdrMachine: 'laptop', port: 3010 },
        { herdrMachine: 'desktop', port: 3011 },
      ]),
    ).toEqual(
      Result.succeed([
        { herdrMachine: 'laptop', port: 3010 },
        { herdrMachine: 'desktop', port: 3011 },
      ]),
    );
    expect(decode({}).inboxMachines).toBeUndefined();
    expect(inboxMachinesOf(decode({}))).toEqual(Result.succeed([]));
  });

  it('two machines on one port are refused, naming both', () => {
    expect(
      problemOf([
        { herdrMachine: 'laptop', port: 3010 },
        { herdrMachine: 'desktop', port: 3010 },
      ]),
    ).toBe(
      'inboxMachines — the Inbox machines "laptop" and "desktop" are both on port 3010: each needs its own',
    );
  });

  it('a machine on serve’s own port is refused', () => {
    expect(problemOf([{ herdrMachine: 'laptop', port: 7184 }])).toBe(
      `inboxMachines — the Inbox machine "laptop" is on port 7184, serve's own port: give its tunnel another`,
    );
  });

  it('a selector listed twice is refused', () => {
    expect(
      problemOf([
        { herdrMachine: 'laptop', port: 3010 },
        { herdrMachine: 'laptop', port: 3011 },
      ]),
    ).toBe(
      'inboxMachines — the Inbox machine "laptop" is listed more than once (names are compared regardless of case)',
    );
  });

  // A selector labels its machine's section whenever Herdr gives no label
  // (Herdr cannot be read, or the entry names no usable machine), so the
  // label rule holds for selectors too.
  it('a selector that differs from another only in case is refused', () => {
    expect(
      problemOf([
        { herdrMachine: 'laptop', port: 3010 },
        { herdrMachine: 'LAPTOP', port: 3011 },
      ]),
    ).toBe(
      'inboxMachines — the Inbox machine "LAPTOP" is listed more than once (names are compared regardless of case)',
    );
  });

  it('a selector that is Local’s section name, in any case, is refused', () => {
    for (const herdrMachine of ['Local', 'local']) {
      expect(problemOf([{ herdrMachine, port: 3010 }])).toBe(
        `inboxMachines — the Inbox machine "${herdrMachine}" is named as Local, the name the app gives this machine's own section: relabel it in Herdr, then name it here by its new label`,
      );
    }
  });

  it('a port outside 1–65535, or not an integer, is refused under its key', () => {
    for (const port of [0, 70000, 3010.5])
      expect(
        problemOf([{ herdrMachine: 'laptop', port }]).startsWith(
          'inboxMachines.0.port — ',
        ),
      ).toBe(true);
  });

  it('a value of the wrong shape is refused under its key, saying what was there', () => {
    expect(problemOf(3)).toBe('inboxMachines — expected array, got 3');
    expect(problemOf(null)).toBe('inboxMachines — expected array, got null');
  });

  it('an unknown key beside it is still tolerated', () => {
    expect(
      read([{ herdrMachine: 'laptop', port: 3010 }]).pipe(
        Result.map((ms) => ms.length),
      ),
    ).toEqual(Result.succeed(1));
    expect(decode({ inboxMachines: [], laterKey: 1 }).inboxMachines).toEqual({
      _tag: 'Listed',
      machines: [],
    });
  });

  it('a bad inboxMachines leaves the rest of config.json decoded and usable', () => {
    const config = decode({
      databasePath: '/x.sqlite',
      inboxMachines: [
        { herdrMachine: 'laptop', port: 3010 },
        { herdrMachine: 'desktop', port: 3010 },
      ],
    });
    expect(config.databasePath).toBe('/x.sqlite');
    expect(config.inboxMachines?._tag).toBe('Invalid');
  });

  it('another bad key still fails the file, and its sentence leaves inboxMachines out', () => {
    expect(
      describeConfigFailure(
        P,
        thrownBy({ databasePath: 42, inboxMachines: 3 }),
      ),
    ).toBe(`config.json at ${P}: databasePath — expected string, got 42`);
  });

  it.effect(
    'loadConfig reads a file whose inboxMachines is bad, and says why',
    () =>
      Effect.gen(function* () {
        const xdg = yield* xdgWith(
          JSON.stringify({
            databasePath: '/x.sqlite',
            inboxMachines: [{ herdrMachine: 'laptop', port: 7184 }],
          }),
        );
        const loaded = yield* withXdg(xdg, loadConfig());
        expect(loaded.config.databasePath).toBe('/x.sqlite');
        expect(inboxMachinesOf(loaded.config)).toEqual(
          Result.fail(
            `inboxMachines — the Inbox machine "laptop" is on port 7184, serve's own port: give its tunnel another`,
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it('encodes back to the value as it was read, bad or good', () => {
    const encode = Schema.encodeSync(AppConfig);
    for (const inboxMachines of [
      [{ herdrMachine: 'laptop', port: 3010 }],
      [
        { herdrMachine: 'laptop', port: 3010 },
        { herdrMachine: 'desktop', port: 3010 },
      ],
      'not a list',
    ])
      expect(encode(decode({ inboxMachines })).inboxMachines).toEqual(
        inboxMachines,
      );
  });
});

// serve over the tailnet.
describe('serve.tailnet', () => {
  const decode = Schema.decodeUnknownSync(AppConfig);
  const tailnet = (value: unknown) => decode({ serve: { tailnet: value } });

  it('decodes a MagicDNS host and its allowed peers, and is absent when unset', () => {
    expect(
      tailnet({ host: 'mac.tail0000.ts.net', allowFrom: ['100.64.0.7'] }).serve
        ?.tailnet,
    ).toEqual({ host: 'mac.tail0000.ts.net', allowFrom: ['100.64.0.7'] });
    expect(decode({}).serve).toBeUndefined();
  });

  it('refuses a host that is not a tailnet name, and a peer that is not an address', () => {
    expect(() =>
      tailnet({ host: 'https://mac.tail0000.ts.net', allowFrom: [] }),
    ).toThrow();
    expect(() => tailnet({ host: 'evil.example', allowFrom: [] })).toThrow();
    expect(() =>
      tailnet({ host: 'mac.tail0000.ts.net.', allowFrom: [] }),
    ).toThrow();
    expect(() =>
      tailnet({ host: 'mac.tail0000.ts.net', allowFrom: ['iphone'] }),
    ).toThrow();
    expect(() => tailnet({ host: 'mac.tail0000.ts.net' })).toThrow();
  });
});

// The metadata rules in metadata.json: the default, the user's own, and what
// bad rules say, which is never a failure of the load.
describe('metadata.json', () => {
  const M = '/home/u/.config/operator-inbox/metadata.json';
  // A rule specific to one user's workflow: not a default, but accepted.
  const rules = {
    extras: 'refuse',
    keys: [
      {
        key: 'ticket',
        type: 'string',
        description: 'The ticket id',
        presence: 'expected',
      },
    ],
  };
  const decode = (value: unknown) =>
    decodeMetadataRules(JSON.stringify(value), M);

  it('defaults to repo, branch and pr, expected, and the three built-in session keys', () => {
    expect(DEFAULT_INBOX_METADATA.keys.map((k) => k.key)).toEqual([
      'repo',
      'branch',
      'pr',
      'session',
      'sessionLink',
      'sessionTitle',
    ]);
    expect(
      DEFAULT_INBOX_METADATA.keys.every((k) => k.presence === 'expected'),
    ).toBe(true);
    expect(DEFAULT_INBOX_METADATA.extras).toBe('allow');
  });

  it('holds the built-in session keys over whatever the file says', () => {
    const read = decode({
      extras: 'allow',
      keys: [
        {
          key: 'sessionLink',
          description: 'mine',
          presence: 'optional',
          type: 'string',
        },
      ],
    });
    expect(Result.getOrThrow(read).keys).toEqual(BUILT_IN_METADATA_KEYS);
  });

  it('is what the user configured', () => {
    expect(decode(rules)).toEqual(
      Result.succeed(withBuiltInKeys(rules as InboxMetadataRules)),
    );
  });

  it('an empty list is a choice, not the default', () => {
    const none = { keys: [], extras: 'allow' };
    expect(decode(none)).toEqual(
      Result.succeed(withBuiltInKeys(none as InboxMetadataRules)),
    );
  });

  it('bad rules are a sentence naming the file and the key', () => {
    expect(decode({ keys: 3, extras: 'allow' })).toEqual(
      Result.fail(`metadata.json at ${M}: keys — expected array, got 3`),
    );
    const twice = decode({ ...rules, keys: [...rules.keys, ...rules.keys] });
    expect(Result.isFailure(twice) && twice.failure).toContain(
      `metadata.json at ${M}: `,
    );
    expect(Result.isFailure(twice) && twice.failure).toContain(
      'ticket is listed twice',
    );
    const notJson = decodeMetadataRules('{ nope', M);
    expect(Result.isFailure(notJson) && notJson.failure).toContain(
      `metadata.json at ${M} is not valid JSON: `,
    );
  });

  it.effect('the real loader reads the rules, and defaults with no file', () =>
    Effect.gen(function* () {
      const xdg = yield* xdgWith(JSON.stringify(rules), 'metadata.json');
      const ok = yield* withXdg(xdg, loadMetadataRules());
      expect(ok).toEqual({
        rules: Result.succeed(withBuiltInKeys(rules as InboxMetadataRules)),
        path: path.join(xdg, 'operator-inbox', 'metadata.json'),
        loaded: true,
      });

      const fs = yield* FileSystem.FileSystem;
      const none = yield* withXdg(
        yield* fs.makeTempDirectory(),
        loadMetadataRules(),
      );
      expect(none.rules).toEqual(Result.succeed(DEFAULT_INBOX_METADATA));
      expect(none.loaded).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    'reads the rules through a symlink, and bad rules never fail the load',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const xdg = yield* fs.makeTempDirectory();
        const elsewhere = yield* fs.makeTempDirectory();
        const target = path.join(elsewhere, 'rules.json');
        yield* fs.writeFileString(target, JSON.stringify(rules));
        yield* fs.makeDirectory(path.join(xdg, 'operator-inbox'));
        const link = path.join(xdg, 'operator-inbox', 'metadata.json');
        yield* fs.symlink(target, link);
        const linked = yield* withXdg(xdg, loadMetadataRules());
        expect(linked.rules).toEqual(
          Result.succeed(withBuiltInKeys(rules as InboxMetadataRules)),
        );

        yield* fs.writeFileString(target, '{"keys":3,"extras":"allow"}');
        const bad = yield* withXdg(xdg, loadMetadataRules());
        expect(Result.isFailure(bad.rules)).toBe(true);
        expect(bad.loaded).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
