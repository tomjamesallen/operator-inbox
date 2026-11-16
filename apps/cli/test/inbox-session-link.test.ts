import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import {
  InboxId,
  type InboxMetadataRules,
  type Metadata,
  SessionId,
  SessionLink,
} from '@operator-inbox/core';
import { Effect, Option } from 'effect';
import { TestConsole } from 'effect/testing';
import {
  desktopSessionOf,
  dispatchAsk,
  dispatchMeta,
  dispatchOpen,
  expectedKeysWarning,
  type InboxSession,
} from '../src/commands/inbox';
import { type InboxLog, InboxLogInMemory } from '../src/inbox-store';
import {
  desktopSessionsDir,
  findDesktopSession,
  openSessionLink,
} from '../src/session-edge';

// The desktop session link at the CLI: found through a fixture of
// the app's session files, filled on `open` only, and never able to fail one.

const SESSION: InboxSession = {
  sessionId: SessionId.make('5864bf61-865e-4e99-a732-06c14e89bb50'),
  cwd: '/work/my-app',
};
const LATER: InboxSession = {
  sessionId: SessionId.make('7a9c1e22-0000-4000-8000-000000000000'),
  cwd: '/work/my-app',
};
const ID = InboxId.make('01SESSIONLINKAAAAAAAAAAAAA');
const LINK = SessionLink.make('claude://claude.ai/epitaxy/local_aaaa-1111');
const NEXT = SessionLink.make('claude://claude.ai/epitaxy/local_bbbb-2222');

const rule = (key: string, more: object = {}) => ({
  key,
  type: 'string' as const,
  description: key,
  presence: 'expected' as const,
  ...more,
});

const fixture = (
  files: Readonly<Record<string, string>>,
  dirs = ['account', 'org'],
) => {
  const root = mkdtempSync(path.join(tmpdir(), 'operator-inbox-session-link-'));
  const dir = path.join(root, ...dirs);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files))
    writeFileSync(path.join(dir, name), content);
  return root;
};

const sessionFile = (id: string, cli: string, more: object = {}) =>
  JSON.stringify({ sessionId: id, cliSessionId: cli, ...more });

const find = (root: string, session: InboxSession = SESSION) =>
  findDesktopSession(root, session.sessionId).pipe(
    Effect.map(Option.map((found) => found.link)),
    Effect.provide(NodeServices.layer),
  );

describe('finding the desktop session', () => {
  it('looks under the app’s folder in the home folder', () => {
    expect(desktopSessionsDir('/Users/x')).toBe(
      '/Users/x/Library/Application Support/Claude/claude-code-sessions',
    );
  });

  it.effect('finds the file whose cliSessionId is this session’s', () =>
    Effect.gen(function* () {
      const root = fixture({
        'local_other.json': sessionFile('local_other', 'someone-else'),
        'local_aaaa-1111.json': sessionFile(
          'local_aaaa-1111',
          SESSION.sessionId,
        ),
      });
      expect(yield* find(root)).toEqual(Option.some(LINK));
    }),
  );

  it.effect(
    'takes only the link and title from a file with other settings',
    () =>
      Effect.gen(function* () {
        const root = fixture({
          'local_aaaa-1111.json': sessionFile(
            'local_aaaa-1111',
            SESSION.sessionId,
            {
              title: 'A private title',
              cwd: '/private/work',
              isArchived: true,
              permissionMode: 'secret-setting',
              mcp: { token: 'not-for-the-inbox' },
            },
          ),
        });
        const found = yield* findDesktopSession(root, SESSION.sessionId).pipe(
          Effect.provide(NodeServices.layer),
        );
        const desktopSession = { link: LINK, title: 'A private title' };
        expect(found).toEqual(Option.some(desktopSession));
        const metadata = yield* dispatchOpen({
          session: Option.some(SESSION),
          inbox: Option.none(),
          label: Option.some('held'),
          freshId: ID,
          cwd: '/x',
          desktopSession,
        }).pipe(
          Effect.andThen(
            dispatchMeta({ inboxId: ID, set: {}, unset: [], json: true }),
          ),
          Effect.provide(InboxLogInMemory),
        );
        expect(JSON.parse(metadata)).toEqual({
          sessionLink: LINK,
          sessionTitle: 'A private title',
        });
      }),
  );

  it.effect('says nothing when no file is this session’s', () =>
    Effect.gen(function* () {
      const root = fixture({
        'local_other.json': sessionFile('local_other', 'someone-else'),
      });
      expect(yield* find(root)).toEqual(Option.none());
    }),
  );

  it.effect('says nothing when the folder is not there', () =>
    Effect.gen(function* () {
      expect(yield* find('/nowhere/at/all')).toEqual(Option.none());
    }),
  );

  it.effect('reads past a bad file and the app’s other files', () =>
    Effect.gen(function* () {
      const root = fixture({
        'local_bad.json': '{not json',
        'local_partial.json': '{"sessionId":"local_x"}',
        'archived-sessions.idx': 'x',
        'scheduled-tasks.json': sessionFile('local_no', SESSION.sessionId),
        'local_aaaa-1111.json': sessionFile(
          'local_aaaa-1111',
          SESSION.sessionId,
        ),
      });
      expect(yield* find(root)).toEqual(Option.some(LINK));
    }),
  );

  it.effect('skips a file that is a directory by its name', () =>
    Effect.gen(function* () {
      const root = fixture({});
      mkdirSync(path.join(root, 'account', 'org', 'local_dir.json'));
      expect(yield* find(root)).toEqual(Option.none());
    }),
  );

  it.effect('takes the newest when two files name the session', () =>
    Effect.gen(function* () {
      const root = fixture({
        'local_aaaa-1111.json': sessionFile(
          'local_aaaa-1111',
          SESSION.sessionId,
        ),
        'local_bbbb-2222.json': sessionFile(
          'local_bbbb-2222',
          SESSION.sessionId,
        ),
      });
      utimesSync(
        path.join(root, 'account', 'org', 'local_aaaa-1111.json'),
        1_000,
        1_000,
      );
      expect(yield* find(root)).toEqual(Option.some(NEXT));
    }),
  );

  it.effect('has no link to find outside a session', () =>
    Effect.gen(function* () {
      const root = fixture({
        'local_aaaa-1111.json': sessionFile(
          'local_aaaa-1111',
          SESSION.sessionId,
        ),
      });
      const none = yield* desktopSessionOf(root, Option.none()).pipe(
        Effect.provide(NodeServices.layer),
      );
      expect(none).toBeUndefined();
      const some = yield* desktopSessionOf(root, Option.some(SESSION)).pipe(
        Effect.provide(NodeServices.layer),
      );
      expect(some?.link).toBe(LINK);
    }),
  );
});

