import path from 'node:path';
import {
  Config,
  Data,
  Effect,
  FileSystem,
  Option,
  Result,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from 'effect';
import { LOCAL_MACHINE } from './api/inbox-api';
import { ChaseAfterMinutes } from './api/inbox-config-api';
import { SERVE_DEFAULT_PORT } from './api/serve-port';
import {
  DEFAULT_INBOX_METADATA,
  InboxMetadataRules,
  metadataRulesProblems,
  withBuiltInKeys,
} from './inbox-metadata';
import { InboxMachinePort } from './schema/identifiers';
import { joinSchemaIssuePath } from './schema-issues';

// The app's configuration: three files under
// `$XDG_CONFIG_HOME/operator-inbox/` (default `~/.config/operator-inbox/`),
// each optional, so a missing file is all defaults.
//
// - `config.json`: this machine's settings (`AppConfig`): where the inbox
//   database lives, serve over the tailnet, and the Inbox machines.
// - `metadata.json`: the metadata rules (`InboxMetadataRules`), a user
//   preference. It may be a symlink into a dotfiles checkout; the app only
//   reads it.
// - `keybindings`: the inbox screen's key overrides, in Ghostty's config
//   syntax (`keymap/config.ts`). Read only, and it may be a symlink too; serve
//   hands its text to the page, which parses it.
//
// Nothing here writes a file.

/** The directory every config file sits in, under the config home. */
export const CONFIG_DIR_NAME = 'operator-inbox';
export const CONFIG_FILE = 'config.json';
export const METADATA_FILE = 'metadata.json';
export const KEYBINDINGS_FILE = 'keybindings';

// A config file that exists and does not decode. Carries a MESSAGE as well as
// the cause: the CLI's error boundary prints `e.message` for any Error, and a
// tagged error without one would print the app's name followed by nothing.
export class ConfigError extends Data.TaggedError('ConfigError')<{
  readonly cause: unknown;
  readonly message: string;
}> {}

// One sentence for a config file that did not load, naming the file and, for
// a schema miss, the key, what was expected and what was there:
//
//   config.json at ~/.config/operator-inbox/config.json: serve.tailnet.host —
//   expected a string, got 3
//
// Pure over the thrown cause, so a test can drive every shape without a
// filesystem. The cause is the `Schema.SchemaError` that `decodeUnknownSync`
// throws; its issue tree is flattened by Effect's Standard Schema formatter
// into one `{ path, message }` per failure. The loader decodes with
// `reportInput: true`, so a type miss reads `Expected X, got Y`, and a union
// names its alternatives in one message as `Expected A | B, got Y`. An
// optional field adds `undefined` to that list, which is the schema's
// business, not the operator's, so it is dropped when any other expectation
// is present. A message in another shape (a refinement, a brand) passes
// through verbatim. Effect names a struct or record `object`; the operator
// reads "an object". Every other expectation (a literal, a primitive) reads
// well as it is. The alternatives are split on ` | `, which no expectation
// this schema can produce contains inside one alternative.
const humanExpected = (expected: string): string =>
  expected === 'object' ? 'an object' : expected;

const describeFileFailure = (
  fileName: string,
  filePath: string,
  cause: unknown,
): string => {
  const at = `${fileName} at ${filePath}`;
  if (!Schema.isSchemaError(cause)) {
    // JSON.parse threw (a SyntaxError), or something unforeseen: its own
    // sentence is the best there is.
    const reason = cause instanceof Error ? cause.message : String(cause);
    return `${at} is not valid JSON: ${reason}`;
  }
  return `${at}: ${describeSchemaClauses(cause)}`;
};

/** Why `config.json` at `configPath` did not load, as one sentence. */
export const describeConfigFailure = (
  configPath: string,
  cause: unknown,
): string => describeFileFailure(CONFIG_FILE, configPath, cause);

// The clauses of one schema failure, `key — what was wrong`, joined by `; `.
// `under` is the key the decoded value sat at, for a value decoded apart
// from the rest (`inboxMachines`), so its clauses name the same dotted key
// as a whole-file decode would.
const describeSchemaClauses = (
  cause: Schema.SchemaError,
  under?: string,
): string => {
  const { issues } = SchemaIssue.makeFormatterStandardSchemaV1()(cause.issue);
  // Group by path so the alternatives of one union fold into one clause.
  const byKey = new Map<
    string,
    { readonly expected: Array<string>; actual: string | undefined }
  >();
  const raw: Array<string> = [];
  for (const issue of issues) {
    const path = [
      ...(under === undefined ? [] : [under]),
      ...(issue.path ?? []),
    ];
    const key = path.length === 0 ? '(top level)' : joinSchemaIssuePath(path);
    const m = /^Expected (.+), got (.+)$/s.exec(issue.message);
    if (m === null) {
      raw.push(`${key} — ${issue.message}`);
      continue;
    }
    const entry = byKey.get(key) ?? { expected: [], actual: undefined };
    for (const alternative of (m[1] ?? '').split(' | ')) {
      const expected = humanExpected(alternative);
      if (expected !== 'undefined' && !entry.expected.includes(expected)) {
        entry.expected.push(expected);
      }
    }
    entry.actual = m[2];
    byKey.set(key, entry);
  }
  // Keep an expectation-less clause only when it is all there is: a clause
  // whose only alternative was `undefined` says nothing the operator can act
  // on beside a clause that does.
  const entries = [...byKey.entries()];
  const informative = entries.filter(([, e]) => e.expected.length > 0);
  const clauses = (informative.length > 0 ? informative : entries).map(
    ([key, { expected, actual }]) =>
      expected.length === 0
        ? `${key} — unexpected value ${actual}`
        : `${key} — expected ${expected.join(' or ')}, got ${actual}`,
  );
  return [...clauses, ...raw].join('; ');
};

// --- config.json: Inbox machines ---------------------------------------------

// One Inbox machine: a Herdr machine whose Inboxes Local's serve merges into
// its own, and the local port its SSH tunnel listens on. `herdrMachine` is a
// selector under the rule `findMachine` applies (an id or a unique label),
// resolved against `herdr machine list --json` when it is needed, so a renamed
// profile is caught then rather than here.
export const InboxMachine = Schema.Struct({
  herdrMachine: Schema.String,
  port: InboxMachinePort,
});
export type InboxMachine = typeof InboxMachine.Type;

// The list refuses a clash at decode: two machines on one port would read
// one machine twice, and a machine on serve's own port would be Local reading
// itself. A selector named twice is refused too, since it is one machine, and
// so is a selector that is Local's own section name; both compared
// regardless of case, as labels are. Herdr gives no label to a machine whose
// entry names no usable Herdr machine, so its section is labelled by its
// selector; this keeps those selectors apart from each other and from
// Local's, and `inboxMachineLabels` keeps them apart from Herdr's labels.
// Each refusal is a sentence, which `describeConfigFailure` passes through
// under the `inboxMachines` key.
const inboxMachinesClash = (
  machines: ReadonlyArray<InboxMachine>,
): true | string => {
  const onServe = machines.find((m) => m.port === SERVE_DEFAULT_PORT);
  if (onServe !== undefined)
    return `the Inbox machine "${onServe.herdrMachine}" is on port ${SERVE_DEFAULT_PORT}, serve's own port: give its tunnel another`;
  const ports = new Map<number, string>();
  const selectors = new Set<string>();
  for (const m of machines) {
    const other = ports.get(m.port);
    if (other !== undefined)
      return `the Inbox machines "${other}" and "${m.herdrMachine}" are both on port ${m.port}: each needs its own`;
    const selector = m.herdrMachine.toLowerCase();
    if (selector === LOCAL_MACHINE.toLowerCase())
      return `the Inbox machine "${m.herdrMachine}" is named as Local, the name the app gives this machine's own section: relabel it in Herdr, then name it here by its new label`;
    if (selectors.has(selector))
      return `the Inbox machine "${m.herdrMachine}" is listed more than once (names are compared regardless of case)`;
    ports.set(m.port, m.herdrMachine);
    selectors.add(selector);
  }
  return true;
};

export const InboxMachines = Schema.Array(InboxMachine).check(
  Schema.makeFilter(inboxMachinesClash, {
    description:
      'Inbox machines on distinct ports, none on serve’s own, each named once',
  }),
);

// `inboxMachines` as the config holds it, read apart from the rest of
// config.json: a value that does not decode, a port clash included, is
// `Invalid` with the sentence saying why, never a failure of the whole file,
// so every command still reads config.json. Serve then reads no Inbox machine
// and its page says why. `problem` is clauses as `describeConfigFailure`
// writes them, under the `inboxMachines` key (`inboxMachines — the Inbox
// machines "laptop" and "desktop" are both on port 3010: each needs its
// own`). `raw` is the value as the file holds it, so the setting encodes back
// to what the operator wrote.
const InboxMachinesSetting = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('Listed'),
    machines: Schema.Array(InboxMachine),
  }),
  Schema.Struct({
    _tag: Schema.Literal('Invalid'),
    problem: Schema.String,
    raw: Schema.Unknown,
  }),
]);
export type InboxMachinesSetting = typeof InboxMachinesSetting.Type;

