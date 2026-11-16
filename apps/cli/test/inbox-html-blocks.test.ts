import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import {
  HTML_BLOCK_MAX_BYTES,
  InboxId,
  inboxStateStamped,
  QuestionNumber,
  SessionId,
} from '@operator-inbox/core';
import { Effect, Layer, Option, Ref } from 'effect';
import {
  dispatchAsk,
  dispatchEdit,
  dispatchOpen,
  htmlBlocksOf,
} from '../src/commands/inbox';
import { sha256Hex } from '../src/inbox-blobs';
import {
  connectInboxLog,
  InboxLog,
  InboxLogInMemory,
} from '../src/inbox-store';
import { questionHtmlBlocks, toInboxView } from '../src/serve-inbox-api';

// HTML blocks through the CLI: `ask --html` and `edit --html` read and check
// each document, keep it in the blob table BEFORE the event that names it is
// appended, and the event carries its hash and size only. The page reads the
// documents through `htmlBlocks`, never through the board.

const ID = InboxId.make('01INBOXHTMLAAAAAAAAAAAAAAA');

const open = dispatchOpen({
  session: Option.some({ sessionId: SessionId.make('s'), cwd: '/w/app' }),
  inbox: Option.none(),
  label: Option.some('app'),
  freshId: ID,
  cwd: '/w',
});

const CHART =
  '<!doctype html><title>Two runs</title><meta name="oi-block" content="height=320"><svg></svg>';
const SCENE = '<canvas></canvas><script type="module">import "three";</script>';

const dir = mkdtempSync(path.join(tmpdir(), 'oi-html-blocks-'));
const file = (name: string, content: string | Uint8Array) => {
  const p = path.join(dir, name);
  writeFileSync(p, content);
  return p;
};

