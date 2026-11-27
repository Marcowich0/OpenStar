// A QR code drawn on the page as one SVG path. It is encoded here, in the
// browser, with `uqr`: the built app fetches nothing from another host.

import { useMemo } from "react";
import { encode } from "uqr";

import { tokenVar } from "../../theme/tokens";

/** Quiet modules around the code; the white card around it adds more. */
const BORDER = 2;

export interface QrCodeProps {
  text: string;
  /** Its accessible name. */
  label: string;
  className?: string;
}

export function QrCode({ text, label, className = "" }: QrCodeProps) {
  const { size, path } = useMemo(() => {
    const qr = encode(text, { ecc: "M", border: BORDER });
    return { size: qr.size, path: modulesPath(qr.data) };
  }, [text]);
  return (
    <svg
      role="img"
      aria-label={label}
      data-qr-text={text}
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      shapeRendering="crispEdges"
      className={`block ${className}`}
    >
      <rect
        width={size}
        height={size}
        style={{ fill: tokenVar("--color-white") }}
      />
      {/* Dark modules on white in every theme, so any camera reads it. */}
      <path d={path} style={{ fill: tokenVar("--color-on-bright") }} />
    </svg>
  );
}

/** One `h` run per row of dark modules. */
function modulesPath(rows: boolean[][]): string {
  let d = "";
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x += 1;
      d += `M${String(start)} ${String(y)}h${String(x - start)}v1h${String(start - x)}z`;
    }
  });
  return d;
}
