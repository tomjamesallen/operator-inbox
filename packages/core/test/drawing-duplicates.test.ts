import { describe, expect, it } from '@effect/vitest';
import { keepIdsThroughDuplicates, summariseScene } from '../src';

// Scenes as the editor sends them back, built the way Excalidraw 0.18 edits
// them: a duplicate is an exact copy with a new id (and new ids for its bound
// text and its groups); Alt-drag leaves that copy where the original stood
// and drags the original away, rebinding any arrow onto the copy; ⌘D and
// paste leave the original where it was and put the copy elsewhere.

const scene = (elements: ReadonlyArray<unknown>) =>
  JSON.stringify({ type: 'excalidraw', version: 2, elements });

const elementsOf = (text: string): ReadonlyArray<Record<string, unknown>> =>
  (JSON.parse(text) as { elements: ReadonlyArray<Record<string, unknown>> })
    .elements;

const byId = (text: string, id: string) =>
  elementsOf(text).find((e) => e.id === id);

// The agent's scene, as the compact form's skeleton: two labelled boxes and
// an arrow between them.
const AGENT = scene([
  {
    type: 'rectangle',
    id: 'login',
    x: 0,
    y: 0,
    width: 160,
    height: 60,
    strokeStyle: 'solid',
    label: { text: 'Login', fontSize: 16 },
  },
  {
    type: 'rectangle',
    id: 'home',
    x: 300,
    y: 0,
    width: 160,
    height: 60,
    strokeStyle: 'solid',
    label: { text: 'Home', fontSize: 16 },
  },
  {
    type: 'arrow',
    id: 'go',
    x: 160,
    y: 30,
    width: 140,
    height: 0,
    points: [
      [0, 0],
      [140, 0],
    ],
    strokeStyle: 'solid',
    start: { id: 'login' },
    end: { id: 'home' },
  },
]);

// A box as the editor has it, with its bound text.
const box = (
  id: string,
  textId: string,
  x: number,
  y: number,
  words: string,
  more: ReadonlyArray<{ id: string; type: string }> = [],
  groupIds: ReadonlyArray<string> = [],
) => [
  {
    type: 'rectangle',
    id,
    x,
    y,
    width: 160,
    height: 60,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    roundness: null,
    groupIds,
    boundElements: [{ id: textId, type: 'text' }, ...more],
    version: 3,
  },
  {
    type: 'text',
    id: textId,
    x: x + 60,
    y: y + 20,
    width: 40,
    height: 20,
    text: words,
    originalText: words,
    fontSize: 16,
    containerId: id,
    groupIds,
    version: 3,
  },
];

const arrow = (from: string, to: string) => ({
  type: 'arrow',
  id: 'go',
  x: 160,
  y: 30,
  width: 140,
  height: 0,
  points: [
    [0, 0],
    [140, 0],
  ],
  strokeStyle: 'solid',
  startBinding: { elementId: from, focus: 0, gap: 1 },
  endBinding: { elementId: to, focus: 0, gap: 1 },
  version: 3,
});

const ARROW = [{ id: 'go', type: 'arrow' }];

// The scene as the editor first lays out the agent's skeleton.
const OPENED = scene([
  ...box('login', 'loginText', 0, 0, 'Login', ARROW),
  ...box('home', 'homeText', 300, 0, 'Home', ARROW),
  arrow('login', 'home'),
]);

// Alt-drag of "Login" down by 200: the copy left in place has new ids and
// holds the arrow; the original, its id and its text's id kept, is below.
const ALT_DRAGGED = scene([
  ...box(
    'Xq9fT2mLpW7rZk4bN1sDv',
    'Yt3hR8cJqL5wN0pKe6aGu',
    0,
    0,
    'Login',
    ARROW,
  ),
  ...box('home', 'homeText', 300, 0, 'Home', ARROW),
  arrow('Xq9fT2mLpW7rZk4bN1sDv', 'home'),
  ...box('login', 'loginText', 0, 200, 'Login'),
]);

