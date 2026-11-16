import { describe, expect, it } from '@effect/vitest';
import {
  answeredNumbers,
  decideWatchGuard,
  type InboxEvent,
  inboxState,
  newAnswers,
  QuestionNumber,
  renderAnswerSignal,
  WATCH_COMMAND,
} from '../src';
import { InboxId } from '../src/schema/identifiers';

// The inbox watcher's and guard's pure rules.

const ID = InboxId.make('01INBOXWATCH00000000000000');
const n = (x: number) => QuestionNumber.make(x);
const opened: InboxEvent = { _tag: 'InboxOpened', inboxId: ID, label: 'demo' };
const asked = (x: number): InboxEvent => ({
  _tag: 'QuestionAsked',
  inboxId: ID,
  number: n(x),
  title: `q${x}`,
  body: '',
});
const answered = (x: number): InboxEvent => ({
  _tag: 'QuestionAnswered',
  inboxId: ID,
  number: n(x),
  response: 'yes',
});

describe('new answers', () => {
  it('counts only answers not seen before, and grows what it has seen', () => {
    const before = answeredNumbers(
      inboxState([opened, asked(1), asked(2), answered(1)]),
    );
    expect([...before]).toEqual([1]);
    const after = answeredNumbers(
      inboxState([opened, asked(1), asked(2), answered(1), answered(2)]),
    );
    const step = newAnswers(before, after);
    expect(step.fresh).toBe(1);
    expect([...step.seen].sort()).toEqual([1, 2]);
    expect(newAnswers(step.seen, after).fresh).toBe(0);
  });

  it('says how many, and what to run', () => {
    expect(renderAnswerSignal(1, 'demo')).toBe(
      'inbox: 1 new answer in "demo" — run `operator-inbox answers`',
    );
    expect(renderAnswerSignal(3, 'demo')).toContain('3 new answers');
  });
});

describe('the guard', () => {
  const inbox = (events: ReadonlyArray<InboxEvent>, watcherAlive = false) => ({
    label: 'demo',
    state: inboxState(events),
    watcherAlive,
  });

  it('blocks while a question waits and nothing watches, and says how to arm', () => {
    const decision = decideWatchGuard({
      stopHookActive: false,
      inbox: inbox([opened, asked(1)]),
    });
    expect(decision.block).toBe(true);
    if (!decision.block) return;
    expect(decision.reason).toContain('1 question waits for the operator');
    expect(decision.reason).toContain(WATCH_COMMAND);
  });

  it('names answers already waiting', () => {
    const decision = decideWatchGuard({
      stopHookActive: false,
      inbox: inbox([opened, asked(1), answered(1)]),
    });
    expect(decision.block && decision.reason).toContain(
      '1 answer is already waiting',
    );
  });

  it('blocks on answers already waiting even while a watcher runs, since it will never report them', () => {
    const decision = decideWatchGuard({
      stopHookActive: false,
      inbox: inbox([opened, asked(1), asked(2), answered(1)], true),
    });
    expect(decision.block).toBe(true);
    if (!decision.block) return;
    expect(decision.reason).toContain('1 answer is already waiting');
    expect(decision.reason).toContain('operator-inbox answers');
    // A watcher runs, so the reason does not ask for another one, nor dwell
    // on the question still with the operator.
    expect(decision.reason).not.toContain(WATCH_COMMAND);
    expect(decision.reason).not.toContain('waits for the operator');
  });

  it('blocks an idle inbox nothing watches, since the operator can ask from the app', () => {
    const decision = decideWatchGuard({
      stopHookActive: false,
      inbox: inbox([opened]),
    });
    expect(decision.block).toBe(true);
    if (!decision.block) return;
    expect(decision.reason).toContain('a question the operator asks');
    expect(decision.reason).toContain(WATCH_COMMAND);
  });

  it('lets the turn end when watched, archived, already continuing or without an inbox', () => {
    const waiting = [opened, asked(1)];
    expect(
      decideWatchGuard({ stopHookActive: false, inbox: inbox(waiting, true) })
        .block,
    ).toBe(false);
    expect(
      decideWatchGuard({
        stopHookActive: false,
        inbox: inbox([...waiting, { _tag: 'InboxArchived', inboxId: ID }]),
      }).block,
    ).toBe(false);
    expect(
      decideWatchGuard({ stopHookActive: false, inbox: inbox([opened], true) })
        .block,
    ).toBe(false);
    expect(
      decideWatchGuard({ stopHookActive: true, inbox: inbox(waiting) }).block,
    ).toBe(false);
    expect(
      decideWatchGuard({ stopHookActive: false, inbox: undefined }).block,
    ).toBe(false);
  });
});
