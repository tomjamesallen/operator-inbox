import { planClaudeSettings } from '@operator-inbox/core';
import { Result } from 'effect';

// `operator-inbox doctor`'s rules: what each observation means, as a row that
// reads ok, warn or fail with a one-line fix. Pure: the command
// (`commands/doctor.ts`) observes the machine and hands the facts in, so
// every rule here is tested without touching one.
//
// fail is for what stops the app working (no server, a launch agent that
// cannot start, a store that does not open); warn is for what is optional or
// degrades it (the hooks, the skill, the desktop window, listen mode's voice).
// `doctor` exits non-zero on any fail, never on a warn.

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorStatus;
  readonly detail: string;
  /** One line saying what to run or do; absent on ok. */
  readonly fix?: string;
}

const ok = (id: string, detail: string): DoctorCheck => ({
  id,
  status: 'ok',
  detail,
});
const warn = (id: string, detail: string, fix: string): DoctorCheck => ({
  id,
  status: 'warn',
  detail,
  fix,
});
const fail = (id: string, detail: string, fix: string): DoctorCheck => ({
  id,
  status: 'fail',
  detail,
  fix,
});

// --- Node -------------------------------------------------------------------

/** The oldest Node the app runs on (the root package.json's `engines`). */
export const NODE_MIN = '22.16.0';

const parts = (version: string): ReadonlyArray<number> =>
  version
    .replace(/^v/, '')
    .split('.')
    .map((p) => Number.parseInt(p, 10) || 0);

/** Is `version` (`v22.16.0` or `22.16.0`) at least `min`? Part by part. */
export const versionAtLeast = (version: string, min: string): boolean => {
  const a = parts(version);
  const b = parts(min);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
};

export const nodeCheck = (version: string): DoctorCheck =>
  versionAtLeast(version, NODE_MIN)
    ? ok('node', `Node ${version}`)
    : fail(
        'node',
        `Node ${version} is older than ${NODE_MIN}`,
        `install Node ${NODE_MIN} or later, then re-run scripts/setup.sh so the launch agent runs it`,
      );

// --- The bin on PATH --------------------------------------------------------

export const binCheck = (found: string | undefined): DoctorCheck =>
  found !== undefined
    ? ok('bin', `operator-inbox is on PATH (${found})`)
    : fail(
        'bin',
        'operator-inbox is not on PATH, and agents and the hooks run it from there',
        "run scripts/setup.sh, and check pnpm's global bin folder is on PATH (pnpm setup)",
      );

// --- config.json ------------------------------------------------------------

export type ConfigObservation =
  | { readonly kind: 'absent'; readonly path: string }
  | { readonly kind: 'loaded'; readonly path: string }
  | { readonly kind: 'broken'; readonly message: string };

export const configCheck = (o: ConfigObservation): DoctorCheck => {
  switch (o.kind) {
    case 'absent':
      return ok('config', `no ${o.path}; the defaults apply`);
    case 'loaded':
      return ok('config', `${o.path} loads`);
    case 'broken':
      return fail('config', o.message, 'fix config.json by hand');
  }
};

// --- The store --------------------------------------------------------------

export type StoreObservation =
  | { readonly kind: 'unresolved'; readonly message: string }
  | { readonly kind: 'absent'; readonly path: string }
  | { readonly kind: 'opened'; readonly path: string }
  | {
      readonly kind: 'broken';
      readonly path: string;
      readonly message: string;
    };

export const storeCheck = (o: StoreObservation): DoctorCheck => {
  switch (o.kind) {
    case 'unresolved':
      return fail(
        'store',
        o.message,
        'set databasePath in config.json to an absolute path, or set XDG_STATE_HOME',
      );
    case 'absent':
      return warn(
        'store',
        `${o.path} is not made yet (it is made on first use)`,
        'run: operator-inbox install',
      );
    case 'opened':
      return ok('store', `${o.path} opens`);
    case 'broken':
      return fail(
        'store',
        `${o.path} does not open: ${o.message}`,
        'check the file is readable and not held by another program; operator-inbox info says where it is',
      );
  }
};

