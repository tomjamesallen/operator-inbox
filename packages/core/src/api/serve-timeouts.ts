import { Duration } from 'effect';

// The bounds `operator-inbox serve` puts on the calls it sends to an Inbox
// machine, here so the page can derive its own bounds from them
// (`BOARD_READ_BOUND` in apps/web) rather than restate them by hand, and
// serve its shutdown grace (`SERVE_SHUTDOWN_GRACE` in apps/cli). The client
// that applies them is apps/cli's `inbox-machine-client.ts`.

// About 10 s: a machine over a slow
// link still answers, and one that hangs holds the board up by this much.
export const MACHINE_CALL_TIMEOUT = Duration.seconds(10);

// A forwarded write (answer, rename, pin, archive, dismissHighlight) is not
// idempotent and may land after Local stops waiting, so it is given longer
// than a read, and a timeout is reported as an outcome not known.
export const MACHINE_WRITE_TIMEOUT = Duration.seconds(15);

// The longest serve waits on its machines to answer one board or index read:
// every machine is read at once, each within MACHINE_CALL_TIMEOUT, and none
// is read again. Herdr is not on the path: a request answers with the
// machines serve already holds, and re-reads them in the background. Local's
// own log is read beside the machines, under the store's own bounds, which
// this does not count.
export const SERVE_MACHINES_READ_WORST = MACHINE_CALL_TIMEOUT;

// The longest one forwarded write's request takes: the machine recorded as
// the Inbox's owner is sent the write, and when it lacks the Inbox the other
// machines are probed with a read and the write is sent to the one that has
// it (core's `planInboxOwnerLookup` plans at most those two rounds). A round
// of several machines asks them at once, so it costs one timeout, not one
// each.
export const FORWARDED_WRITE_WORST = Duration.sum(
  MACHINE_WRITE_TIMEOUT,
  Duration.sum(MACHINE_CALL_TIMEOUT, MACHINE_WRITE_TIMEOUT),
);
