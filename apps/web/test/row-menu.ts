import { fireEvent, screen, within } from '@testing-library/react';

// Opening a sidebar row's menu: a right-click on the row.

/** Right-clicks the sidebar row holding `inside`, and waits for its menu. */
export const rowMenu = async (inside: Element): Promise<HTMLElement> => {
  const row = inside.closest('[data-row-menu-area]');
  if (row === null) throw new Error('no row menu here');
  fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
  return screen.findByRole('menu');
};

/** Right-clicks the sidebar row of the Inbox named `label`, in `root`. */
export const openRowMenu = (
  label: string,
  root: ParentNode = document,
): Promise<HTMLElement> => {
  const link = [
    ...root.querySelectorAll<HTMLElement>('a[data-rail-inbox]'),
  ].find((a) => a.title.startsWith(`${label} · `));
  if (link === undefined) throw new Error(`no row ${label}`);
  return rowMenu(link);
};

/** Picks `item` from the menu of the row named `label`, in `root`. */
export const fromRowMenu = async (
  label: string,
  item: string | RegExp,
  root: ParentNode = document,
): Promise<void> => {
  const menu = await openRowMenu(label, root);
  fireEvent.click(within(menu).getByRole('menuitem', { name: item }));
};