// --- The server -------------------------------------------------------------

export type ServerObservation =
  | { readonly kind: 'answered'; readonly url: string }
  | { readonly kind: 'status'; readonly url: string; readonly status: number }
  | { readonly kind: 'silent'; readonly url: string; readonly reason: string };

/** `log`: the file the launch agent writes, named in the fix when there is one. */
export const serverCheck = (
  o: ServerObservation,
  launchAgent: boolean,
  log: string | undefined,
): DoctorCheck => {
  if (o.kind === 'answered') return ok('server', `${o.url} answers`);
  const how = launchAgent
    ? `run scripts/setup.sh to load the launch agent${log === undefined ? '' : `, and read ${log}`}`
    : 'run: operator-inbox serve';
  return o.kind === 'status'
    ? fail(
        'server',
        `${o.url} answered ${o.status}; is something else on that port?`,
        how,
      )
    : fail('server', `nothing answers at ${o.url} (${o.reason})`, how);
};

// --- The launch agent (macOS) -----------------------------------------------

export const LAUNCH_AGENT_LABEL = 'com.operator-inbox.serve';

export interface LaunchAgentObservation {
  readonly plist: string;
  /** The plist's text, or undefined when there is none. */
  readonly text: string | undefined;
  readonly loaded: boolean;
  /** Does a path exist (and, for node, run)? Asked of the plist's two paths. */
  readonly exists: (p: string) => boolean;
  /** The command that loads the agent, for the fix. */
  readonly bootstrap: string;
}

const unescapeXml = (s: string): string =>
  s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

/**
 * The strings of a plist's ProgramArguments, in the layout `setup.sh` writes.
 * Empty when it has none.
 */
export const plistProgramArguments = (text: string): ReadonlyArray<string> => {
  const array =
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  if (array === null) return [];
  return [...(array[1] ?? '').matchAll(/<string>([\s\S]*?)<\/string>/g)].map(
    (m) => unescapeXml(m[1] ?? ''),
  );
};

/** The string a plist gives `key`, or undefined. */
export const plistString = (text: string, key: string): string | undefined => {
  const m = new RegExp(
    `<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`,
  ).exec(text);
  return m === null ? undefined : unescapeXml(m[1] ?? '');
};

export const launchAgentCheck = (o: LaunchAgentObservation): DoctorCheck => {
  const id = 'launch-agent';
  if (o.text === undefined) {
    return o.loaded
      ? warn(
          id,
          `${LAUNCH_AGENT_LABEL} is loaded but ${o.plist} is missing`,
          'run scripts/setup.sh to write it',
        )
      : fail(
          id,
          `${o.plist} is not installed`,
          'run scripts/setup.sh (or run operator-inbox serve yourself)',
        );
  }
  const [node, entry] = plistProgramArguments(o.text);
  if (node !== undefined && !o.exists(node)) {
    return fail(
      id,
      `the plist runs node ${node}, which is gone`,
      'run: scripts/setup.sh rebuild (it points the plist at the node on PATH)',
    );
  }
  if (entry !== undefined && !o.exists(entry)) {
    return fail(
      id,
      `the plist runs ${entry}, which is gone`,
      'run scripts/setup.sh from the checkout you want it to run',
    );
  }
  if (!o.loaded) {
    return fail(
      id,
      `${LAUNCH_AGENT_LABEL} is not loaded`,
      `run: ${o.bootstrap}`,
    );
  }
  return ok(
    id,
    `${LAUNCH_AGENT_LABEL} is loaded${entry === undefined ? '' : `, running ${entry}`}`,
  );
};

// --- The Claude Code hooks --------------------------------------------------

