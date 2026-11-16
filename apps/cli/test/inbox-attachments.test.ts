import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import {
  type Attachment,
  InboxId,
  QuestionNumber,
  QuestionRevision,
  SessionId,
} from '@operator-inbox/core';
import {
  AnswerRefused,
  AskRefused,
  InboxNotFound,
  OperatorInboxApi,
} from '@operator-inbox/core/api';
import { ConfigProvider, Effect, Layer, Option, Ref } from 'effect';
import { FetchHttpClient, type HttpClient, HttpServer } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';
import {
  dispatchAnswers,
  dispatchAsk,
  dispatchOpen,
} from '../src/commands/inbox';
import { envProvider } from '../src/env-config';
import { AttachmentsRoot, planAttachments } from '../src/inbox-attachments';
import { InboxLog, InboxLogInMemory } from '../src/inbox-store';
import { answerQuestion } from '../src/serve-inbox-api';
import { makeServeLayer } from '../src/serve-server';

// Files on an answer, through serve itself, on a real listener on port 0.
// The page sends each file whole in the answer's (or the ask's) own request;
// the server keeps it under `<store folder>/attachments/<inbox>/<hash>/` and
// appends an event carrying its path. `answers` prints the paths, and
// `/api/attachments/…` reads an image back. The state and config folders
// are temp dirs per test.

const ID = InboxId.make('01INBOXATTACHSERVEAAAAAAAA');
const OTHER = InboxId.make('01INBOXATTACHNOWHEREAAAAAA');
const n = QuestionNumber.make;
const r = QuestionRevision.make;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const LOG = Buffer.from('error: it broke\n', 'utf8');
const upload = (name: string, type: string, bytes: Buffer) => ({
  name,
  type,
  data: bytes.toString('base64'),
});

const open = dispatchOpen({
  session: Option.some({ sessionId: SessionId.make('s'), cwd: '/w/app' }),
  inbox: Option.none(),
  label: Option.some('app'),
  freshId: ID,
  cwd: '/w',
});

interface Got {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

const get = (port: number, target: string) =>
  Effect.callback<Got, Error>((resume) => {
    const req = request(
      { hostname: '127.0.0.1', port, path: target },
      (res) => {
        const chunks: Array<Buffer> = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resume(
            Effect.succeed({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          ),
        );
      },
    );
    req.on('error', (e) => resume(Effect.fail(e)));
    req.end();
  });

const serving = Layer.mergeAll(
  makeServeLayer(0, undefined),
  FetchHttpClient.layer,
).pipe(
  Layer.provideMerge(Layer.fresh(InboxLogInMemory)),
  Layer.provideMerge(NodeServices.layer),
);

// The folder the files go in, as the default root finds it: beside the
// store, which is under `XDG_STATE_HOME`.
const run = <A, E>(
  body: (
    port: number,
    root: string,
  ) => Effect.Effect<
    A,
    E,
    HttpServer.HttpServer | HttpClient.HttpClient | InboxLog
  >,
) => {
  const state = mkdtempSync(path.join(tmpdir(), 'operator-inbox-attach-'));
  const root = path.join(state, 'operator-inbox', 'attachments');
  return Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    const port = 'port' in address ? address.port : 0;
    return yield* body(port, root);
  }).pipe(
    Effect.provide(serving),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      envProvider({
        XDG_STATE_HOME: state,
        XDG_CONFIG_HOME: mkdtempSync(
          path.join(tmpdir(), 'operator-inbox-attach-xdg-'),
        ),
      }),
    ),
  );
};

const clientOf = (port: number) =>
  HttpApiClient.make(OperatorInboxApi, { baseUrl: `http://127.0.0.1:${port}` });

const ask = dispatchAsk({ inboxId: ID, title: 'Why?', body: 'Tell me.' });

const filesUnder = (root: string): ReadonlyArray<string> =>
  existsSync(root)
    ? readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => path.join(d.parentPath, d.name))
    : [];

