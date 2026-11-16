import { ContextMenu } from '@base-ui/react/context-menu';
import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react';
import type { QuestionComment } from '@operator-inbox/core/api';
import {
  type PointerEvent,
  type ReactNode,
  useCallback,
  useContext,
} from 'react';
import { copyText } from '../../clipboard';
import {
  commentAt,
  commentBodyAtom,
  commentMenuAtom,
  commentSelectionAtom,
  commentsInOrderAtom,
  type Drawn,
  drawComments,
  editCommentAtom,
  editingCommentAtom,
  hoverCommentAtom,
  isLit,
  litCommentAtom,
  type Point,
  readCommentSelection,
  removeCommentAtom,
} from '../../comments';
import { commentHereAtom } from '../../inbox-reader';
import { keyHintAtom } from '../../keymap';
import { MENU_ITEM, POPUP } from './row-menu';

// A Question's body that takes comments, around the real `QuestionBody`. It
// never touches the HTML inside: a comment's span is drawn as tinted boxes
// behind the text, from the Range's client rects, so the body's React-owned
// `innerHTML` is never split into spans and nothing beyond `Range` is needed
// (the CSS Custom Highlight API is newer than the desktop window's WebKit,
// and cannot be hovered or hit-tested). The context menu is Base UI's, and
// only while text in this body is selected or the pointer is on a comment;
// otherwise the browser's own menu opens.

// The body's element and its size, for the boxes. The escape hatch, all DOM:
// one stable ref per body, which watches its size and, when it changes, has
// the boxes and the floating button measured again.
const useBodyRef = (key: string) => {
  const registry = useContext(RegistryContext);
  return useCallback(
    (el: HTMLDivElement | null) => {
      if (el === null) return;
      const body = commentBodyAtom(key);
      const bump = () =>
        registry.set(body, { el, n: registry.get(body).n + 1 });
      // Only a real change of size measures again, so nothing drawn here
      // can set off another.
      let last = '';
      const sizes = new ResizeObserver(([entry]) => {
        const box = entry?.contentRect;
        const size = `${Math.round(box?.width ?? 0)}x${Math.round(box?.height ?? 0)}`;
        if (size === last) return;
        last = size;
        bump();
        if (registry.get(commentSelectionAtom)?.key === key)
          registry.set(commentSelectionAtom, readCommentSelection());
      });
      sizes.observe(el);
      bump();
      return () => {
        sizes.disconnect();
        registry.set(body, { el: undefined, n: registry.get(body).n + 1 });
      };
    },
    [key, registry],
  );
};

const pointIn = (el: Element, e: { clientX: number; clientY: number }) => {
  const origin = el.getBoundingClientRect();
  return { top: e.clientY - origin.top, left: e.clientX - origin.left };
};

/** The tints, behind the text (`-z-10` inside the body's `isolate`), and each one's number. */
const Highlights = ({
  drawn,
  numberOf,
  on,
}: {
  readonly drawn: ReadonlyArray<Drawn>;
  readonly numberOf: (id: number) => number;
  readonly on: (id: number) => boolean;
}) => (
  <>
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10"
    >
      {drawn.flatMap(({ id, boxes }) =>
        boxes.map((b, i) => (
          <div
            // A box's place in its comment's list is stable until a measure.
            key={`${id}:${i}`}
            data-comment-highlight={id}
            // Measured positions: runtime numbers no utility can hold.
            style={{
              top: b.top,
              left: b.left,
              width: b.width,
              height: b.height,
            }}
            className={`absolute ${on(id) ? 'bg-yellow/40 outline-1 outline-yellow' : 'bg-yellow/18'}`}
          />
        )),
      )}
    </div>
    {drawn.map(({ id, boxes }) => {
      const first = boxes[0];
      if (first === undefined) return null;
      return (
        <span
          key={id}
          aria-hidden="true"
          // A measured position: runtime numbers no utility can hold.
          style={{ top: first.top, left: first.left }}
          className={`pointer-events-none absolute z-10 -translate-x-full -translate-y-1/3 pr-0.5 font-zen text-9 leading-none ${on(id) ? 'font-medium text-fg' : 'text-yellow'}`}
        >
          {numberOf(id)}
        </span>
      );
    })}
  </>
);

/** The floating `❝ Comment` button, just above the end of the selection. */
const FloatingButton = ({
  at,
  onComment,
}: {
  readonly at: Point;
  readonly onComment: () => void;
}) => {
  const hint = useAtomValue(keyHintAtom('comment_selection'));
  return (
    <button
      type="button"
      data-selection-comment
      aria-label="Comment on the selection"
      aria-keyshortcuts={hint.aria}
      title={`Comment${hint.all === undefined ? '' : ` (${hint.all})`}`}
      // A press must not collapse the selection it is about, nor reach the
      // Question under it.
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onComment();
      }}
      // A measured position: runtime numbers no utility can hold.
      style={{ top: at.top, left: at.left }}
      // The hover's tint is an image over the opaque ground, so the text
      // under the button never shows through it.
      className="absolute z-30 flex -translate-y-full cursor-pointer items-center gap-1 rounded-full rounded-bl-none border border-yellow/60 bg-bg px-s1 py-0.5 font-zen text-11 text-yellow shadow-lg hover:bg-linear-to-r hover:from-yellow/15 hover:to-yellow/15"
    >
      <span aria-hidden="true">❝</span>
      Comment
      {hint.first !== undefined && (
        <span className="text-fg/35">{hint.first}</span>
      )}
    </button>
  );
};