const provide = <A, E>(effect: Effect.Effect<A, E, InboxLog>) =>
  effect.pipe(Effect.provide(InboxLogInMemory));

const open = ({
  sessionLink,
  sessionTitle,
  ...rest
}: {
  readonly session?: Option.Option<InboxSession>;
  readonly inbox?: Option.Option<string>;
  readonly label?: Option.Option<string>;
  readonly metadata?: Metadata;
  readonly sessionLink?: SessionLink;
  readonly sessionTitle?: string;
  readonly rules?: InboxMetadataRules;
} = {}) =>
  dispatchOpen({
    session: Option.some(SESSION),
    inbox: Option.none(),
    label: Option.some('my-app'),
    freshId: ID,
    cwd: '/plain/shell',
    ...rest,
    ...(sessionLink === undefined
      ? {}
      : {
          desktopSession: {
            link: sessionLink,
            ...(sessionTitle === undefined ? {} : { title: sessionTitle }),
          },
        }),
  });

const inboxMeta = dispatchMeta({
  inboxId: ID,
  set: {},
  unset: [],
  json: true,
}).pipe(Effect.map((out) => JSON.parse(out) as Metadata));

const said = Effect.map(TestConsole.errorLines, (lines) => lines.map(String));

describe('inbox open fills the link', () => {
  it.effect('on a new Inbox', () =>
    provide(
      Effect.gen(function* () {
        yield* open({ sessionLink: LINK, metadata: { team: 'a' } });
        expect(yield* inboxMeta).toEqual({ team: 'a', sessionLink: LINK });
      }),
    ),
  );

  it.effect('before the rules run, so a required key counts as set', () =>
    provide(
      Effect.gen(function* () {
        const rules: InboxMetadataRules = {
          extras: 'allow',
          keys: [rule('sessionLink', { presence: 'required' })],
        };
        const out = yield* open({ sessionLink: LINK, rules });
        expect(out).toContain('(opened)');
        expect(yield* said).toEqual([]);
      }),
    ),
  );

  it.effect('and an explicit value wins', () =>
    provide(
      Effect.gen(function* () {
        const own = 'claude://claude.ai/epitaxy/local_mine';
        yield* open({ sessionLink: LINK, metadata: { sessionLink: own } });
        expect(yield* inboxMeta).toEqual({ sessionLink: own });
      }),
    ),
  );

  it.effect('and leaves it out with no desktop session', () =>
    provide(
      Effect.gen(function* () {
        yield* open();
        expect(yield* inboxMeta).toEqual({});
      }),
    ),
  );

  it.effect('and the expected warning covers a session with none', () =>
    provide(
      Effect.gen(function* () {
        const rules: InboxMetadataRules = {
          extras: 'allow',
          keys: [rule('sessionLink', { level: 'inbox' })],
        };
        const out = yield* open({ rules });
        expect(out).toContain('(opened)');
        expect(yield* said).toEqual([expectedKeysWarning(['sessionLink'])]);
      }),
    ),
  );

  it.effect('replacing the link when a later session adopts the Inbox', () =>
    provide(
      Effect.gen(function* () {
        yield* open({ sessionLink: LINK });
        yield* open({
          session: Option.some(LATER),
          inbox: Option.some(ID),
          label: Option.none(),
          sessionLink: NEXT,
        });
        expect(yield* inboxMeta).toEqual({ sessionLink: NEXT });
      }),
    ),
  );

  it.effect('and on this session’s own Inbox, reached again', () =>
    provide(
      Effect.gen(function* () {
        yield* open({ sessionLink: LINK });
        yield* open({ label: Option.none(), sessionLink: NEXT });
        expect(yield* inboxMeta).toEqual({ sessionLink: NEXT });
        // The same link again changes nothing, and is not an error.
        const out = yield* open({ label: Option.none(), sessionLink: NEXT });
        expect(out).toContain("(this session's)");
      }),
    ),
  );

  it.effect('leaving an existing link alone outside a desktop session', () =>
    provide(
      Effect.gen(function* () {
        yield* open({ sessionLink: LINK });
        yield* open({
          session: Option.some(LATER),
          inbox: Option.some(ID),
          label: Option.none(),
        });
        yield* open({
          session: Option.none(),
          inbox: Option.some(ID),
          label: Option.none(),
        });
        expect(yield* inboxMeta).toEqual({ sessionLink: LINK });
      }),
    ),
  );

  it.effect('and an explicit value still wins on an existing Inbox', () =>
    provide(
      Effect.gen(function* () {
        const own = 'claude://claude.ai/epitaxy/local_mine';
        yield* open({ sessionLink: LINK });
        yield* open({
          label: Option.none(),
          sessionLink: NEXT,
          metadata: { sessionLink: own },
        });
        expect(yield* inboxMeta).toEqual({ sessionLink: own });
      }),
    ),
  );

  it.effect('never failing the command on rules that refuse it', () =>
    provide(
      Effect.gen(function* () {
        for (const keys of [
          [rule('team', { presence: 'optional' })],
          [rule('sessionLink', { pattern: '^nope$', presence: 'optional' })],
        ]) {
          const out = yield* dispatchOpen({
            session: Option.some(SESSION),
            inbox: Option.none(),
            label: Option.some('held'),
            freshId: ID,
            cwd: '/x',
            desktopSession: { link: LINK },
            rules: { extras: 'refuse', keys },
          });
          expect(out).toContain('inbox');
          expect(yield* inboxMeta).toEqual({});
        }
      }),
    ),
  );
});

