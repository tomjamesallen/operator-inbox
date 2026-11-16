import type { MetadataKey } from '@operator-inbox/core/api';
import { describe, expect, it } from 'vitest';
import {
  metaNodeOf,
  metaPairsOf,
  questionOnlyOf,
} from '../src/inbox-metadata-view';

const rule = (key: string): MetadataKey => ({
  key,
  description: key,
  presence: 'optional',
  type: 'string',
});

describe('what the metadata card lists', () => {
  it('lists the rules’ keys in rule order, then the rest by name', () => {
    const rules = { keys: [rule('repo'), rule('team')] };
    const pairs = metaPairsOf(rules, {
      zeta: 'z',
      team: 'a',
      repo: 'r',
      alpha: 'x',
    });
    expect(pairs.map((p) => p.key)).toEqual(['repo', 'team', 'alpha', 'zeta']);
  });

  it('leaves group to the eyebrow', () => {
    expect(metaPairsOf({ keys: [rule('group')] }, { group: 'ops' })).toEqual(
      [],
    );
    expect(metaPairsOf({ keys: [] }, { group: 'ops' })).toEqual([]);
  });

  it('drops a question’s keys equal to its inbox’s, nested ones too', () => {
    expect(
      questionOnlyOf(
        { team: 'a', model: { c: 1 }, repo: 'mine', pr: '1' },
        { team: 'a', model: { c: 1 }, repo: 'theirs' },
      ),
    ).toEqual({ repo: 'mine', pr: '1' });
  });
});

describe('how a value draws', () => {
  it('links a web address, at any depth', () => {
    const url = 'https://example.test/a';
    expect(metaNodeOf(url)).toEqual({ _tag: 'Link', href: url, text: url });
    expect(metaNodeOf([url])).toEqual({
      _tag: 'List',
      items: [{ _tag: 'Link', href: url, text: url }],
    });
    expect(metaNodeOf({ spec: url })).toEqual({
      _tag: 'Fields',
      fields: [{ key: 'spec', node: { _tag: 'Link', href: url, text: url } }],
    });
  });

  it('links an object with a url under its title, or its url', () => {
    const url = 'https://example.test/a';
    expect(metaNodeOf({ url, title: 'Spec' })).toEqual({
      _tag: 'Link',
      href: url,
      text: 'Spec',
    });
    expect(metaNodeOf({ url })).toEqual({ _tag: 'Link', href: url, text: url });
  });

  it('keeps what else a link holds beside it', () => {
    const url = 'https://example.test/a';
    const link = { _tag: 'Link', href: url, text: url };
    expect(metaNodeOf({ url, branch: 'main' })).toEqual({
      _tag: 'List',
      items: [
        link,
        {
          _tag: 'Fields',
          fields: [{ key: 'branch', node: { _tag: 'Text', text: 'main' } }],
        },
      ],
    });
  });

  it('never links anything but a web address', () => {
    const bad = 'javascript:alert(1)';
    expect(metaNodeOf(bad)).toEqual({ _tag: 'Text', text: bad });
    expect(metaNodeOf({ url: bad, title: 'x' })._tag).toBe('Fields');
  });

  describe('a session link', () => {
    const link = 'claude://claude.ai/epitaxy/local_0a1b-2c3d';

    it('is text: the page opens it from an icon', () => {
      expect(metaNodeOf(link)).toEqual({ _tag: 'Text', text: link });
    });

    it('never links a near miss', () => {
      for (const bad of [
        'javascript:alert(1)',
        'claude://evil.ai/epitaxy/local_0a1b',
        'claude://claude.ai/epitaxy/0a1b',
        `${link}/more`,
        `${link}?x=1`,
      ]) {
        expect(metaNodeOf(bad)).toEqual({ _tag: 'Text', text: bad });
      }
    });
  });

  it('says a number and a boolean as text', () => {
    expect(metaNodeOf(7)).toEqual({ _tag: 'Text', text: '7' });
    expect(metaNodeOf(false)).toEqual({ _tag: 'Text', text: 'false' });
  });
});
