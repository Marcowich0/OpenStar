/**
 * The thin painter: it turns a draw list into 2D canvas calls and holds no
 * game logic. Every position, size, kind and colour choice is already in the
 * draw list; the painter only resolves colour names through the token reader
 * (once per name per frame) and maps entries to canvas calls. Painter output
 * is checked by screenshots (#58).
 */

import type { TokenRef } from "../../theme/tokens";
import type {
  DrawList,
  GridEntry,
  HeadBallEntry,
  LaneEntry,
  LineStyle,
  ParticleEntry,
  PillEntry,
  PitchLineEntry,
  PlayheadEntry,
  ProgressEntry,
  ShimmerStyle,
  StarStyle,
  TracePoint,
} from "./frame";

/** The reference frame every draw list is in (#55). */
const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;

/** Maps the reference frame onto a canvas: uniform scale, centred. */
export interface ReferenceTransform {
  scale: number;
  x: number;
  y: number;
}

/**
 * The transform from the 1920 × 1080 reference frame to device pixels for a
 * canvas of `cssWidth` × `cssHeight` CSS pixels at `pixelRatio`. The frame is
 * scaled uniformly and centred. The DOM layers use the same transform at a
 * pixel ratio of 1.
 */
export function referenceTransform(
  cssWidth: number,
  cssHeight: number,
  pixelRatio: number,
): ReferenceTransform {
  const fit = Math.min(
    cssWidth / REFERENCE_WIDTH,
    cssHeight / REFERENCE_HEIGHT,
  );
  return {
    scale: fit * pixelRatio,
    x: ((cssWidth - REFERENCE_WIDTH * fit) / 2) * pixelRatio,
    y: ((cssHeight - REFERENCE_HEIGHT * fit) / 2) * pixelRatio,
  };
}

export interface Painter {
  paint(list: DrawList, transform: ReferenceTransform): void;
}

const NO_DASH: readonly number[] = [];

/**
 * Which canvas a painter draws: the lanes canvas (everything but particles),
 * or the effects canvas above the DOM lane headers and lyric bar (particles
 * only). Both read the same draw list.
 */
export type PaintLayer = "lanes" | "effects";

/** A particle star's notch radius as a share of its point radius. */
const PARTICLE_STAR_INNER = 0.45;

/**
 * A painter for `ctx`. `readColour` resolves a palette key or token name to a
 * colour (`readToken` in the app); it is called at most once per name per frame.
 */