describe('inbox ask and the link', () => {
  it.effect('writes no link to a Question', () =>
    provide(
      Effect.gen(function* () {
        yield* open({ sessionLink: LINK });
        yield* dispatchAsk({ inboxId: ID, title: 'Which?', body: '- a' });
        const question = yield* dispatchMeta({
          inboxId: ID,
          number: 1,
          set: {},
          unset: [],
          json: true,
        });
        expect(JSON.parse(question)).toEqual({});
      }),
    ),
  );
});

describe('a key’s level at the CLI', () => {
  const levelled = (presence: 'required' | 'expected'): InboxMetadataRules => ({
    extras: 'allow',
    keys: [
      rule('forInbox', { level: 'inbox', presence }),
      rule('forQuestion', { level: 'question', presence }),
    ],
  });
  const setForInbox = { forInbox: 'x' };

  it.effect('a question key neither refuses nor warns on open', () =>
    provide(
      Effect.gen(function* () {
        yield* open({ metadata: setForInbox, rules: levelled('required') });
        expect(yield* said).toEqual([]);
      }),
    ),
  );

  it.effect('an inbox key refuses a new Inbox without it', () =>
    provide(
      Effect.gen(function* () {
        const failed = yield* Effect.flip(
          open({ rules: levelled('required') }),
        );
        expect(failed.message).toContain('forInbox');
        expect(failed.message).not.toContain('forQuestion');
      }),
    ),
  );

  it.effect('an inbox key neither refuses nor warns on ask', () =>
    provide(
      Effect.gen(function* () {
        yield* open();
        const asked = yield* dispatchAsk({
          inboxId: ID,
          title: 'Which?',
          body: '- a',
          metadata: { forQuestion: 'y' },
          rules: levelled('required'),
        });
        expect(asked).toBe('#1');
        yield* dispatchAsk({
          inboxId: ID,
          title: 'And?',
          body: '- a',
          metadata: { forQuestion: 'y' },
          rules: levelled('expected'),
        });
        expect(yield* said).toEqual([]);
      }),
    ),
  );

  it.effect('a question key refuses, then warns, on ask', () =>
    provide(
      Effect.gen(function* () {
        yield* open();
        const failed = yield* Effect.flip(
          dispatchAsk({
            inboxId: ID,
            title: 'Which?',
            body: '- a',
            rules: levelled('required'),
          }),
        );
        expect(failed.message).toContain('forQuestion');
        yield* dispatchAsk({
          inboxId: ID,
          title: 'Which?',
          body: '- a',
          rules: levelled('expected'),
        });
        expect(yield* said).toEqual([expectedKeysWarning(['forQuestion'])]);
      }),
    ),
  );

  it.effect('a key on the Inbox still counts as set for a Question', () =>
    provide(
      Effect.gen(function* () {
        yield* open({ metadata: { forQuestion: 'on the inbox' } });
        const asked = yield* dispatchAsk({
          inboxId: ID,
          title: 'Which?',
          body: '- a',
          rules: levelled('required'),
        });
        expect(asked).toBe('#1');
      }),
    ),
  );

  it.effect('a key at the other level is written, and its type checked', () =>
    provide(
      Effect.gen(function* () {
        const rules: InboxMetadataRules = {
          extras: 'refuse',
          keys: [
            rule('forInbox', {
              level: 'inbox',
              pattern: '^ok$',
              presence: 'optional',
            }),
          ],
        };
        yield* open();
        const asked = yield* dispatchAsk({
          inboxId: ID,
          title: 'Which?',
          body: '- a',
          metadata: { forInbox: 'ok' },
          rules,
        });
        expect(asked).toBe('#1');
        const failed = yield* Effect.flip(
          dispatchAsk({
            inboxId: ID,
            title: 'And?',
            body: '- a',
            metadata: { forInbox: 'bad' },
            rules,
          }),
        );
        expect(failed.message).toContain('forInbox');
      }),
    ),
  );
});

