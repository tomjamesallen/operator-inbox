import { afterEach, describe, expect, it } from 'vitest';
import { markTitleBar } from '../src/desktop-titlebar';

// Pake's window settings, as it puts them on the page, against a bare window.
const windowWith = (pakeConfig?: unknown) =>
  (pakeConfig === undefined ? {} : { pakeConfig }) as unknown as Window;

describe('markTitleBar', () => {
  afterEach(() => {
    delete document.documentElement.dataset.titlebar;
  });

  it('marks the root in a window that hides its title bar', () => {
    markTitleBar(windowWith({ hide_title_bar: true }), document);
    expect(document.documentElement.dataset.titlebar).toBe('overlay');
  });

  it('leaves the root alone in a window with a title bar', () => {
    markTitleBar(windowWith({ hide_title_bar: false }), document);
    expect(document.documentElement.dataset.titlebar).toBeUndefined();
  });

  it('leaves the root alone in a browser', () => {
    markTitleBar(windowWith(), document);
    expect(document.documentElement.dataset.titlebar).toBeUndefined();
  });
});
