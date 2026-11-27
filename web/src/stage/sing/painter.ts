/**
 * The thin painter: it turns a draw list into 2D canvas calls and holds no
 * game logic. Every position, size, kind and colour choice is already in the
 * draw list; the painter only resolves colour names through the token reader
 * (once per name per frame) and maps entries to canvas calls. Painter output
 * is checked by screenshots (#58).
 */

import type { TokenRef } from "../../theme/tokens";
import type {
  BackgroundEntry,
  DrawList,
  GridEntry,
  HeadBallEntry,
  LaneEntry,
  LineStyle,
  ParticleEntry,
  PauseHintEntry,
  PillEntry,
  PitchLineEntry,
  PlayheadEntry,
  ProgressEntry,
  ShimmerStyle,
  StarStyle,
  TextStyle,
  TimeLeftEntry,
  TitleCardEntry,
  TracePoint,
} from "./frame";
import type { ImageSource } from "./coverImages";

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

/**
 * The transform from the reference frame to a canvas of `cssWidth` ×
 * `cssHeight` CSS pixels at `pixelRatio`, scaled uniformly to cover it and
 * centred: the background layer fills the screen like the video does.
 */
export function coverTransform(
  cssWidth: number,
  cssHeight: number,
  pixelRatio: number,
): ReferenceTransform {
  const cover = Math.max(
    cssWidth / REFERENCE_WIDTH,
    cssHeight / REFERENCE_HEIGHT,
  );
  return {
    scale: cover * pixelRatio,
    x: ((cssWidth - REFERENCE_WIDTH * cover) / 2) * pixelRatio,
    y: ((cssHeight - REFERENCE_HEIGHT * cover) / 2) * pixelRatio,
  };
}

export interface Painter {
  paint(list: DrawList, transform: ReferenceTransform): void;
}

const NO_DASH: readonly number[] = [];

/**
 * Which canvas a painter draws: the background canvas under the frosted lane
 * panels (the background entry only), the lanes canvas (everything but
 * particles and the background), or the effects canvas above the DOM lane
 * headers and lyric bar (particles only). All read the same draw list.
 */
export type PaintLayer = "background" | "lanes" | "effects";

/** A particle star's notch radius as a share of its point radius. */
const PARTICLE_STAR_INNER = 0.45;

/** No images: every cover shows its tile. */
const NO_IMAGES: ImageSource = () => null;

/**
 * A painter for `ctx`. `readColour` resolves a palette key or token name to a
 * colour (`readToken` in the app), and the font token to its font family; it
 * is called at most once per name per frame. `images` gives the loaded image
 * for a URL (the title card's cover), or `null` to draw the fallback.
 */
