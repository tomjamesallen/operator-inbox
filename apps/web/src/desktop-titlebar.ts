// The desktop window (`scripts/desktop-app.sh`) is built with Pake's
// `--hide-title-bar`: the title bar is gone, the traffic lights float over the
// page's top edge, and the page draws the strip. Pake puts its window settings
// on every page as `window.pakeConfig` before any of the page's own scripts
// run. This marks the root so CSS can lay the strip out (`titlebar:` in
// `index.css`). In a browser, or in a window built with
// a title bar, there is no such setting and the root is left alone.

const hidesTitleBar = (win: Window): boolean => {
  const config: unknown = Reflect.get(win, 'pakeConfig');
  return (
    typeof config === 'object' &&
    config !== null &&
    Reflect.get(config, 'hide_title_bar') === true
  );
};

/** Marks `doc`'s root `data-titlebar="overlay"` in a window with no title bar. */
export const markTitleBar = (
  win: Window = window,
  doc: Document = document,
) => {
  if (hidesTitleBar(win)) doc.documentElement.dataset.titlebar = 'overlay';
};
