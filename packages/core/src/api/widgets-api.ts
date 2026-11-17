import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { WidgetFormat, WidgetId } from '../widgets';
import {
  InboxMachineKey,
  InboxMachineReason,
  InboxMachineRef,
  InboxReadQuery,
  IncompatibleMachineStatusDto,
  LocalMachineStatusDto,
  ReachableMachineStatusDto,
  UnreachableMachineStatusDto,
} from './inbox-api';

// The sidebar's widgets (`widgets.json`, core's `widgets.ts`). Serve runs each
// widget's command on its own timer and keeps its runs in memory, with the
// last good one cached on disk; runs are never events. The page reads every
// machine's widgets in one snapshot, tells serve when the sidebar opens, and
// asks for a widget to run now. Every endpoint answers the same snapshot.
//
// Times are epoch milliseconds on the clock of the machine that ran the
// widget; each machine's `now` is that clock when it answered, so the page
// reckons an age against it and never against its own.

// One finished run of a widget's command.
// - `exitCode` is null when the process ended on a signal (`signal`) or never
//   started (`spawnError`, why it could not).
// - `timedOut`: serve ended it after `timeoutSeconds`.
// - `stdout` is the output as the page reads it, cut at serve's cap
//   (`truncated`); for a templated `json` widget, the envelope the templates
//   made, with the command's own output in `raw`. `templateError` is why the
//   templates could not fill it, which fails the run.
// - `stderrTail` is the last line the command wrote to stderr, or empty.
// - `ok`: exit 0, in time, started, and its templates filled.
export const WidgetRunDto = Schema.Struct({
  startedAt: Schema.Finite,
  finishedAt: Schema.Finite,
  durationMs: Schema.Finite,
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  spawnError: Schema.NullOr(Schema.String),
  stdout: Schema.String,
  stderrTail: Schema.String,
  truncated: Schema.Boolean,
  ok: Schema.Boolean,
  templateError: Schema.optionalKey(Schema.String),
  raw: Schema.optionalKey(Schema.String),
});
export type WidgetRunDto = typeof WidgetRunDto.Type;

// One widget as serve runs it: its config with the defaults filled in, and
// where it stands. `runningSince` is set while it runs; `refreshQueued` is a
// run asked for while one ran, which starts when it ends. `lastRun` is the
// latest run, good or not, and `lastOk` the latest good one (from the cache on
// disk after a restart, so a chip is not blank). `nextRunAt` is when the next
// scheduled run starts, null while it runs or while its runs are paused (no
// open sidebar is reading).
export const WidgetDto = Schema.Struct({
  id: WidgetId,
  label: Schema.String,
  format: WidgetFormat,
  lines: Schema.Int,
  intervalSeconds: Schema.Finite,
  timeoutSeconds: Schema.Finite,
  running: Schema.Boolean,
  runningSince: Schema.NullOr(Schema.Finite),
  refreshQueued: Schema.Boolean,
  lastRun: Schema.NullOr(WidgetRunDto),
  lastOk: Schema.NullOr(WidgetRunDto),
  nextRunAt: Schema.NullOr(Schema.Finite),
});
export type WidgetDto = typeof WidgetDto.Type;

// A machine's state in the board's words (`InboxMachineStatusDto`'s
// `status`), taken from its schemas so the two never drift, without its Inbox
// counts, which a widget section has no use for.
export const WidgetsMachineStatus = Schema.Literals(
  [
    LocalMachineStatusDto,
    ReachableMachineStatusDto,
    UnreachableMachineStatusDto,
    IncompatibleMachineStatusDto,
  ].map((m) => m.fields.status.literal),
);
export type WidgetsMachineStatus = typeof WidgetsMachineStatus.Type;

// One machine's widgets, Local first, then each Inbox machine in the
// configured order, keyed as the board keys its sections. A machine that is
// `unreachable` or `incompatible` sends no widgets: the page keeps the last
// ones it had, greyed. `reason` and `detail` are why, as the board's machine
// says them. `problems` are the entries of its `widgets.json` that cannot run,
// or why the file cannot be read at all, one sentence each.
export const WidgetsMachineDto = Schema.Struct({
  key: InboxMachineKey,
  label: Schema.String,
  status: WidgetsMachineStatus,
  reason: Schema.optionalKey(InboxMachineReason),
  detail: Schema.optionalKey(Schema.String),
  widgets: Schema.Array(WidgetDto),
  problems: Schema.Array(Schema.String),
  now: Schema.Finite,
});
export type WidgetsMachineDto = typeof WidgetsMachineDto.Type;

// Every machine's widgets. Asked with `local=true` (as Local's serve asks an
// Inbox machine), a serve answers its own alone: one machine, with Local's
// key, which the asking serve rekeys as that machine.
export const WidgetsDto = Schema.Struct({
  machines: Schema.Array(WidgetsMachineDto),
});
export type WidgetsDto = typeof WidgetsDto.Type;

// The read's query: `local` as every inbox endpoint takes it
// (`InboxReadQuery`), and `watching=true` when the read is the open sidebar's,
// the only read that keeps scheduled runs going.
export const WidgetsReadQuery = Schema.Struct({
  local: InboxReadQuery.fields.local,
  watching: Schema.optionalKey(Schema.Literal('true')),
});
export type WidgetsReadQuery = typeof WidgetsReadQuery.Type;

// Run one widget now: on Local, or, with `machine`, on that Inbox machine,
// which Local forwards it to.
export const WidgetRunPayload = Schema.Struct({
  machine: Schema.optionalKey(InboxMachineKey),
  id: WidgetId,
});
export type WidgetRunPayload = typeof WidgetRunPayload.Type;

// No widget has that id on that machine, or no machine has that key.
export class WidgetNotFound extends Schema.Error<WidgetNotFound>(
  'WidgetNotFound',
)(
  { message: Schema.String, _tag: Schema.tag('WidgetNotFound') },
  { httpApiStatus: 404 },
) {}

// A run Local forwarded to an Inbox machine (`machine`) reached no answer it
// can use: the machine could not be reached, or answered with what the
// contract cannot read. `message` says which, naming the machine. The run may
// have started there all the same when the machine took the request and gave
// no answer in time.
export class WidgetsUnavailable extends Schema.Error<WidgetsUnavailable>(
  'WidgetsUnavailable',
)(
  {
    message: Schema.String,
    machine: InboxMachineRef,
    _tag: Schema.tag('WidgetsUnavailable'),
  },
  { httpApiStatus: 503 },
) {}

export class WidgetsApiGroup extends HttpApiGroup.make('widgets').add(
  HttpApiEndpoint.get('read', '/widgets', {
    query: WidgetsReadQuery,
    success: WidgetsDto,
  }),
  // The sidebar opened: run every widget but one running or run in the last
  // few seconds, and count the sidebar as watching.
  HttpApiEndpoint.post('opened', '/widgets/opened', {
    query: InboxReadQuery,
    success: WidgetsDto,
  }),
  // `local`, so a run Local forwards to a machine is answered with that
  // machine's widgets alone.
  HttpApiEndpoint.post('run', '/widgets/run', {
    query: InboxReadQuery,
    payload: WidgetRunPayload,
    success: WidgetsDto,
    error: [WidgetNotFound, WidgetsUnavailable],
  }),
) {}
