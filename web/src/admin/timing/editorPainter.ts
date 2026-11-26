// The Timing editor's thin painter: turns the detail and overview draw lists
// into 2D canvas calls. Every position, kind and colour choice is already in
// the lists; this only resolves token names (once per name per paint) and maps
// entries to canvas calls.

import { overviewHue } from "../../fit/fit";
import type { TokenRef } from "../../theme/tokens";
import type {
  DetailEntry,
  LineBarEntry,
  PillEntry,
  PlayheadEntry,
  ShareColour,
} from "./detailFrame";
import type { OverviewEntry } from "./overviewFrame";

/** The canvas's size in CSS pixels and its device pixel ratio. */
export interface CanvasSize {
  width: number;
  height: number;
  pixelRatio: number;
}

const FONT_FAMILY = "Fredoka, ui-rounded, system-ui, sans-serif";
const LYRIC_FONT = `500 13px ${FONT_FAMILY}`;
const LYRIC_ITALIC_FONT = `italic 500 13px ${FONT_FAMILY}`;
const RULER_FONT = `500 12px ${FONT_FAMILY}`;
const DASH = [5, 4];
const NO_DASH: number[] = [];
const MATCH_ALPHA = 0.85;
const PENDING_ALPHA = 0.6;
const BAR_RADIUS = 6;

export function createEditorPainter(
  ctx: CanvasRenderingContext2D,
  readColour: (ref: TokenRef) => string,
) {
  let cache = new Map<TokenRef, string>();
  const colour = (ref: TokenRef) => {
    let value = cache.get(ref);
    if (value === undefined) {
      value = readColour(ref);
      cache.set(ref, value);
    }
    return value;
  };

  /** A share's colour: the hue `overviewHue` gives, between the two fit tokens. */
  function shareColour(c: ShareColour): string {
    switch (c.type) {
      case "share": {
        const percent = (overviewHue(c.share) / 120) * 100;
        return `color-mix(in hsl, ${colour("--color-fit-high")} ${String(percent)}%, ${colour("--color-fit-low")})`;
      }
      case "pending":
        return colour("--color-mute");
      case "none":
        return colour("--color-passed");
    }
  }

  function begin(size: CanvasSize) {
    cache = new Map();
    ctx.setTransform(size.pixelRatio, 0, 0, size.pixelRatio, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.globalAlpha = 1;
    ctx.setLineDash(NO_DASH);
  }

  function lineBar(e: LineBarEntry) {
    ctx.globalAlpha = e.colour.type === "pending" ? PENDING_ALPHA : 1;
    ctx.fillStyle = shareColour(e.colour);
    ctx.beginPath();
    ctx.roundRect(
      e.x,
      e.y,
      e.width,
      e.height,
      Math.min(BAR_RADIUS, e.height / 2),
    );
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function playhead(e: PlayheadEntry) {
    ctx.fillStyle = colour(e.colour);
    ctx.fillRect(e.x - e.width / 2, 0, e.width, e.height);
  }

  function pill(e: PillEntry) {
    const radius = e.height / 2;
    ctx.beginPath();
    ctx.roundRect(e.x, e.y, e.width, e.height, Math.min(radius, e.width / 2));
    if (e.fill === "golden") {
      const gradient = ctx.createLinearGradient(0, e.y, 0, e.y + e.height);
      gradient.addColorStop(0, colour("--color-golden-top"));
      gradient.addColorStop(1, colour("--color-golden-bottom"));
      ctx.fillStyle = gradient;
      ctx.fill();
    } else if (e.fill === "white") {
      ctx.fillStyle = colour("--color-white");
      ctx.fill();
    }
    if (e.match && e.match.width > 0) {
      ctx.save();
      ctx.clip();
      ctx.globalAlpha = MATCH_ALPHA;
      ctx.fillStyle = colour(e.matchColour);
      ctx.fillRect(e.x, e.y, e.match.width, e.height);
      ctx.restore();
    }
    ctx.lineWidth = e.outlineWidth;
    ctx.strokeStyle = colour(e.outline);
    ctx.setLineDash(e.dashed ? DASH : NO_DASH);
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    if (e.lyric.text !== "") {
      ctx.font = e.lyric.italic ? LYRIC_ITALIC_FONT : LYRIC_FONT;
      ctx.fillStyle = colour("--color-ink");
      ctx.fillText(e.lyric.text, e.lyric.x, e.lyric.y);
    }
  }

  return {
    paintDetail(list: readonly DetailEntry[], size: CanvasSize) {
      begin(size);
      for (const e of list) {
        switch (e.type) {
          case "rows":
            ctx.fillStyle = colour(e.colour);
            for (const y of e.ys)
              ctx.fillRect(0, y - e.height / 2, size.width, e.height);
            break;
          case "ruler":
            ctx.fillStyle = colour(e.colour);
            ctx.fillRect(0, 0, size.width, e.height);
            ctx.fillStyle = colour(e.ink);
            for (const tick of e.ticks)
              ctx.fillRect(tick.x, e.height - tick.height, 1, tick.height);
            ctx.font = RULER_FONT;
            for (const label of e.labels)
              ctx.fillText(label.text, label.x + 3, 12);
            break;
          case "waveform":
            ctx.fillStyle = colour(e.colour);
            e.heights.forEach((h, x) => {
              if (h > 0) ctx.fillRect(x, e.mid - h, 1, 2 * h);
            });
            break;
          case "lineBand":
            ctx.globalAlpha = e.alpha;
            ctx.fillStyle = colour(e.colour);
            ctx.fillRect(e.x, e.y, e.width, e.height);
            ctx.globalAlpha = 1;
            break;
          case "lineBar":
            lineBar(e);
            break;
          case "dots": {
            ctx.globalAlpha = e.alpha;
            ctx.fillStyle = colour(e.colour);
            const half = e.size / 2;
            for (let i = 0; i + 1 < e.points.length; i += 2)
              ctx.fillRect(
                (e.points[i] ?? 0) - half,
                (e.points[i + 1] ?? 0) - half,
                e.size,
                e.size,
              );
            ctx.globalAlpha = 1;
            break;
          }
          case "pill":
            pill(e);
            break;
          case "playhead":
            playhead(e);
            break;
        }
      }
    },

    paintOverview(list: readonly OverviewEntry[], size: CanvasSize) {
      begin(size);
      for (const e of list) {
        switch (e.type) {
          case "waveform":
            ctx.fillStyle = colour(e.colour);
            e.heights.forEach((h, x) => {
              if (h > 0) ctx.fillRect(x, e.base - h, 1, h);
            });
            break;
          case "lineBar":
            lineBar(e);
            break;
          case "window":
            ctx.lineWidth = e.lineWidth;
            ctx.strokeStyle = colour(e.colour);
            ctx.strokeRect(e.x, e.y, e.width, e.height);
            break;
          case "playhead":
            playhead(e);
            break;
        }
      }
    },
  };
}
