import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { InboxMachinePort } from '@operator-inbox/core';
import {
  inboxMachineKey,
  LOCAL_MACHINE,
  LOCAL_MACHINE_KEY,
  OperatorInboxApi,
  WidgetNotFound,
} from '@operator-inbox/core/api';
import { ConfigProvider, Effect, Layer } from 'effect';
import { FetchHttpClient, HttpServer } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';
import { NetAddress } from 'effect/net';
import { envProvider } from '../src/env-config';
import { InboxLogInMemory } from '../src/inbox-store';
import { makeServeLayer, SERVE_HOST } from '../src/serve-server';

// The widgets group through serve itself, on a real listener on port 0 with
// temp config and state folders: a read, `opened`, a run, and a run of an
// unknown widget or on an unknown machine answered 404. Serve's own spawner
// runs the commands (the listener's layer brings it), so this runs with the
// process tests.

const setUp = () => {
  const xdg = mkdtempSync(path.join(tmpdir(), 'operator-inbox-widgets-route-'));
  const dir = path.join(xdg, 'config', 'operator-inbox');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'widgets.json'),
    JSON.stringify({
      widgets: [
        { label: 'Load', command: 'printf "load output"' },
        { label: 'Disk use', command: 'printf disk', intervalSeconds: 30 },
        { label: 'Too often', command: 'true', intervalSeconds: 2 },
      ],
    }),
  );
  return envProvider({
    XDG_CONFIG_HOME: path.join(xdg, 'config'),
    XDG_STATE_HOME: path.join(xdg, 'state'),
  });
};

const withApi = <A, E>(
  body: (
    api: HttpApiClient.ForApi<typeof OperatorInboxApi>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    if (!NetAddress.isInetAddress(address)) throw new Error('not TCP');
    const api = yield* HttpApiClient.make(OperatorInboxApi, {
      baseUrl: `http://${SERVE_HOST}:${address.port}`,
    }).pipe(Effect.provide(FetchHttpClient.layer));
    return yield* body(api);
  }).pipe(
    Effect.provide(
      makeServeLayer(0, undefined).pipe(
        Layer.provideMerge(Layer.fresh(InboxLogInMemory)),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.provideService(ConfigProvider.ConfigProvider, setUp()),
  );

describe('operator-inbox serve — the widgets routes', () => {
  it.live('read, opened and run answer Local’s widgets', () => {
    return withApi((api) =>
      Effect.gen(function* () {
        const read = yield* api.widgets.read({ query: { watching: 'true' } });
        expect(read.machines).toHaveLength(1);
        const [local] = read.machines;
        expect(local).toMatchObject({
          key: LOCAL_MACHINE_KEY,
          label: LOCAL_MACHINE,
          status: 'local',
          problems: ['widgets.2.intervalSeconds — at least 5'],
        });
        expect(local?.widgets.map((w) => w.id)).toEqual(['load', 'disk-use']);
        yield* Effect.sleep('300 millis');
        const again = yield* api.widgets.read({ query: {} });
        expect(again.machines[0]?.widgets[0]?.lastOk?.stdout).toBe(
          'load output',
        );
        const opened = yield* api.widgets.opened({ query: {} });
        expect(opened.machines[0]?.widgets).toHaveLength(2);
        const before = again.machines[0]?.widgets[0]?.lastRun?.startedAt;
        yield* api.widgets.run({ query: {}, payload: { id: 'load' } });
        yield* Effect.sleep('300 millis');
        const ran = yield* api.widgets.read({ query: {} });
        expect(ran.machines[0]?.widgets[0]?.lastRun?.startedAt).toBeGreaterThan(
          before ?? Number.POSITIVE_INFINITY,
        );
        const onLocal = yield* api.widgets.run({
          query: {},
          payload: { machine: LOCAL_MACHINE_KEY, id: 'load' },
        });
        expect(onLocal.machines[0]?.key).toBe(LOCAL_MACHINE_KEY);
      }),
    );
  });

  it.live(
    'a run of an unknown widget, or on an unknown machine, is a 404',
    () =>
      withApi((api) =>
        Effect.gen(function* () {
          const unknown = yield* Effect.flip(
            api.widgets.run({ query: {}, payload: { id: 'nope' } }),
          );
          expect(unknown).toBeInstanceOf(WidgetNotFound);
          const elsewhere = yield* Effect.flip(
            api.widgets.run({
              query: {},
              payload: {
                machine: inboxMachineKey(InboxMachinePort.make(3999)),
                id: 'load',
              },
            }),
          );
          expect(elsewhere).toBeInstanceOf(WidgetNotFound);
        }),
      ),
  );
});