describe('planAttachments (pure past the root)', () => {
  it('keeps each file under its hash, with a safe name', () => {
    const planned = planAttachments('/root', ID, [
      upload('../../shot.png', 'IMAGE/PNG', PNG),
    ]);
    if (planned._tag === 'Failure') throw new Error(planned.failure);
    const [one] = planned.success;
    expect(one?.attachment.name).toBe('shot.png');
    expect(one?.attachment.type).toBe('image/png');
    expect(one?.attachment.bytes).toBe(PNG.byteLength);
    expect(one?.attachment.path).toMatch(
      new RegExp(`^/root/${ID}/[0-9a-f]{16}/shot\\.png$`),
    );
  });

  it('refuses data that is not base64, and an Inbox id that is no folder', () => {
    expect(
      planAttachments('/root', ID, [
        { name: 'a.txt', type: '', data: 'not base64!' },
      ])._tag,
    ).toBe('Failure');
    expect(
      planAttachments('/root', InboxId.make('../escape'), [
        upload('a.txt', '', LOG),
      ])._tag,
    ).toBe('Failure');
  });
});

describe('serve: files on an answer', () => {
  it.effect(
    'keeps each file, names it on the answer, and `answers` prints its path',
    () =>
      run((port, root) =>
        Effect.gen(function* () {
          yield* open;
          yield* ask;
          const client = yield* clientOf(port);
          const view = yield* client.inbox.answer({
            query: {},
            params: { inboxId: ID, number: n(1) },
            payload: {
              response: '',
              seenRevision: r(1),
              attachments: [
                upload('screenshot.png', 'image/png', PNG),
                upload('build.log', 'text/plain', LOG),
              ],
            },
          });
          const answered = view.awaitingAgent[0];
          const files = answered?.attachments ?? [];
          expect(files.map((f) => [f.name, f.type, f.bytes])).toStrictEqual([
            ['screenshot.png', 'image/png', PNG.byteLength],
            ['build.log', 'text/plain', LOG.byteLength],
          ]);
          for (const f of files)
            expect(f.path.startsWith(`${root}/`)).toBe(true);
          expect(readFileSync(files[0]?.path ?? '')).toStrictEqual(PNG);
          expect(readFileSync(files[1]?.path ?? '', 'utf8')).toBe(
            LOG.toString('utf8'),
          );

          const text = yield* dispatchAnswers({ inboxId: ID, json: false });
          expect(text).toContain('ATTACHED FILES (2); read each at its path:');
          expect(text).toContain(
            `- ${files[0]?.path} (image/png, ${PNG.byteLength} B)`,
          );
          expect(text).toContain(`- ${files[1]?.path} (text/plain, 16 B)`);
          const json = JSON.parse(
            yield* dispatchAnswers({ inboxId: ID, json: true }),
          ) as ReadonlyArray<{
            readonly attachments?: ReadonlyArray<Attachment>;
          }>;
          expect(json[0]?.attachments).toStrictEqual(files);
        }),
      ),
  );

  it.effect(
    'a follow-up keeps its files on the question it asks, and `answers` lists them',
    () =>
      run((port, root) =>
        Effect.gen(function* () {
          yield* open;
          const client = yield* clientOf(port);
          const view = yield* client.inbox.ask({
            query: {},
            params: { inboxId: ID },
            payload: {
              text: 'Look at this.\n\nFollow-up to #1: /inbox/x/1',
              attachments: [upload('trace.log', 'text/plain', LOG)],
            },
          });
          const asked = view.awaitingAgent.find(
            (q) => q.operatorQuestion === true,
          );
          const [file] = asked?.attachments ?? [];
          expect(file?.path.startsWith(`${root}/${ID}/`)).toBe(true);
          expect(existsSync(file?.path ?? '')).toBe(true);
          const text = yield* dispatchAnswers({ inboxId: ID, json: false });
          expect(text).toContain('(the operator asks) Look at this.');
          expect(text).toContain(`- ${file?.path} (text/plain, 16 B)`);
        }),
      ),
  );

  it.effect(
    'reads an image back as itself, and anything else as a download',
    () =>
      run((port) =>
        Effect.gen(function* () {
          yield* open;
          yield* ask;
          const client = yield* clientOf(port);
          const view = yield* client.inbox.answer({
            query: {},
            params: { inboxId: ID, number: n(1) },
            payload: {
              response: 'See',
              seenRevision: r(1),
              attachments: [
                upload('shot.png', 'image/png', PNG),
                upload(
                  'page.html',
                  'text/html',
                  Buffer.from('<script>x</script>'),
                ),
              ],
            },
          });
          const [shot, page] = view.awaitingAgent[0]?.attachments ?? [];
          const urlOf = (a: Attachment | undefined) =>
            `/api/attachments/${(a?.path ?? '').split('/').slice(-3).map(encodeURIComponent).join('/')}`;
          const image = yield* get(port, urlOf(shot));
          expect(image.status).toBe(200);
          expect(image.headers['content-type']).toBe('image/png');
          expect(image.headers['content-disposition']).toMatch(/^inline;/);
          expect(image.headers['x-content-type-options']).toBe('nosniff');
          expect(image.body).toStrictEqual(PNG);
          const other = yield* get(port, urlOf(page));
          expect(other.status).toBe(200);
          expect(other.headers['content-type']).toBe(
            'application/octet-stream',
          );
          expect(other.headers['content-disposition']).toMatch(/^attachment;/);
          expect(
            (yield* get(port, '/api/attachments/x/y/missing.png')).status,
          ).toBe(404);
          expect(
            (yield* get(port, `/api/attachments/${ID}/..%2F..%2F/inbox.sqlite`))
              .status,
          ).toBe(404);
        }),
      ),
  );

  it.effect(
    'a refused answer, or one for an Inbox not here, writes no file',
    () =>
      run((port, root) =>
        Effect.gen(function* () {
          yield* open;
          yield* ask;
          const client = yield* clientOf(port);
          const files = [upload('shot.png', 'image/png', PNG)];
          yield* client.inbox.answer({
            query: {},
            params: { inboxId: ID, number: n(1) },
            payload: { response: 'Yes', seenRevision: r(1) },
          });
          const again = yield* client.inbox
            .answer({
              query: {},
              params: { inboxId: ID, number: n(1) },
              payload: {
                response: 'Again',
                seenRevision: r(1),
                attachments: files,
              },
            })
            .pipe(Effect.flip);
          expect(again).toBeInstanceOf(AnswerRefused);
          const nowhere = yield* client.inbox
            .answer({
              query: {},
              params: { inboxId: OTHER, number: n(1) },
              payload: {
                response: 'Yes',
                seenRevision: r(1),
                attachments: files,
              },
            })
            .pipe(Effect.flip);
          expect(nowhere).toBeInstanceOf(InboxNotFound);
          const broken = yield* client.inbox
            .ask({
              query: {},
              params: { inboxId: ID },
              payload: {
                text: 'Look',
                attachments: [
                  { name: 'a.png', type: 'image/png', data: '%%%' },
                ],
              },
            })
            .pipe(Effect.flip);
          expect(broken).toBeInstanceOf(AskRefused);
          expect(filesUnder(root)).toStrictEqual([]);
        }),
      ),
  );
});

