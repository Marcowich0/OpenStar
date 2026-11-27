// WCAG 2 contrast, for the tests that check a theme's text against the
// backgrounds it sits on (AA asks 4.5 : 1 for body text).

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** The relative luminance of an opaque `#rrggbb` colour. */
function luminance(colour: string): number {
  const match = HEX.exec(colour.trim());
  if (!match) throw new Error(`not a #rrggbb colour: ${colour}`);
  const [r, g, b] = match.slice(1).map((pair) => {
    const c = parseInt(pair, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast ratio of two opaque `#rrggbb` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}