const decodeInboxMachines = Schema.decodeUnknownResult(InboxMachines, {
  errors: 'all',
  reportInput: true,
});

// The transformation meets the setting at its encoded side, where a port is
// still a plain number: `InboxMachinesSetting`'s own decode then brands it.
type InboxMachinesSettingEncoded = typeof InboxMachinesSetting.Encoded;

export const InboxMachinesField = Schema.Unknown.pipe(
  Schema.decodeTo(
    InboxMachinesSetting,
    SchemaTransformation.transform({
      decode: (raw): InboxMachinesSettingEncoded => {
        const decoded = decodeInboxMachines(raw);
        return Result.isSuccess(decoded)
          ? { _tag: 'Listed', machines: decoded.success }
          : {
              _tag: 'Invalid',
              problem: describeSchemaClauses(decoded.failure, 'inboxMachines'),
              raw,
            };
      },
      encode: (setting: InboxMachinesSettingEncoded): unknown =>
        setting._tag === 'Listed' ? setting.machines : setting.raw,
    }),
  ),
);

// The configured machines, or the sentence saying why `inboxMachines` could
// not be read. Unset is none.
export const inboxMachinesOf = (
  config: Pick<AppConfig, 'inboxMachines'>,
): Result.Result<ReadonlyArray<InboxMachine>, string> => {
  const setting = config.inboxMachines;
  if (setting === undefined) return Result.succeed([]);
  return setting._tag === 'Listed'
    ? Result.succeed(setting.machines)
    : Result.fail(setting.problem);
};