/** The body of a Question waiting on the operator: it takes comments. */
export const CommentableBody = ({
  itemKey,
  children,
}: {
  readonly itemKey: string;
  readonly children: ReactNode;
}) => {
  const comments = useAtomValue(commentsInOrderAtom(itemKey));
  const { el } = useAtomValue(commentBodyAtom(itemKey));
  const selection = useAtomValue(commentSelectionAtom);
  const lit = useAtomValue(litCommentAtom);
  const editing = useAtomValue(editingCommentAtom);
  const menu = useAtomValue(commentMenuAtom);
  const setMenu = useAtomSet(commentMenuAtom);
  const hover = useAtomSet(hoverCommentAtom);
  const commentHere = useAtomSet(commentHereAtom);
  const edit = useAtomSet(editCommentAtom);
  const remove = useAtomSet(removeCommentAtom);
  const ref = useBodyRef(itemKey);
  // Measured while drawing: the body's layout is the previous commit's, and
  // a change of its size draws again (`commentBodyAtom`).
  const drawn = el === undefined ? [] : drawComments(el, comments);
  const numberOf = (id: number) => comments.findIndex((c) => c.id === id) + 1;
  const on = (id: number) =>
    isLit(lit, itemKey, id) || (editing?.key === itemKey && editing.id === id);
  const mine = selection?.key === itemKey ? selection : undefined;
  const onComment = lit?.key === itemKey ? lit.id : undefined;
  const menuOn = mine !== undefined || onComment !== undefined;
  const here = menu?.key === itemKey ? menu : undefined;
  const hitAt = (e: { clientX: number; clientY: number }) =>
    el === undefined ? undefined : commentAt(drawn, pointIn(el, e));
  return (
    <ContextMenu.Root
      disabled={!menuOn}
      // A picked item that moves the focus acts once the menu has gone, so
      // the menu, still shutting, never holds the focus against it.
      onOpenChangeComplete={(open) => {
        if (open || here === undefined) return;
        setMenu(undefined);
        if (here.after === 'comment' && here.anchor !== undefined)
          commentHere({ key: itemKey, anchor: here.anchor });
        else if (here.after === 'edit' && here.commentId !== undefined)
          edit({ key: itemKey, id: here.commentId });
      }}
    >
      <ContextMenu.Trigger
        ref={ref}
        data-commentable={itemKey}
        className="relative isolate"
        onContextMenuCapture={(e) => {
          if (!menuOn) return;
          setMenu({
            key: itemKey,
            anchor: readCommentSelection()?.anchor ?? mine?.anchor,
            commentId: hitAt(e),
          });
        }}
        onPointerMove={(e: PointerEvent) => {
          const id = hitAt(e);
          if (id !== undefined) hover({ key: itemKey, id });
          else if (lit?.key === itemKey) hover(undefined);
        }}
        onPointerLeave={() => {
          if (lit?.key === itemKey) hover(undefined);
        }}
        onClick={(e) => {
          // A click on a highlight goes to its card's field; a drag that
          // ends on one is a selection, not a click.
          if ((document.getSelection()?.toString() ?? '') !== '') return;
          const id = hitAt(e);
          if (id !== undefined) edit({ key: itemKey, id });
        }}
      >
        {children}
        <Highlights drawn={drawn} numberOf={numberOf} on={on} />
        {mine?.end !== undefined && editing === undefined && (
          <FloatingButton
            at={mine.end}
            onComment={() => commentHere({ key: itemKey, anchor: mine.anchor })}
          />
        )}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50">
          <ContextMenu.Popup
            finalFocus={false}
            className={`min-w-48 shadow-lg ${POPUP}`}
          >
            {here?.anchor !== undefined && (
              <>
                <ContextMenu.Item
                  className={MENU_ITEM}
                  onClick={() => setMenu({ ...here, after: 'comment' })}
                >
                  Comment
                  <CommentKeys />
                </ContextMenu.Item>
                <ContextMenu.Item
                  className={MENU_ITEM}
                  onClick={() => {
                    if (here.anchor !== undefined)
                      void copyText(here.anchor.quote);
                  }}
                >
                  Copy
                </ContextMenu.Item>
              </>
            )}
            {here?.commentId !== undefined && (
              <>
                {here.anchor !== undefined && (
                  <ContextMenu.Separator className="my-s1 h-px bg-fg/10" />
                )}
                <ContextMenu.Item
                  className={MENU_ITEM}
                  onClick={() => setMenu({ ...here, after: 'edit' })}
                >
                  Edit comment {numberOf(here.commentId)}
                </ContextMenu.Item>
                <ContextMenu.Item
                  className={MENU_ITEM}
                  onClick={() => {
                    if (here.commentId !== undefined)
                      remove({ key: itemKey, id: here.commentId });
                  }}
                >
                  Remove comment {numberOf(here.commentId)}
                </ContextMenu.Item>
              </>
            )}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
};

const CommentKeys = () => {
  const hint = useAtomValue(keyHintAtom('comment_selection'));
  return hint.first === undefined ? null : (
    <span className="text-fg/30">{hint.first}</span>
  );
};

/**
 * The body of an answered Question, with the comments its answer carried
 * drawn on it, read-only. A comment whose span the body no longer holds is
 * not drawn; the list under the answer still shows it.
 */
export const CommentedBody = ({
  itemKey,
  comments,
  children,
}: {
  readonly itemKey: string;
  readonly comments: ReadonlyArray<QuestionComment>;
  readonly children: ReactNode;
}) => {
  const { el } = useAtomValue(commentBodyAtom(itemKey));
  const ref = useBodyRef(itemKey);
  const numbered = comments.map((c, i) => ({ ...c, id: i + 1 }));
  const drawn = el === undefined ? [] : drawComments(el, numbered);
  return (
    <div ref={ref} className="relative isolate">
      {children}
      <Highlights drawn={drawn} numberOf={(id) => id} on={() => false} />
    </div>
  );
};