describe('the session’s title', () => {
  const titled = (rules?: InboxMetadataRules) => ({
    sessionLink: LINK,
    sessionTitle: 'Inbox fixes',
    ...(rules === undefined ? {} : { rules }),
  });

  it.effect('joins the link on `open`, and the agent’s own wins', () =>
    provide(
      Effect.gen(function* () {
        yield* open(titled());
        expect((yield* inboxMeta).sessionTitle).toBe('Inbox fixes');
        yield* open({
          ...titled(),
          inbox: Option.some(ID),
          metadata: { sessionTitle: 'Mine' },
        });
        expect((yield* inboxMeta).sessionTitle).toBe('Mine');
      }),
    ),
  );

  it.effect('is left out where the rules would refuse it', () =>
    provide(
      Effect.gen(function* () {
        const rules: InboxMetadataRules = {
          extras: 'refuse',
          keys: [rule('sessionLink', { presence: 'optional' })],
        };
        const out = yield* open(titled(rules));
        expect(out).toContain('(opened)');
        const meta = yield* inboxMeta;
        expect(meta.sessionLink).toBe(LINK);
        expect(meta.sessionTitle).toBeUndefined();
      }),
    ),
  );
});

describe('opening a session link', () => {
  const opener = (body: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'operator-inbox-open-'));
    const bin = path.join(dir, 'open');
    writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return { bin, seen: path.join(dir, 'seen') };
  };
  const opens = (link: string, bin: string) =>
    openSessionLink(link, bin).pipe(Effect.provide(NodeServices.layer));

  it.effect('hands the link to `open`', () =>
    Effect.gen(function* () {
      const { bin, seen } = opener('echo "$1" > "$(dirname "$0")/seen"');
      expect(yield* opens(LINK, bin)).toBe(true);
      expect(readFileSync(seen, 'utf8').trim()).toBe(LINK);
    }),
  );

  it.effect('says so when `open` fails or is not there', () =>
    Effect.gen(function* () {
      expect(yield* opens(LINK, opener('exit 1').bin)).toBe(false);
      expect(yield* opens(LINK, '/nowhere/open')).toBe(false);
    }),
  );
});