// --- config.json: serve ------------------------------------------------------

// Serve over the tailnet: `tailscale serve` proxies `http(s)://<host>` on the
// tailnet, or `http(s)://<host>:<serve's own port>` when 80 and 443 are taken,
// to serve on 127.0.0.1, and serve answers such a request only when
// the peer Tailscale names is in `allowFrom`. `host` is this machine's
// MagicDNS name (`tailscale status --json`, `Self.DNSName`, without its
// trailing dot); each `allowFrom` entry is a peer's tailnet address, as
// `tailscale status` prints it.
export const ServeTailnet = Schema.Struct({
  host: Schema.String.check(
    Schema.isPattern(/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/),
  ),
  allowFrom: Schema.Array(
    Schema.String.check(Schema.isPattern(/^[0-9a-f.:]+$/)),
  ),
});
export type ServeTailnet = typeof ServeTailnet.Type;

// --- config.json -------------------------------------------------------------

// A key this build does not know (written for a newer config than the
// installed binary knows) is silently dropped by the decoder's excess-property
// tolerance, and that is CORRECT: `onExcessProperty: 'error'` would turn every
// future config field into a hard startup failure for an older binary reading
// a newer config.
export const AppConfig = Schema.Struct({
  // Where the inbox event log's SQLite file lives (`inbox-database.ts`).
  // Unset is the normal case: `$XDG_STATE_HOME/operator-inbox/inbox.sqlite`.
  // An absolute path here overrides that default, and
  // `OPERATOR_INBOX_DATABASE_PATH` overrides this.
  databasePath: Schema.optional(Schema.String),
  // `operator-inbox serve`. Unset `tailnet`: serve answers 127.0.0.1 and
  // `localhost` only.
  serve: Schema.optional(
    Schema.Struct({ tailnet: Schema.optional(ServeTailnet) }),
  ),
  // The Inbox machines whose Inboxes Local's serve merges at read time, in
  // the order the sidebar lists them. Unset: Local's Inboxes only. Decoded
  // apart from the rest (`InboxMachinesField`): read it through
  // `inboxMachinesOf`.
  inboxMachines: Schema.optional(InboxMachinesField),
  // How long a question may sit with the agent before the page says it
  // probably needs chasing, in minutes. Unset: `DEFAULT_CHASE_AFTER_MINUTES`.
  chaseAfterMinutes: Schema.optional(ChaseAfterMinutes),
});
export type AppConfig = typeof AppConfig.Type;

// --- where the files are -----------------------------------------------------

/**
 * The config base: `$XDG_CONFIG_HOME`, or `<home>/.config`. A blank or
 * relative `XDG_CONFIG_HOME` counts as unset, as the XDG spec says, so the base
 * is always absolute. Pure: the env read happens in `loadXdgConfigHome`.
 */
export const configHome = (inputs: {
  readonly xdgConfigHome: string | undefined;
  readonly home: string;
}): string => {
  const config = inputs.xdgConfigHome?.trim();
  return config !== undefined && path.isAbsolute(config)
    ? config
    : path.join(inputs.home, '.config');
};

// Pure path builders over an already-resolved config base (`configHome`, or
// `loadXdgConfigHome` at the edge).
export const configDir = (xdgConfigHome: string): string =>
  path.join(xdgConfigHome, CONFIG_DIR_NAME);

export const configPath = (xdgConfigHome: string): string =>
  path.join(configDir(xdgConfigHome), CONFIG_FILE);

