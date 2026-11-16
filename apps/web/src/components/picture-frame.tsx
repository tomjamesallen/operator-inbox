import type { ReactNode } from 'react';

// The box a picture in a question's body is drawn in: an Excalidraw drawing's
// preview and a Mermaid diagram alike. It is the column's full width, as tall
// as the picture's own shape makes it, and never taller than
// `max-h-picture`: a taller picture is drawn narrower, centred, so it keeps
// its shape. Its size is known before the picture is, from `width` and
// `height` in any one unit, so the question it sits in mounts at its final
// height and nothing below or above it moves when the picture arrives.
//
// The shape is the picture's own data, not a design value, so it goes in as
// an inline style: an aspect ratio, and the width at which the cap is reached.
export const PictureFrame = ({
  width,
  height,
  children,
}: {
  readonly width: number;
  readonly height: number;
  readonly children: ReactNode;
}) => {
  const ratio = width > 0 && height > 0 ? width / height : 1;
  return (
    <div
      data-picture-frame
      className="relative mx-auto w-full overflow-hidden"
      style={{
        aspectRatio: String(ratio),
        maxWidth: `calc(var(--max-height-picture) * ${ratio})`,
      }}
    >
      {children}
    </div>
  );
};
