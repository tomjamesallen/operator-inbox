import { Result, Schema } from 'effect';
import { HerdrMachineId } from './schema/identifiers';

// Herdr machines: saved SSH machines whose Inboxes Local's serve merges into
// its own (`inbox-machines.ts`). Everything here is pure: the profile list's
// shape and the selector. The CLI edge runs `herdr machine list --json`.

// One row of `herdr machine list --json` (herdr 0.9.5,
// `src/cli/machine.rs` `MachineListRow`). The SSH target is the profile's own,
// so the CLI reaches the machine exactly as Herdr does.
export const HerdrMachine = Schema.Struct({
  id: HerdrMachineId,
  label: Schema.String,
  target: Schema.String,
  session: Schema.String,
  enabled: Schema.Boolean,
  selected: Schema.Boolean,
});
export type HerdrMachine = typeof HerdrMachine.Type;

export const HerdrMachineList = Schema.fromJsonString(
  Schema.Array(HerdrMachine),
);

export type MachineRejection =
  | { readonly _tag: 'NoMachines' }
  | { readonly _tag: 'Unknown'; readonly selector: string }
  | { readonly _tag: 'Ambiguous'; readonly selector: string }
  | { readonly _tag: 'Disabled'; readonly label: string };

export const renderMachineRejection = (r: MachineRejection): string =>
  r._tag === 'NoMachines'
    ? 'no saved Herdr machines (add one with `herdr machine add <ssh-target> --label <name>`)'
    : r._tag === 'Unknown'
      ? `no saved Herdr machine has the id or label "${r.selector}" (see \`herdr machine list\`)`
      : r._tag === 'Ambiguous'
        ? `more than one saved Herdr machine is labelled "${r.selector}": use its id`
        : `the Herdr machine "${r.label}" is disabled (\`herdr machine enable <id>\`)`;

// The selector rule `herdr --machine` itself applies: an id, or a unique,
// case-sensitive label. A disabled profile is refused here because
// `--machine` would refuse it too, later and less clearly.
export const findMachine = (
  machines: ReadonlyArray<HerdrMachine>,
  selector: string,
): Result.Result<HerdrMachine, MachineRejection> => {
  if (machines.length === 0) return Result.fail({ _tag: 'NoMachines' });
  const byId = machines.find((m) => m.id === selector);
  const byLabel = machines.filter((m) => m.label === selector);
  const found =
    byId ?? (byLabel.length === 1 ? byLabel[0] : undefined) ?? undefined;
  if (found === undefined) {
    return Result.fail(
      byLabel.length > 1
        ? { _tag: 'Ambiguous', selector }
        : { _tag: 'Unknown', selector },
    );
  }
  return found.enabled
    ? Result.succeed(found)
    : Result.fail({ _tag: 'Disabled', label: found.label });
};