export function createPainter(
  ctx: CanvasRenderingContext2D,
  readColour: (ref: TokenRef) => string,
  layer: PaintLayer = "lanes",
): Painter {
  // Reused across frames, so painting allocates nothing per frame beyond what
  // the canvas API itself does.
  const colours = new Map<TokenRef, string>();
  const gradients = new Map<number, CanvasGradient>();
  let gradientTop = "";
  let gradientBottom = "";
  const bands = new Map<number, CanvasGradient>();
  let bandColour = "";

  function colour(ref: TokenRef): string {
    let value = colours.get(ref);
    if (value === undefined) {
      value = readColour(ref);
      colours.set(ref, value);
    }
    return value;
  }

  function line(
    style: LineStyle,
    cap: CanvasLineCap,
    dash: readonly number[],
    x: number,
    top: number,
    bottom: number,
  ) {
    ctx.globalAlpha = style.alpha;
    ctx.strokeStyle = colour(style.colour);
    ctx.lineWidth = style.width;
    ctx.lineCap = cap;
    ctx.setLineDash(dash as number[]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function lane(entry: LaneEntry) {
    const lost = entry.lost;
    if (lost) {
      ctx.globalAlpha = lost.alpha;
      ctx.fillStyle = colour(lost.colour);
      ctx.beginPath();
      ctx.roundRect(entry.x, entry.y, entry.width, entry.height, lost.radius);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    const s = entry.separator;
    line(s, "butt", NO_DASH, s.x, s.top, s.bottom);
    // The Notes area, inside the lane panel's rounded shape, so a pill
    // leaving at the right follows the panel's corner.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(entry.x, entry.y, entry.width, entry.height, entry.radius);
    ctx.clip();
    ctx.beginPath();
    ctx.rect(
      entry.notesX,
      entry.y,
      entry.x + entry.width - entry.notesX,
      entry.height,
    );
    ctx.clip();
  }

  function grid(entry: GridEntry) {
    ctx.globalAlpha = entry.alpha;
    ctx.strokeStyle = colour(entry.colour);
    ctx.lineWidth = entry.width;
    ctx.lineCap = "butt";
    ctx.setLineDash(NO_DASH as number[]);
    ctx.beginPath();
    for (const y of entry.ys) {
      ctx.moveTo(entry.left, y);
      ctx.lineTo(entry.right, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function progress(entry: ProgressEntry) {
    const { x, y, width, height } = entry;
    ctx.globalAlpha = entry.trackAlpha;
    ctx.fillStyle = colour(entry.track);
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, height / 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    const filled = width * entry.fraction;
    if (filled <= 0) return;
    ctx.fillStyle = colour(entry.fill);
    ctx.beginPath();
    ctx.roundRect(x, y, filled, height, Math.min(height, filled) / 2);
    ctx.fill();
  }

  /** A cached horizontal band over `width`: clear, `value` in the middle, clear. */
  function band(value: string, width: number) {
    if (value !== bandColour) {
      bands.clear();
      bandColour = value;
    }
    let gradient = bands.get(width);
    if (!gradient) {
      // A nearly clear stop of the same colour, so the edges fade without a
      // grey fringe (canvas gradients do not premultiply). At 0 % color-mix
      // gives transparent black, which is exactly that fringe.
      const clear = `color-mix(in srgb, ${value} 1%, transparent)`;
      gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, clear);
      gradient.addColorStop(0.5, value);
      gradient.addColorStop(1, clear);
      bands.set(width, gradient);
    }
    return gradient;
  }

  /** The shimmer band, clipped to the current path (the pill's). */
  function shimmer(s: ShimmerStyle, x: number, y: number, height: number) {
    ctx.save();
    ctx.clip();
    ctx.translate(x, y);
    ctx.globalAlpha = s.alpha;
    ctx.fillStyle = band(colour(s.colour), s.width);
    ctx.fillRect(0, 0, s.width, height);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function star(s: StarStyle) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? s.outer : s.inner;
      const angle = (i * Math.PI) / 5;
      const px = s.x + r * Math.sin(angle);
      const py = s.y - r * Math.cos(angle);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = colour(s.colour);
    ctx.fill();
  }

  function playhead(entry: PlayheadEntry) {
    line(entry, "round", entry.dash, entry.x, entry.top, entry.bottom);
  }

  /** A cached gradient from top to bottom over `height`, in pill coordinates. */
  function verticalGradient(top: string, bottom: string, height: number) {
    if (top !== gradientTop || bottom !== gradientBottom) {
      gradients.clear();
      gradientTop = top;
      gradientBottom = bottom;
    }
    let gradient = gradients.get(height);
    if (!gradient) {
      gradient = ctx.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, top);
      gradient.addColorStop(1, bottom);
      gradients.set(height, gradient);
    }
    return gradient;
  }

  function pill(entry: PillEntry) {
    const radius = Math.min(entry.width, entry.height) / 2;
    const fill = entry.fill;
    // A gradient is made in pill coordinates, so it can be reused at any x, y.
    const local = fill?.type === "vertical";
    if (local) ctx.translate(entry.x, entry.y);
    ctx.beginPath();
    ctx.roundRect(
      local ? 0 : entry.x,
      local ? 0 : entry.y,
      entry.width,
      entry.height,
      radius,
    );
    if (fill?.type === "solid") {
      ctx.fillStyle = colour(fill.colour);
      ctx.fill();
    } else if (fill?.type === "vertical") {
      ctx.fillStyle = verticalGradient(
        colour(fill.top),
        colour(fill.bottom),
        entry.height,
      );
      ctx.fill();
    }
    if (entry.shimmer) {
      shimmer(
        entry.shimmer,
        local ? entry.shimmer.x - entry.x : entry.shimmer.x,
        local ? 0 : entry.y,
        entry.height,
      );
    }
    ctx.strokeStyle = colour(entry.outline);
    ctx.lineWidth = entry.outlineWidth;
    ctx.setLineDash(entry.dash as number[]);
    ctx.stroke();
    if (local) ctx.translate(-entry.x, -entry.y);
    if (entry.star) star(entry.star);
  }

  /**
   * Strokes, as one path, every stretch of `points` whose end point has
   * `hit`. A one-point line is a dot in its point's style.
   */
  function stretches(
    points: readonly TracePoint[],
    hit: boolean,
    stroke: string,
    width: number,
    alpha: number,
  ) {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash(NO_DASH as number[]);
    ctx.beginPath();
    let open = false;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!p) continue;
      const from = points[i - 1] ?? (points.length === 1 ? p : undefined);
      if (!from || p.hit !== hit) {
        open = false;
        continue;
      }
      if (!open) ctx.moveTo(from.x, from.y);
      open = true;
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function pitchLine(entry: PitchLineEntry) {
    const { points, hit, miss } = entry;
    stretches(points, true, colour(hit.edge), hit.edgeWidth, 1);
    stretches(points, false, colour(miss.colour), miss.width, miss.alpha);
    stretches(points, true, colour(hit.colour), hit.width, 1);
  }

  function headBall(entry: HeadBallEntry) {
    ctx.beginPath();
    // The bounce squashes the disc; the rim keeps its width all round.
    ctx.ellipse(
      entry.x,
      entry.y,
      entry.radius * entry.squash.x,
      entry.radius * entry.squash.y,
      0,
      0,
      2 * Math.PI,
    );
    ctx.fillStyle = colour(entry.colour);
    ctx.fill();
    ctx.strokeStyle = colour(entry.rim);
    ctx.lineWidth = entry.rimWidth;
    ctx.setLineDash(NO_DASH as number[]);
    ctx.stroke();
  }

  function particle(entry: ParticleEntry) {
    ctx.globalAlpha = entry.alpha;
    ctx.fillStyle = colour(entry.colour);
    ctx.beginPath();
    const outer = entry.size / 2;
    if (entry.shape === "dot") {
      ctx.arc(entry.x, entry.y, outer, 0, 2 * Math.PI);
    } else {
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? outer : outer * PARTICLE_STAR_INNER;
        const angle = entry.rotation + (i * Math.PI) / 5;
        const px = entry.x + r * Math.sin(angle);
        const py = entry.y - r * Math.cos(angle);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function paintEffects(list: DrawList) {
    for (const entry of list) {
      if (entry.type === "particle") particle(entry);
    }
  }

  return {
    paint(list, transform) {
      colours.clear();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      const { scale, x, y } = transform;
      ctx.setTransform(scale, 0, 0, scale, x, y);
      if (layer === "effects") {
        paintEffects(list);
        return;
      }
      for (const entry of list) {
        switch (entry.type) {
          case "progress":
            progress(entry);
            break;
          case "lane":
            lane(entry);
            break;
          case "grid":
            grid(entry);
            break;
          case "pill":
            pill(entry);
            break;
          case "playhead":
            playhead(entry);
            break;
          case "pitchLine":
            pitchLine(entry);
            break;
          case "headBall":
            headBall(entry);
            break;
          case "laneEnd":
            ctx.restore();
            break;
          case "lyric":
            // DOM text: the render loop writes it to the lyric bar.
            break;
          case "lineRating":
            // DOM text too: the render loop writes it beside the lane header.
            break;
          case "particle":
            // The effects canvas's painter draws these.
            break;
        }
      }
    },
  };
}
