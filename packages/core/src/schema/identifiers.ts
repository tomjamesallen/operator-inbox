import { Schema } from 'effect';

// Branded identifiers: nominal types, so an InboxId can never be passed where
// a SessionId is expected. Construct one with `InboxId.make(str)`; a fresh
// ulid comes from `newId()` (`src/ids.ts`) at the CLI edge.

// A session's question Inbox (`inbox.ts`). A ulid from `newId` at the CLI
// edge. An Inbox lives in the machine-local inbox log.
export const InboxId = Schema.String.pipe(Schema.brand('InboxId'));
export type InboxId = typeof InboxId.Type;

// Which machine an Inbox, a sidebar section or an owner record belongs to in
// the combined inbox: `local` for Local, and an Inbox machine's tunnel port in
// decimal for each Inbox machine. The display label is not an identity (Herdr
// labels can change and repeat); the port is unique in `inboxMachines` and
// never serve's own, and every configured machine has one, a machine that
// names no usable Herdr profile included. Built with `LOCAL_MACHINE_KEY` and
// `inboxMachineKey` (`api/inbox-api.ts`).
export const InboxMachineKey = Schema.String.pipe(
  Schema.brand('InboxMachineKey'),
);
export type InboxMachineKey = typeof InboxMachineKey.Type;

// The local port an Inbox machine's SSH tunnel listens on, as `config.json`'s
// `inboxMachines` gives it: what Local's serve calls to reach the machine, and
// what its `InboxMachineKey` is made from. Branded so a port read from config
// can never be confused with serve's own `--port` or any other number; a
// config decode brands it, and a test builds one with
// `InboxMachinePort.make(...)`.
export const InboxMachinePort = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65535 }),
).pipe(Schema.brand('InboxMachinePort'));
export type InboxMachinePort = typeof InboxMachinePort.Type;

// A Claude Code session id (a uuid, as the session file writes it). Branded
// because it is PERSISTED: an Inbox records the session that opened it, and no
// identifier crosses a boundary as a bare `Schema.String`.
//
// Deliberately NOT pattern-refined against a uuid regex: the id is issued by
// the harness and read back verbatim, and an app that rejected a future id
// format would refuse to record a session rather than degrade.
export const SessionId = Schema.String.pipe(Schema.brand('SessionId'));
export type SessionId = typeof SessionId.Type;

// The Claude desktop app's own id for a session, `local_<uuid>`, beside the CLI
// session id above. Unrefined for the same reason; what may become a link is
// checked where the link is built (`inbox-metadata.ts`).
export const DesktopSessionId = Schema.String.pipe(
  Schema.brand('DesktopSessionId'),
);
export type DesktopSessionId = typeof DesktopSessionId.Type;

// One prompt within a Claude Code session, as the hooks' stdin carries it
// (`prompt_id`). Inbox mode's pause holds one (`inbox-mode.ts`): the operator
// typed that prompt, so the reply to it may ask inline. Unrefined for the same
// reason as `SessionId`: the harness issues it and the app only compares it.
export const PromptId = Schema.String.pipe(Schema.brand('PromptId'));
export type PromptId = typeof PromptId.Type;

// A saved SSH machine's profile id (`herdr machine list --json`): opaque,
// issued by Herdr and handed back to it on `--machine`, so branded and not
// pattern-refined.
export const HerdrMachineId = Schema.String.pipe(
  Schema.brand('HerdrMachineId'),
);
export type HerdrMachineId = typeof HerdrMachineId.Type;

// An Inbox's code, `xyz`: three random lower-case letters (`inbox-code.ts`),
// or `ab-xyz` in a log written before codes lost their name part. Assigned
// by the app, unique across a machine's Inboxes, and quoted with a
// Question's number as its code (`xyz#12`). Unrefined, like the ids above, so a log
// written by a later build with a longer code still decodes here; the app's
// own codes are built and parsed in `inbox-code.ts`.
export const InboxCode = Schema.String.pipe(Schema.brand('InboxCode'));
export type InboxCode = typeof InboxCode.Type;