describe('reading --html files', () => {
  it.effect('reads a document with its hash and size', () =>
    Effect.gen(function* () {
      const read = yield* htmlBlocksOf(
        'ask',
        Option.some({ chart: file('chart.html', CHART) }),
      );
      const bytes = new TextEncoder().encode(CHART);
      expect(read?.chart?.sha).toBe(sha256Hex(bytes));
      expect(read?.chart?.bytes).toBe(bytes.byteLength);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('refuses a document over the 512 KiB cap', () =>
    Effect.gen(function* () {
      const big = file(
        'big.html',
        `<p>${'x'.repeat(HTML_BLOCK_MAX_BYTES)}</p>`,
      );
      const error = yield* Effect.flip(
        htmlBlocksOf('ask', Option.some({ big })),
      );
      expect(error.message).toContain('at most 512 KiB');
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    'refuses a document that is not UTF-8, and one whose meta does not parse',
    () =>
      Effect.gen(function* () {
        const latin = file(
          'latin.html',
          new Uint8Array([0x3c, 0x70, 0x3e, 0xe9, 0xff]),
        );
        expect(
          (yield* Effect.flip(htmlBlocksOf('ask', Option.some({ latin }))))
            .message,
        ).toContain('not UTF-8');
        const meta = file(
          'meta.html',
          '<meta name="oi-block" content="depth=3"><p>x</p>',
        );
        expect(
          (yield* Effect.flip(htmlBlocksOf('ask', Option.some({ meta }))))
            .message,
        ).toContain('oi-block');
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe('asking and editing with HTML blocks', () => {
  const encode = (s: string) => new TextEncoder().encode(s);
  const input = (doc: string) => {
    const bytes = encode(doc);
    return { sha: sha256Hex(bytes), bytes: bytes.byteLength, doc: bytes };
  };

  it.effect(
    'keeps the blob first, then appends an event carrying only its hash',
    () =>
      Effect.gen(function* () {
        // A log that records the order of blob writes and appends.
        const order = yield* Ref.make<ReadonlyArray<string>>([]);
        const recording = Layer.effect(
          InboxLog,
          Effect.map(InboxLog, (base) =>
            InboxLog.of({
              ...base,
              putBlob: (blob) =>
                Effect.andThen(
                  Ref.update(order, (o) => [
                    ...o,
                    `blob ${blob.sha.slice(0, 6)}`,
                  ]),
                  base.putBlob(blob),
                ),
              append: (events, guard) =>
                Effect.andThen(
                  Ref.update(order, (o) => [
                    ...o,
                    ...events.map((e) => `event ${e._tag}`),
                  ]),
                  base.append(events, guard),
                ),
            }),
          ),
        ).pipe(Layer.provide(InboxLogInMemory));
        const chart = input(CHART);
        yield* Effect.gen(function* () {
          yield* open;
          yield* Ref.set(order, []);
          yield* dispatchAsk({
            inboxId: ID,
            title: 'Which run?',
            body: '<Html id="chart"/>',
            htmls: { chart },
          });
          const log = yield* InboxLog;
          const { events } = yield* log.read(ID);
          const asked = events.find((e) => e._tag === 'QuestionAsked');
          expect(asked).toMatchObject({
            htmls: { chart: { sha: chart.sha, bytes: chart.bytes } },
          });
          expect(JSON.stringify(asked)).not.toContain('Two runs');
        }).pipe(Effect.provide(recording));
        const seen = yield* Ref.get(order);
        expect(seen[0]).toBe(`blob ${chart.sha.slice(0, 6)}`);
        expect(seen).toContain('event QuestionAsked');
      }),
  );

  it.effect(
    'serves the documents per Question, and the view carries the hashes alone',
    () =>
      Effect.gen(function* () {
        yield* open;
        const chart = input(CHART);
        const scene = input(SCENE);
        yield* dispatchAsk({
          inboxId: ID,
          title: 'Which run?',
          body: '<Html id="chart"/>',
          htmls: { chart },
        });
        const first = yield* questionHtmlBlocks(ID, QuestionNumber.make(1));
        expect(first).toStrictEqual({
          blocks: { chart: { sha: chart.sha, doc: CHART } },
        });
        // An edit adds a block by id and keeps the other.
        yield* dispatchEdit({ inboxId: ID, number: 1, htmls: { scene } });
        const after = yield* questionHtmlBlocks(ID, QuestionNumber.make(1));
        expect(Object.keys(after.blocks).sort()).toEqual(['chart', 'scene']);
        expect(after.blocks.scene?.doc).toBe(SCENE);
        const log = yield* InboxLog;
        const { stamped } = yield* log.read(ID);
        const view = toInboxView(ID, inboxStateStamped(stamped));
        expect(view.awaitingOperator[0]?.htmls).toStrictEqual({
          chart: { sha: chart.sha, bytes: chart.bytes },
          scene: { sha: scene.sha, bytes: scene.bytes },
        });
        expect(JSON.stringify(view)).not.toContain('<svg>');
        // A Question with no such number has none.
        expect(
          yield* questionHtmlBlocks(ID, QuestionNumber.make(9)),
        ).toStrictEqual({ blocks: {} });
      }).pipe(Effect.provide(InboxLogInMemory)),
  );

  it.effect('leaves a refused ask its blob, and appends nothing', () =>
    Effect.gen(function* () {
      yield* open;
      const chart = input(CHART);
      const error = yield* Effect.flip(
        dispatchAsk({ inboxId: ID, title: ' ', body: '', htmls: { chart } }),
      );
      expect(error.message).toContain('title');
      const log = yield* InboxLog;
      expect((yield* log.readBlobs([chart.sha])).has(chart.sha)).toBe(true);
      const { events } = yield* log.read(ID);
      expect(events.some((e) => e._tag === 'QuestionAsked')).toBe(false);
    }).pipe(Effect.provide(InboxLogInMemory)),
  );
});

describe('the blob table on disk', () => {
  it.effect(
    'keeps a blob once under its hash, and reads it back as bytes',
    () =>
      Effect.gen(function* () {
        const file = path.join(
          mkdtempSync(path.join(tmpdir(), 'oi-blobs-')),
          'inbox.sqlite',
        );
        const doc = new TextEncoder().encode(CHART);
        const blob = {
          sha: sha256Hex(doc),
          kind: 'html',
          bytes: doc.byteLength,
          doc,
        };
        const kept = yield* Effect.gen(function* () {
          const log = yield* InboxLog;
          yield* log.putBlob(blob);
          // The same document again is the same row: never an update.
          yield* log.putBlob({ ...blob, kind: 'other' });
          return yield* log.readBlobs([blob.sha, 'f'.repeat(64)]);
        }).pipe(
          Effect.provide(connectInboxLog({ source: 'env', path: file })),
          Effect.scoped,
        );
        expect([...kept.keys()]).toEqual([blob.sha]);
        expect(kept.get(blob.sha)?.kind).toBe('html');
        expect(new TextDecoder().decode(kept.get(blob.sha)?.doc)).toBe(CHART);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