export function createPainter(
  ctx: CanvasRenderingContext2D,
  readColour: (ref: TokenRef) => string,
  layer: PaintLayer = "lanes",
  images: ImageSource = NO_IMAGES,
): Painter {
  // Reused across frames, so painting allocates nothing per frame beyond what
  // the canvas API itself does.
  const colours = new Map<TokenRef, string>();
  const gradients = new Map<number, CanvasGradient>();
  let gradientTop = "";
  let gradientBottom = "";
  const bands = new Map<number, CanvasGradient>();
  let bandColour = "";
  // One unit radial gradient per blob colour, moved and scaled onto each blob.
  const blobGradients = new Map<string, CanvasGradient>();
  // What the background canvas shows now, to skip a repaint that changes nothing.
  let painted: BackgroundEntry | null = null;
  let paintedTransform: ReferenceTransform | null = null;
  let paintedWidth = 0;
  let paintedHeight = 0;

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

  function font(style: TextStyle): string {
    return `${String(style.weight)} ${String(style.size)}px ${colour("--font-sans")}`;
  }

  /** Fills `style`'s text in its font and colour, at most `maxWidth` wide. */
  function text(style: TextStyle, maxWidth?: number) {
    ctx.font = font(style);
    ctx.fillStyle = colour(style.colour);
    if (maxWidth === undefined) ctx.fillText(style.text, style.x, style.y);
    else ctx.fillText(style.text, style.x, style.y, maxWidth);
  }

  function textWidth(style: TextStyle): number {
    ctx.font = font(style);
    return ctx.measureText(style.text).width;
  }

  function titleCard(entry: TitleCardEntry) {
    const { x, y, height, title, artist, cover: c } = entry;
    const width = Math.min(
      entry.maxWidth,
      title.x -
        x +
        Math.max(textWidth(title), textWidth(artist)) +
        entry.paddingRight,
    );
    const radius = height / 2;
    ctx.fillStyle = colour(entry.ledge);
    ctx.beginPath();
    ctx.roundRect(x, y + entry.ledgeDepth, width, height, radius);
    ctx.fill();
    ctx.globalAlpha = entry.alpha;
    ctx.fillStyle = colour(entry.fill);
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
    ctx.fill();
    ctx.globalAlpha = 1;

    // The cover: the rim, the tile inside it, then the image over the tile.
    ctx.fillStyle = colour(c.rim);
    ctx.beginPath();
    ctx.roundRect(c.x, c.y, c.size, c.size, c.radius);
    ctx.fill();
    const inX = c.x + c.rimWidth;
    const inY = c.y + c.rimWidth;
    const inSize = c.size - 2 * c.rimWidth;
    ctx.fillStyle = colour(c.tile);
    ctx.beginPath();
    ctx.roundRect(inX, inY, inSize, inSize, c.radius - c.rimWidth);
    ctx.fill();
    const image = c.url === null ? null : images(c.url);
    if (image) {
      // Cropped to a square from the middle, like `object-fit: cover`.
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      ctx.save();
      ctx.clip();
      ctx.drawImage(
        image,
        (image.naturalWidth - side) / 2,
        (image.naturalHeight - side) / 2,
        side,
        side,
        inX,
        inY,
        inSize,
        inSize,
      );
      ctx.restore();
    }
    // A generated cover's letter, in the theme's font: the image has none.
    const letter = c.letter;
    if (letter) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = font(letter);
      ctx.globalAlpha = letter.shadowAlpha;
      ctx.fillStyle = colour(letter.shadow);
      ctx.fillText(letter.text, letter.x, letter.y + letter.shadowDy);
      ctx.globalAlpha = 1;
      text(letter);
    }

    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    const room = x + width - entry.paddingRight;
    text(title, room - title.x);
    text(artist, room - artist.x);
  }

  function pauseHint(entry: PauseHintEntry) {
    const width = textWidth(entry.text) + 2 * entry.padding;
    ctx.fillStyle = colour(entry.fill);
    ctx.beginPath();
    ctx.roundRect(entry.x, entry.y, width, entry.height, entry.height / 2);
    ctx.fill();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    text(entry.text);
  }

  function timeLeft(entry: TimeLeftEntry) {
    const style = entry.text;
    ctx.font = font(style);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = entry.outlineWidth;
    ctx.setLineDash(NO_DASH as number[]);
    ctx.strokeStyle = colour(entry.outline);
    ctx.strokeText(style.text, style.x, style.y);
    text(style);
  }

  function blobGradient(value: string) {
    let gradient = blobGradients.get(value);
    if (!gradient) {
      // As the shimmer band: a nearly clear stop of the same colour, so the
      // edge fades without a grey fringe.
      gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      gradient.addColorStop(0, value);
      gradient.addColorStop(
        0.5,
        `color-mix(in srgb, ${value} 55%, transparent)`,
      );
      gradient.addColorStop(1, `color-mix(in srgb, ${value} 1%, transparent)`);
      blobGradients.set(value, gradient);
    }
    return gradient;
  }

  /** The canvas already shows `entry` at `transform`: nothing to repaint. */
  function unchanged(
    entry: BackgroundEntry | null,
    transform: ReferenceTransform,
  ): boolean {
    const was = painted;
    if (
      ctx.canvas.width !== paintedWidth ||
      ctx.canvas.height !== paintedHeight
    ) {
      return false;
    }
    // Nothing to paint shows as a clear canvas, whatever the transform.
    const clear = (e: BackgroundEntry | null) => e?.kind !== "blobs";
    if (clear(entry) || clear(was)) return clear(entry) && clear(was);
    const t = paintedTransform;
    if (
      !t ||
      t.scale !== transform.scale ||
      t.x !== transform.x ||
      t.y !== transform.y
    ) {
      return false;
    }
    if (entry.base !== was.base || entry.blobs.length !== was.blobs.length) {
      return false;
    }
    for (let i = 0; i < entry.blobs.length; i++) {
      const a = entry.blobs[i];
      const b = was.blobs[i];
      if (
        !a ||
        !b ||
        a.x !== b.x ||
        a.y !== b.y ||
        a.radius !== b.radius ||
        a.colour !== b.colour ||
        a.alpha !== b.alpha
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * The background canvas: the blobs on their base, or clear for a video or
   * an image (the DOM below shows them). Painted only when it changes.
   */
  function paintBackground(list: DrawList, transform: ReferenceTransform) {
    let entry: BackgroundEntry | null = null;
    for (const e of list) {
      if (e.type === "background") {
        entry = e;
        break;
      }
    }
    // The very first paint always happens, so the canvas starts known.
    if (paintedTransform && unchanged(entry, transform)) return;
    painted = entry;
    paintedTransform = transform;
    paintedWidth = ctx.canvas.width;
    paintedHeight = ctx.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (entry?.kind !== "blobs") {
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      return;
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = colour(entry.base);
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    const { scale, x, y } = transform;
    for (const blob of entry.blobs) {
      const r = blob.radius * scale;
      ctx.setTransform(r, 0, 0, r, x + blob.x * scale, y + blob.y * scale);
      ctx.globalAlpha = blob.alpha;
      ctx.fillStyle = blobGradient(colour(blob.colour));
      ctx.fillRect(-1, -1, 2, 2);
    }
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
      if (layer === "background") {
        paintBackground(list, transform);
        return;
      }
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
          case "titleCard":
            titleCard(entry);
            break;
          case "pauseHint":
            pauseHint(entry);
            break;
          case "timeLeft":
            timeLeft(entry);
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
          case "background":
            // The background canvas's painter draws this.
            break;
        }
      }
    },
  };
}
