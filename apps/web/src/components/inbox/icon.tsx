import { Tooltip } from '@base-ui/react/tooltip';
import type { ReactNode } from 'react';

export const Icon = ({ d }: { readonly d: string }) => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    className="size-3.5 fill-none stroke-current stroke-2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d={d} />
  </svg>
);

export const ICON_COPY = 'M9 9h11v11H9zM5 15H4V4h11v1';
export const ICON_EXTERNAL = 'M14 5h5v5M19 5l-8 8M17 14v5H5V7h5';
export const ICON_DONE = 'M5 12l5 5 9-10';
export const ICON_FAILED = 'M6 6l12 12M18 6L6 18';

// The trigger is a span so a disabled button still answers a hover.
export const Tip = ({
  label,
  keys,
  children,
}: {
  readonly label: string;
  readonly keys: string | undefined;
  readonly children: ReactNode;
}) => (
  <Tooltip.Root>
    <Tooltip.Trigger delay={300} closeDelay={0} render={<span />}>
      {children}
    </Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Positioner side="top" sideOffset={6} className="z-40">
        <Tooltip.Popup className="flex items-center gap-s2 bg-fg px-s2 py-s1 font-zen text-11 whitespace-nowrap text-bg">
          {label}
          {keys !== undefined && <span className="text-bg/60">{keys}</span>}
        </Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  </Tooltip.Root>
);