/** `raw`: settings.json's text, or null when there is none. */
export const hooksCheck = (shown: string, raw: string | null): DoctorCheck => {
  const id = 'hooks';
  const fix = 'run: operator-inbox install-claude-hooks';
  if (raw === null) {
    return warn(
      id,
      `${shown} does not exist, so inbox mode's hooks are not installed`,
      fix,
    );
  }
  const planned = planClaudeSettings(raw);
  if (Result.isFailure(planned)) {
    return warn(
      id,
      `${shown}: ${planned.failure}`,
      'fix the file by hand, then run: operator-inbox install-claude-hooks',
    );
  }
  return planned.success.changed
    ? warn(id, `inbox mode's hooks in ${shown} are missing or out of date`, fix)
    : ok(id, `inbox mode's hooks are installed in ${shown}`);
};

// --- The skill --------------------------------------------------------------

/** `installed`: the installed SKILL.md's text, or null when there is none. */
export const skillCheck = (
  shown: string,
  installed: string | null,
  shipped: string,
): DoctorCheck => {
  const id = 'skill';
  const fix = `run: mkdir -p ${dirnameOf(shown)} && operator-inbox skill > ${shown}`;
  if (installed === null) {
    return warn(id, `${shown} is not installed`, fix);
  }
  return installed === shipped
    ? ok(id, `${shown} matches this CLI's skill`)
    : warn(id, `${shown} differs from the skill this CLI ships`, fix);
};

const dirnameOf = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i <= 0 ? p : p.slice(0, i);
};

// --- The desktop window -----------------------------------------------------

export type DesktopObservation =
  | { readonly kind: 'no-script' }
  | { readonly kind: 'checked'; readonly code: number; readonly line: string };

/**
 * `desktop-app.sh check` prints one line and exits 0 when the window is
 * current (or this is not macOS), 1 otherwise. The window is optional, so
 * anything but current is a warn.
 */
export const desktopCheck = (
  o: DesktopObservation,
  build: string,
): DoctorCheck => {
  const id = 'desktop';
  if (o.kind === 'no-script') {
    return warn(
      id,
      'scripts/desktop-app.sh is not beside this CLI, so the window is not checked',
      'run doctor from the CLI a checkout builds',
    );
  }
  const detail = o.line.replace(/^desktop window: /, '').trim();
  if (o.code === 0) return ok(id, detail);
  return warn(
    id,
    detail === '' ? `desktop-app.sh check exited ${o.code}` : detail,
    `optional; to build it: ${build}`,
  );
};

// --- Listen mode's voice ----------------------------------------------------

export type VoiceObservation =
  | { readonly kind: 'unsupported'; readonly platform: string }
  | { readonly kind: 'found'; readonly python: string }
  | { readonly kind: 'missing'; readonly message: string };

export const voiceCheck = (o: VoiceObservation): DoctorCheck => {
  const id = 'voice';
  switch (o.kind) {
    case 'unsupported':
      return ok(
        id,
        `listen mode needs Apple silicon, so it is off on ${o.platform}`,
      );
    case 'found':
      return ok(id, `listen mode's voice runs on ${o.python}`);
    case 'missing':
      return warn(
        id,
        `listen mode is off: ${o.message}`,
        'optional; install uv, then run: uv tool install mlx-audio',
      );
  }
};

// --- The report -------------------------------------------------------------

export interface DoctorReport {
  readonly ok: boolean;
  readonly counts: Readonly<Record<DoctorStatus, number>>;
  readonly checks: ReadonlyArray<DoctorCheck>;
}

export const reportOf = (checks: ReadonlyArray<DoctorCheck>): DoctorReport => {
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.status] += 1;
  return { ok: counts.fail === 0, counts, checks };
};

/** The text form: one row per check, its fix under it, then the counts. */
export const renderDoctor = (report: DoctorReport): string => {
  const width = Math.max(...report.checks.map((c) => c.id.length));
  const rows = report.checks.flatMap((c) => [
    `${c.status.padEnd(4)}  ${c.id.padEnd(width)}  ${c.detail}`,
    ...(c.fix === undefined ? [] : [`${' '.repeat(width + 8)}fix: ${c.fix}`]),
  ]);
  const { ok: okCount, warn: warnCount, fail: failCount } = report.counts;
  return [
    ...rows,
    '',
    `${okCount} ok, ${warnCount} warn, ${failCount} fail`,
  ].join('\n');
};
