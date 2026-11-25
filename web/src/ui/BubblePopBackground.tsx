// The Bubble Pop background of every non-video screen: a radial gradient from
// white through cream to cream-2, with three large soft blobs floating on a
// 9 s cycle, a third of a cycle apart. Sizes follow the 1920 × 1080 reference
// frame of the prototypes, as fractions of the viewport.

import type { ReactNode } from "react";

const BLOBS = [
  {
    colour: "blue",
    className: "bg-blob-blue -top-[17vh] -left-[7vw] size-[29vw]",
  },
  {
    colour: "pink",
    className:
      "bg-blob-pink top-[13vh] -right-[5vw] size-[23vw] [animation-delay:-3s]",
  },
  {
    colour: "green",
    className:
      "bg-blob-green -bottom-[18vh] left-[42%] size-[20vw] [animation-delay:-6s]",
  },
] as const;

export interface BubblePopBackgroundProps {
  children?: ReactNode;
}

export function BubblePopBackground({ children }: BubblePopBackgroundProps) {
  return (
    <div className="relative isolate min-h-dvh font-sans text-ink">
      <div
        aria-hidden="true"
        data-bubble-pop-backdrop=""
        className="fixed inset-0 -z-10 overflow-hidden bg-[radial-gradient(circle_at_20%_10%,var(--color-white)_0,var(--color-cream)_40%,var(--color-cream-2)_100%)]"
      >
        {BLOBS.map(({ colour, className }) => (
          <span
            key={colour}
            data-blob={colour}
            className={`absolute rounded-full opacity-50 animate-float ${className}`}
          />
        ))}
      </div>
      {children}
    </div>
  );
}