export const metadataPath = (xdgConfigHome: string): string =>
  path.join(configDir(xdgConfigHome), METADATA_FILE);

export const keybindingsPath = (xdgConfigHome: string): string =>
  path.join(configDir(xdgConfigHome), KEYBINDINGS_FILE);

// `$HOME`, read through `Config` like every other environment variable, so a
// test's ConfigProvider decides it and no read reaches the real home folder
// by another way. Unset or blank is none.
const readHome: Effect.Effect<Option.Option<string>> = Config.option(
  Config.String('HOME'),
).pipe(Effect.orDie, Effect.map(Option.filter((home) => home.trim() !== '')));

/**
 * The config base this process uses, read through `Config` (the mockable edge,
 * testable through a `ConfigProvider`). An unset, blank or relative
 * `XDG_CONFIG_HOME` is `$HOME/.config`; with no `HOME` either there is no
 * absolute base, and that is a `ConfigError` rather than a path relative to
 * wherever the process runs.
 */
export const loadXdgConfigHome: Effect.Effect<string, ConfigError> = Effect.gen(
  function* () {
    const xdgConfigHome = yield* Config.String('XDG_CONFIG_HOME').pipe(
      Effect.orElseSucceed(() => ''),
    );
    const home = yield* readHome;
    const base = configHome({
      xdgConfigHome,
      home: Option.getOrElse(home, () => ''),
    });
    if (!path.isAbsolute(base))
      return yield* new ConfigError({
        cause: undefined,
        message:
          'HOME is not set, so the config folder cannot be found; set XDG_CONFIG_HOME',
      });
    return base;
  },
);

// --- loading -----------------------------------------------------------------

export interface LoadedConfig {
  readonly config: AppConfig;
  readonly path: string;
  readonly loaded: boolean;
}

/** `config.json`, or every default when there is no file. */
export const loadConfig = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const p = configPath(yield* loadXdgConfigHome);
  const exists = yield* fs.exists(p);
  const empty: AppConfig = {};
  if (!exists)
    return { config: empty, path: p, loaded: false } satisfies LoadedConfig;
  const content = yield* fs.readFileString(p);
  const config = yield* Effect.try({
    // `errors: 'all'`, so two typos are one message rather than one per run;
    // `reportInput: true`, so the message can say what was there.
    try: () =>
      Schema.decodeUnknownSync(AppConfig, {
        errors: 'all',
        reportInput: true,
      })(JSON.parse(content)),
    catch: (cause) =>
      new ConfigError({ cause, message: describeConfigFailure(p, cause) }),
  });
  return { config, path: p, loaded: true } satisfies LoadedConfig;
});

const decodeRules = Schema.decodeUnknownSync(InboxMetadataRules, {
  errors: 'all',
  reportInput: true,
});

/**
 * The metadata rules a `metadata.json` holds, with the built-in keys in force,
 * or the one sentence saying why they cannot be used: not JSON, not the rules'
 * shape, or rules that do not hold together (`metadataRulesProblems`). Pure
 * over the file's text, so a test needs no filesystem.
 */
export const decodeMetadataRules = (
  text: string,
  filePath: string,
): Result.Result<InboxMetadataRules, string> => {
  let rules: InboxMetadataRules;
  try {
    rules = decodeRules(JSON.parse(text));
  } catch (cause) {
    return Result.fail(describeFileFailure(METADATA_FILE, filePath, cause));
  }
  const problems = metadataRulesProblems(rules);
  return problems.length === 0
    ? Result.succeed(withBuiltInKeys(rules))
    : Result.fail(`${METADATA_FILE} at ${filePath}: ${problems.join('; ')}`);
};

export interface LoadedMetadataRules {
  /** The rules in force, or the sentence saying why the file's cannot be. */
  readonly rules: Result.Result<InboxMetadataRules, string>;
  readonly path: string;
  readonly loaded: boolean;
}

/**
 * `metadata.json`'s rules, or `DEFAULT_INBOX_METADATA` when there is no file.
 * A file that does not decode is never a failure of the Effect: it costs the
 * rules and nothing else, so a command that writes no metadata still runs, and
 * one that does says why it cannot. The Effect fails only when the config
 * folder itself cannot be found (no HOME and no XDG_CONFIG_HOME).
 */
export const loadMetadataRules = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const p = metadataPath(yield* loadXdgConfigHome);
  const exists = yield* fs.exists(p);
  if (!exists)
    return {
      rules: Result.succeed(DEFAULT_INBOX_METADATA),
      path: p,
      loaded: false,
    } satisfies LoadedMetadataRules;
  const text = yield* fs.readFileString(p);
  return {
    rules: decodeMetadataRules(text, p),
    path: p,
    loaded: true,
  } satisfies LoadedMetadataRules;
});
