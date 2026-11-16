import { inDesktopWindow } from './inbox';

// Pake's window takes a right-click on a link before the page sees it: its
// injected script listens on the document, capturing, and for anything inside
// an `<a>` stops the event and draws its own link menu (pake-cli 3.17.5,
// `src-tauri/src/inject/event.js`). A sidebar row's label is a link, so
// without this its own menu would never open there. The window's capturing
// listener runs first: it takes a right-click on a row's link and sends it
// again on the row itself, which is not inside a link, so Pake passes it by
// and the row's menu opens where the pointer is. In a browser nothing takes
// the event, so it does nothing there.

const ROW = '[data-row-menu-area]';

export const redirectRowContextMenu = (event: MouseEvent): void => {
  // The event sent again is on the row, outside any link, so it passes here.
  if (!inDesktopWindow()) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const row = target.closest(ROW);
  if (row === null || target.closest('a') === null) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  row.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 2,
      buttons: event.buttons,
      clientX: event.clientX,
      clientY: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    }),
  );
};

/** Installs the redirect on `win`, once. Returns how to take it off. */
export const installRowContextMenu = (win: Window = window): (() => void) => {
  win.addEventListener('contextmenu', redirectRowContextMenu, true);
  return () =>
    win.removeEventListener('contextmenu', redirectRowContextMenu, true);
};
