import { useAtomValue } from '@effect/atom-react';
import type { DiagramSize } from '@operator-inbox/core/api';
import type { CSSProperties, ReactNode } from 'react';
import { diagramSizeAtom } from '../inbox-reader';

// The box a picture in a question's body is drawn in: an Excalidraw drawing's
// preview and a Mermaid diagram alike. Its size is known before the picture
// is, from `width` and `height`, so the question it sits in mounts at its
// final height and nothing below or above it moves when the picture arrives.
// It is centred in its figure, and never wider than it.
//
// How it is sized is the operator's pick (`diagramSizeAtom`), by the rule
// in `pictureFrameStyle` below.
//
// It sits in a `picture-room`, a container the column's width, so `100cqw`
// below is the column. The figure around it takes the frame's width, and in
// the reading column runs into the right margin to give it, as a code block
// does, up to the same edge (`max-w-figure-bleed`).
export const PictureFrame = ({
  width,
  height,
  children,
}: {
  readonly width: number;
  readonly height: number;
  readonly children: ReactNode;
}) => {
  const rule = useAtomValue(diagramSizeAtom);
  return (
    <div
      data-picture-frame
      className="relative mx-auto max-w-full overflow-hidden"
      style={pictureFrameStyle({ width, height }, rule)}
    >
      {children}
    </div>
  );
};

// The number of pixels in a length, so `sqrt` can take it: `atan2` of two
// lengths is an angle, and its tangent their plain ratio.
const px = (length: string): string => `tan(atan2(${length}, 1px))`;

/**
 * THE SIZING RULE for a framed picture, in one place: retune it here.
 *
 * A picture `w` by `h` pixels is drawn at `w * scale` wide, in its own shape.
 * The operator picks the rule in config.json's `diagramSize`:
 *
 *   box:  scale = min(1, W / w, H / h)
 *   area: scale = min(1, W / w, H / h, sqrt(A / (w * h)))
 *
 * - 1: never larger than its own size.
 * - W: the room to the reader's right edge, the column and its right margin.
 *   The figure's `max-w-figure-bleed` and the frame's `max-w-full` hold it.
 * - H: `--max-height-picture`.
 * - A: the column's width times `--max-area-picture`, so a wide, short
 *   picture and a tall, narrow one take about the same room.
 *
 * It is CSS rather than a measurement, so it holds from the first render.
 * The shape is the picture's own data, not a design value, so it goes in as
 * an inline style.
 */
export const pictureFrameStyle = (
  { width, height }: { readonly width: number; readonly height: number },
  rule: DiagramSize,
): CSSProperties => {
  if (!(width > 0 && height > 0))
    return { aspectRatio: '1', width: 'min(100%, var(--max-height-picture))' };
  const ratio = width / height;
  const box = [`${width}px`, `var(--max-height-picture) * ${ratio}`];
  const area = `sqrt(${px('100cqw')} * ${px('var(--max-area-picture)')} * ${ratio}) * 1px`;
  return {
    aspectRatio: String(ratio),
    width: `min(${(rule === 'area' ? [...box, area] : box).join(', ')})`,
  };
};
