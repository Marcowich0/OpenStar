// WCAG 2 contrast and colour distance, for the tests that check a theme: its
// text against the backgrounds it sits on (AA asks 4.5 : 1 for body text,
// 3 : 1 for large text and graphics), and its twelve Party colours apart
// from each other for colour-blind viewers too (#55).

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

type Rgb = readonly [number, number, number];

/** An opaque `#rrggbb` colour's channels, 0 to 255. */
function channels(colour: string): Rgb {
  const match = HEX.exec(colour.trim());
  if (!match) throw new Error(`not a #rrggbb colour: ${colour}`);
  return match.slice(1).map((pair) => parseInt(pair, 16)) as unknown as Rgb;
}

/** An sRGB channel (0 to 255) in linear light, 0 to 1. */
function linear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** The relative luminance of an opaque `#rrggbb` colour. */
function luminance(colour: string): number {
  const [r, g, b] = channels(colour).map(linear) as unknown as Rgb;
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

/**
 * `colour` at `alpha` laid over the opaque `background`, blended in sRGB as
 * the browser draws opacity and `color-mix(in srgb …)`.
 */
export function over(
  colour: string,
  alpha: number,
  background: string,
): string {
  const top = channels(colour);
  const bottom = channels(background);
  return `#${top
    .map((c, i) =>
      Math.round(c * alpha + (bottom[i] ?? 0) * (1 - alpha))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Normal vision, and the three dichromacies (red-, green- and blue-blind). */
export const VISIONS = ["normal", "protan", "deutan", "tritan"] as const;
export type Vision = (typeof VISIONS)[number];

/**
 * Each dichromacy's simulation in linear RGB (Viénot, Brettel and Mollon
 * 1999 for protan and deutan; Machado, Oliveira and Fernandes 2009 at full
 * severity for tritan).
 */
const SIMULATIONS: Readonly<
  Record<Exclude<Vision, "normal">, readonly [Rgb, Rgb, Rgb]>
> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

/** CIELAB (D65) of a colour as a viewer with `vision` sees it. */
function lab(colour: string, vision: Vision): Rgb {
  let rgb = channels(colour).map(linear) as unknown as Rgb;
  if (vision !== "normal") {
    const m = SIMULATIONS[vision];
    rgb = m.map((row) =>
      Math.min(
        1,
        Math.max(0, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]),
      ),
    ) as unknown as Rgb;
  }
  const [r, g, b] = rgb;
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/**
 * How far apart two opaque `#rrggbb` colours look (CIE76 ΔE: about 2 is
 * just noticeable, 100 is black to white), to a viewer with `vision`.
 */
export function colourDistance(
  a: string,
  b: string,
  vision: Vision = "normal",
): number {
  const p = lab(a, vision);
  const q = lab(b, vision);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
