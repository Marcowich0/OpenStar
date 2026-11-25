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
  LaneEntry,
  LineStyle,
  PillEntry,
  PlayheadEntry,
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
 * A painter for `ctx`. `readColour` resolves a palette key or token name to a
 * colour (`readToken` in the app); it is called at most once per name per frame.
 */
export function createPainter(
  ctx: CanvasRenderingContext2D,
  readColour: (ref: TokenRef) => string,
): Painter {
  // Reused across frames, so painting allocates nothing per frame beyond what
  // the canvas API itself does.
  const colours = new Map<TokenRef, string>();
  const gradients = new Map<number, CanvasGradient>();
  let gradientTop = "";
  let gradientBottom = "";

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
    const s = entry.separator;
    line(s, "butt", NO_DASH, s.x, s.top, s.bottom);
    ctx.save();
    ctx.beginPath();
    ctx.rect(
      entry.notesX,
      entry.y,
      entry.x + entry.width - entry.notesX,
      entry.height,
    );
    ctx.clip();
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
    ctx.strokeStyle = colour(entry.outline);
    ctx.lineWidth = entry.outlineWidth;
    ctx.setLineDash(entry.dash as number[]);
    ctx.stroke();
    if (local) ctx.translate(-entry.x, -entry.y);
  }

  return {
    paint(list, transform) {
      colours.clear();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      const { scale, x, y } = transform;
      ctx.setTransform(scale, 0, 0, scale, x, y);
      for (const entry of list) {
        switch (entry.type) {
          case "lane":
            lane(entry);
            break;
          case "pill":
            pill(entry);
            break;
          case "playhead":
            playhead(entry);
            break;
          case "laneEnd":
            ctx.restore();
            break;
        }
      }
    },
  };
}