describe('the file is kept before the answer is appended', () => {
  it.effect('so a failed append leaves only the file', () =>
    Effect.gen(function* () {
      const root = mkdtempSync(
        path.join(tmpdir(), 'operator-inbox-attach-order-'),
      );
      const seen = yield* Ref.make<ReadonlyArray<boolean>>([]);
      const watching = Layer.effect(
        InboxLog,
        Effect.map(InboxLog, (base) =>
          InboxLog.of({
            ...base,
            append: (events, guard) =>
              Effect.andThen(
                Ref.update(seen, (s) => [
                  ...s,
                  ...events
                    .filter((e) => e._tag === 'QuestionAnswered')
                    .map(() => filesUnder(root).length === 1),
                ]),
                base.append(events, guard),
              ),
          }),
        ),
      ).pipe(Layer.provide(InboxLogInMemory));
      yield* Effect.gen(function* () {
        yield* open;
        yield* ask;
        yield* answerQuestion(
          ID,
          n(1),
          '',
          r(1),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          [upload('shot.png', 'image/png', PNG)],
        );
      }).pipe(
        Effect.provide(watching),
        Effect.provideService(AttachmentsRoot, {
          root: Effect.succeed(root),
        }),
      );
      expect(yield* Ref.get(seen)).toStrictEqual([true]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
