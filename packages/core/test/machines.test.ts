import { describe, expect, it } from '@effect/vitest';
import { Result, Schema } from 'effect';
import {
  findMachine,
  type HerdrMachine,
  HerdrMachineList,
} from '../src/machines';
import { HerdrMachineId } from '../src/schema/identifiers';

const machine = (over: Partial<HerdrMachine> = {}): HerdrMachine => ({
  id: HerdrMachineId.make('56f66a81e3ec2f2e0f6b45b037f77ee4'),
  label: 'remote-1',
  target: 'laptop',
  session: 'default',
  enabled: true,
  selected: false,
  ...over,
});

describe('HerdrMachineList', () => {
  it('decodes the shape herdr 0.9.5 prints for `machine list --json`', () => {
    const raw = JSON.stringify([
      {
        id: '56f66a81e3ec2f2e0f6b45b037f77ee4',
        label: 'remote-1',
        target: 'laptop',
        session: 'default',
        enabled: true,
        selected: false,
      },
    ]);
    const decoded = Schema.decodeUnknownSync(HerdrMachineList)(raw);
    expect(decoded[0]?.label).toBe('remote-1');
    expect(decoded[0]?.target).toBe('laptop');
  });
});

describe('findMachine', () => {
  it('matches a label or an id', () => {
    const list = [machine()];
    expect(Result.getOrNull(findMachine(list, 'remote-1'))?.target).toBe(
      'laptop',
    );
    expect(
      Result.getOrNull(findMachine(list, '56f66a81e3ec2f2e0f6b45b037f77ee4'))
        ?.label,
    ).toBe('remote-1');
  });

  it('refuses an empty list, an unknown selector, a shared label and a disabled machine', () => {
    expect(findMachine([], 'x')).toEqual(Result.fail({ _tag: 'NoMachines' }));
    expect(findMachine([machine()], 'nowhere')).toEqual(
      Result.fail({ _tag: 'Unknown', selector: 'nowhere' }),
    );
    const twin = machine({ id: HerdrMachineId.make('other') });
    expect(findMachine([machine(), twin], 'remote-1')).toEqual(
      Result.fail({ _tag: 'Ambiguous', selector: 'remote-1' }),
    );
    expect(findMachine([machine({ enabled: false })], 'remote-1')).toEqual(
      Result.fail({ _tag: 'Disabled', label: 'remote-1' }),
    );
  });
});
