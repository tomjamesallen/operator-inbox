import {
  type InboxMachineName,
  type MachineRead,
  machineText,
  unresolvedRead,
} from '@operator-inbox/core';
import {
  type InboxMachineKey,
  type InboxReadQuery,
  LOCAL_MACHINE,
  LOCAL_MACHINE_KEY,
  type OperatorInboxApi,
  WidgetNotFound,
  type WidgetRunPayload,
  type WidgetsDto,
  type WidgetsMachineDto,
  WidgetsUnavailable,
} from '@operator-inbox/core/api';
import { Effect, Result } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import {
  fetchMachineWidgets,
  forwardWidgetRun,
  type MachineWidgetsAsk,
} from './inbox-machine-client';
import { ServedInboxMachines } from './serve-inbox-machines';
import { type LocalWidgets, WidgetRunner } from './serve-widgets';

// The widgets group's handlers. Each answers every machine's widgets in one
// snapshot (`WidgetsDto`): Local's, from this serve's runner
// (`serve-widgets.ts`), then each Inbox machine's, in the configured order,
// read from that machine with `local=true` as the board reads its sections
// and at the same time as Local's own. A read from Local's serve
// (`local=true`, this serve asked as an Inbox machine) answers this
// machine's alone: Local merges one level, and a call never travels on.
//
// A machine's read is `watching` only when the read Local answers is, so a
// machine runs its widgets only while some page is looking at them; `opened`
// is sent on to every machine, so opening the sidebar runs every machine's
// widgets. A run of another machine's widget is forwarded to it by its id
// alone: the command is always the machine's own.

// Local's section, named and keyed as the board names Local.
const localMachine = (local: LocalWidgets): WidgetsMachineDto => ({
  key: LOCAL_MACHINE_KEY,
  label: LOCAL_MACHINE,
  status: 'local',
  widgets: local.widgets,
  problems: local.problems,
  now: local.now,
});

// One Inbox machine's section, keyed and labelled as the board keys and
// labels it. The machine answered its own widgets under Local's key: they
// are rekeyed as that machine's, its problems passed through `machineText`
// as every machine's words are. A serve with no widgets endpoint answered
// none (`fetchMachineWidgets`), so it is reachable with no widgets. A machine
// not read gives why, with no widgets: the page keeps the last it had,
// greyed, and `now` is Local's clock, the machine's being unknown.
const machineSection = (
  name: Pick<InboxMachineName, 'key' | 'label'>,
  read: MachineRead<WidgetsDto>,
  localNow: number,
): WidgetsMachineDto => {
  const named = { key: name.key, label: name.label };
  if (read.status !== 'reachable')
    return {
      ...named,
      status: read.status,
      reason: read.reason,
      detail: read.detail,
      widgets: [],
      problems: [],
      now: localNow,
    };
  const own = read.value.machines.find((m) => m.key === LOCAL_MACHINE_KEY);
  return {
    ...named,
    status: 'reachable',
    widgets: own?.widgets ?? [],
    problems: (own?.problems ?? []).map(machineText),
    now: own?.now ?? localNow,
  };
};

// A machine's widgets already in hand (a forwarded run's answer), so it is
// not read again for the same snapshot.
interface Answered {
  readonly key: InboxMachineKey;
  readonly widgets: WidgetsDto;
}

// Every Inbox machine's read, in the configured order and all at once, as
// `readMachines` reads the board's: an entry that names no usable Herdr
// machine is never called and says why.
const readMachineWidgets = (ask: MachineWidgetsAsk, answered?: Answered) =>
  Effect.gen(function* () {
    const served = yield* ServedInboxMachines;
    const { entries } = yield* served.machines;
    return yield* Effect.forEach(
      entries,
      ({ resolved, ...name }) =>
        (answered?.key === name.key
          ? Effect.succeed<MachineRead<WidgetsDto>>({
              status: 'reachable',
              value: answered.widgets,
            })
          : Result.isSuccess(resolved)
            ? fetchMachineWidgets(name.port, ask, served.callOptions)
            : Effect.succeed(unresolvedRead(resolved.failure))
        ).pipe(Effect.map((read) => ({ name, read }))),
      { concurrency: 'unbounded' },
    );
  });

// The answer to a read: Local's widgets, then, unless asked `local=true`,
// each Inbox machine's, Local's and the machines' read at the same time.
const widgetsOf = (
  local: Effect.Effect<LocalWidgets>,
  query: InboxReadQuery,
  ask: MachineWidgetsAsk,
  answered?: Answered,
): Effect.Effect<WidgetsDto> =>
  query.local === 'true'
    ? Effect.map(local, (own) => ({ machines: [localMachine(own)] }))
    : Effect.map(
        Effect.all([local, readMachineWidgets(ask, answered)], {
          concurrency: 'unbounded',
        }),
        ([own, machines]) => ({
          machines: [
            localMachine(own),
            ...machines.map(({ name, read }) =>
              machineSection(name, read, own.now),
            ),
          ],
        }),
      );

// A run on a machine other than Local: forwarded to the Inbox machine with
// that key, then answered as a read is, with that machine's section from the
// run's own answer. An Inbox machine asked by Local (`local=true`) never
// forwards: a run with a machine's key is not one it has.
const runElsewhere = (
  local: Effect.Effect<LocalWidgets>,
  payload: WidgetRunPayload & { readonly machine: InboxMachineKey },
  query: InboxReadQuery,
) =>
  Effect.gen(function* () {
    const noMachine = new WidgetNotFound({
      message: `No Inbox machine has the key ${payload.machine}, so it has no widget ${payload.id}.`,
    });
    if (query.local === 'true') return yield* Effect.fail(noMachine);
    const served = yield* ServedInboxMachines;
    const { entries } = yield* served.machines;
    const machine = entries.find((m) => m.key === payload.machine);
    if (machine === undefined) return yield* Effect.fail(noMachine);
    if (Result.isFailure(machine.resolved))
      return yield* Effect.fail(
        new WidgetsUnavailable({
          message: `the Inbox machine ${machine.label} could not be reached: ${machine.resolved.failure.reason}`,
          machine: { key: machine.key, label: machine.label },
        }),
      );
    const widgets = yield* forwardWidgetRun(
      machine,
      payload.id,
      served.callOptions,
      served.keepWrite,
    );
    return yield* widgetsOf(local, query, 'read', {
      key: machine.key,
      widgets,
    });
  });

export const makeWidgetsApiLive = (api: typeof OperatorInboxApi) =>
  HttpApiBuilder.group(api, 'widgets', (handlers) =>
    Effect.gen(function* () {
      const runner = yield* WidgetRunner;
      return handlers
        .handle('read', ({ query }) => {
          const watching = query.watching === 'true';
          return widgetsOf(
            runner.read({ watching }),
            query,
            watching ? 'watching' : 'read',
          );
        })
        .handle('opened', ({ query }) =>
          widgetsOf(runner.opened, query, 'opened'),
        )
        .handle('run', ({ query, payload }) => {
          const { machine } = payload;
          return machine !== undefined && machine !== LOCAL_MACHINE_KEY
            ? runElsewhere(
                runner.read({ watching: false }),
                { ...payload, machine },
                query,
              )
            : Effect.flatMap(runner.run(payload.id), (own) =>
                widgetsOf(Effect.succeed(own), query, 'read'),
              );
        });
    }),
  );