describe('keepIdsThroughDuplicates', () => {
  it('gives an Alt-drag duplicate’s ids back to the shape that stayed', () => {
    const kept = keepIdsThroughDuplicates(AGENT, ALT_DRAGGED);
    expect(byId(kept, 'login')).toMatchObject({ x: 0, y: 0 });
    expect(byId(kept, 'loginText')).toMatchObject({
      x: 60,
      y: 20,
      containerId: 'login',
    });
    expect(byId(kept, 'Xq9fT2mLpW7rZk4bN1sDv')).toMatchObject({
      x: 0,
      y: 200,
      boundElements: [{ id: 'Yt3hR8cJqL5wN0pKe6aGu', type: 'text' }],
    });
    expect(byId(kept, 'Yt3hR8cJqL5wN0pKe6aGu')).toMatchObject({
      y: 220,
      containerId: 'Xq9fT2mLpW7rZk4bN1sDv',
    });
  });

  it('moves the arrow’s binding with the id, so it joins the agent’s box', () => {
    const kept = keepIdsThroughDuplicates(AGENT, ALT_DRAGGED);
    expect(byId(kept, 'go')).toMatchObject({
      startBinding: { elementId: 'login' },
      endBinding: { elementId: 'home' },
    });
    expect(byId(kept, 'login')).toMatchObject({
      boundElements: [
        { id: 'loginText', type: 'text' },
        { id: 'go', type: 'arrow' },
      ],
    });
    expect(summariseScene(kept)).toContain('- box "Login" [login] at 0,0');
    expect(summariseScene(kept)).toContain('- "Login" → "Home" [go]');
    expect(summariseScene(kept)).toContain(
      '- box "Login" [Xq9fT2] at 0,200 size 160×60',
    );
  });

  it('works against the scene the editor opened on as well as the agent’s', () => {
    expect(keepIdsThroughDuplicates(OPENED, ALT_DRAGGED)).toBe(
      keepIdsThroughDuplicates(AGENT, ALT_DRAGGED),
    );
  });

  it('is idempotent: a scene already put right comes back the same', () => {
    const kept = keepIdsThroughDuplicates(AGENT, ALT_DRAGGED);
    expect(keepIdsThroughDuplicates(AGENT, kept)).toBe(kept);
    expect(keepIdsThroughDuplicates(OPENED, kept)).toBe(kept);
  });

  it('keeps the swap when the dragged copy is relabelled afterwards', () => {
    const relabelled = ALT_DRAGGED.replace(
      /"text":"Login","originalText":"Login","fontSize":16,"containerId":"login"/,
      '"text":"Sign up","originalText":"Sign up","fontSize":16,"containerId":"login"',
    );
    expect(relabelled).not.toBe(ALT_DRAGGED);
    const kept = keepIdsThroughDuplicates(AGENT, relabelled);
    expect(byId(kept, 'login')).toMatchObject({ x: 0, y: 0 });
    expect(byId(kept, 'loginText')).toMatchObject({ text: 'Login' });
    expect(summariseScene(kept)).toContain('- box "Sign up" [Xq9fT2] at 0,200');
  });

  it('leaves a ⌘D duplicate alone: the original stayed, the copy is new', () => {
    const duplicated = scene([
      ...box('login', 'loginText', 0, 0, 'Login', ARROW),
      ...box('home', 'homeText', 300, 0, 'Home', ARROW),
      arrow('login', 'home'),
      ...box('Pq1rS2tU3vW4xY5zA6bC7', 'Dd8eF9gH0iJ1kL2mN3oP4', 10, 10, 'Login'),
    ]);
    expect(keepIdsThroughDuplicates(AGENT, duplicated)).toBe(duplicated);
  });

  it('leaves a ⌘D duplicate alone even when the original is then moved', () => {
    const duplicated = scene([
      ...box('login', 'loginText', 0, 300, 'Login', ARROW),
      ...box('home', 'homeText', 300, 0, 'Home', ARROW),
      arrow('login', 'home'),
      ...box('Pq1rS2tU3vW4xY5zA6bC7', 'Dd8eF9gH0iJ1kL2mN3oP4', 10, 10, 'Login'),
    ]);
    expect(keepIdsThroughDuplicates(AGENT, duplicated)).toBe(duplicated);
  });

  it('leaves a pasted copy alone', () => {
    const pasted = scene([
      ...box('login', 'loginText', 0, 0, 'Login', ARROW),
      ...box('home', 'homeText', 300, 0, 'Home', ARROW),
      arrow('login', 'home'),
      ...box(
        'Pq1rS2tU3vW4xY5zA6bC7',
        'Dd8eF9gH0iJ1kL2mN3oP4',
        520,
        340,
        'Login',
      ),
    ]);
    expect(keepIdsThroughDuplicates(AGENT, pasted)).toBe(pasted);
  });

  it('leaves a move alone', () => {
    const moved = scene([
      ...box('login', 'loginText', 0, 200, 'Login', ARROW),
      ...box('home', 'homeText', 300, 0, 'Home', ARROW),
      arrow('login', 'home'),
    ]);
    expect(keepIdsThroughDuplicates(AGENT, moved)).toBe(moved);
  });

  it('leaves a relabel alone', () => {
    const relabelled = scene([
      ...box('login', 'loginText', 0, 0, 'Sign in', ARROW),
      ...box('home', 'homeText', 300, 0, 'Home', ARROW),
      arrow('login', 'home'),
    ]);
    expect(keepIdsThroughDuplicates(AGENT, relabelled)).toBe(relabelled);
  });

  it('leaves a move with a new, different shape in the old place alone', () => {
    const other = scene([
      ...box('Xq9fT2mLpW7rZk4bN1sDv', 'Yt3hR8cJqL5wN0pKe6aGu', 0, 0, 'Logout'),
      ...box('home', 'homeText', 300, 0, 'Home', ARROW),
      arrow('login', 'home'),
      ...box('login', 'loginText', 0, 200, 'Login', ARROW),
    ]);
    expect(keepIdsThroughDuplicates(AGENT, other)).toBe(other);
  });

  it('leaves it alone when two new shapes stand in the old place', () => {
    const two = scene([
      ...box('Xq9fT2mLpW7rZk4bN1sDv', 'Yt3hR8cJqL5wN0pKe6aGu', 0, 0, 'Login'),
      ...box('Pq1rS2tU3vW4xY5zA6bC7', 'Dd8eF9gH0iJ1kL2mN3oP4', 0, 0, 'Login'),
      ...box('home', 'homeText', 300, 0, 'Home', ARROW),
      arrow('login', 'home'),
      ...box('login', 'loginText', 0, 200, 'Login', ARROW),
    ]);
    expect(keepIdsThroughDuplicates(AGENT, two)).toBe(two);
  });

  it('leaves it alone when two of the agent’s shapes could claim one clone', () => {
    const twins = scene([
      {
        type: 'rectangle',
        id: 'one',
        x: 0,
        y: 0,
        width: 160,
        height: 60,
        label: { text: 'Same' },
      },
      {
        type: 'rectangle',
        id: 'two',
        x: 0,
        y: 0,
        width: 160,
        height: 60,
        label: { text: 'Same' },
      },
    ]);
    const both = scene([
      ...box('Xq9fT2mLpW7rZk4bN1sDv', 'Yt3hR8cJqL5wN0pKe6aGu', 0, 0, 'Same'),
      ...box('one', 'oneText', 0, 200, 'Same'),
      ...box('two', 'twoText', 400, 200, 'Same'),
    ]);
    expect(keepIdsThroughDuplicates(twins, both)).toBe(both);
  });

  it('swaps the group ids a group’s clone was given', () => {
    const grouped = scene([
      ...box('a', 'aText', 0, 0, 'A', [], ['g1']),
      ...box('b', 'bText', 200, 0, 'B', [], ['g1']),
    ]);
    const dragged = scene([
      ...box('a2', 'a2Text', 0, 0, 'A', [], ['g2']),
      ...box('b2', 'b2Text', 200, 0, 'B', [], ['g2']),
      ...box('a', 'aText', 0, 300, 'A', [], ['g1']),
      ...box('b', 'bText', 200, 300, 'B', [], ['g1']),
    ]);
    const kept = keepIdsThroughDuplicates(grouped, dragged);
    expect(byId(kept, 'a')).toMatchObject({ y: 0, groupIds: ['g1'] });
    expect(byId(kept, 'b')).toMatchObject({ y: 0, groupIds: ['g1'] });
    expect(byId(kept, 'a2')).toMatchObject({ y: 300, groupIds: ['g2'] });
    expect(byId(kept, 'bText')).toMatchObject({ groupIds: ['g1'], y: 20 });
  });

  it('passes text that is not two scenes through as it is', () => {
    expect(keepIdsThroughDuplicates('not json', ALT_DRAGGED)).toBe(ALT_DRAGGED);
    expect(keepIdsThroughDuplicates(AGENT, 'not json')).toBe('not json');
  });
});
