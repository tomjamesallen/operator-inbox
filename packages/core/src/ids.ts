import { ulid } from 'ulid';

// A stable, sortable unique id (a ulid), for a new Inbox. Called at the CLI
// edge and never from inside core's pure functions, which take the id as an
// argument: that is the determinism seam a test injects a fixed id through.
export const newId = (): string => ulid();
