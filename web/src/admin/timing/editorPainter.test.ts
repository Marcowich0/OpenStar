import { describe, expect, it } from "vitest";

import type { TokenRef } from "../../theme/tokens";
import type { LineBarEntry, PillEntry } from "./detailFrame";
import { createEditorPainter } from "./editorPainter";

type Call = [string, ...unknown[]];

/** A 2D context that records every call and property write, in order. */
function recordingContext() {
  const calls: Call[] = [];
  const target: Record<string, unknown> = {
    createLinearGradient: () => ({ addColorStop: () => undefined }),
  };
  const ctx = new Proxy(target, {
    get(obj, prop: string) {
      if (prop in obj) return obj[prop];
      return (...args: unknown[]) => calls.push([prop, ...args]);
    },
    set(obj, prop: string, value: unknown) {
      calls.push(["set", prop, value]);
      obj[prop] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const colour = (ref: TokenRef) => `value(${ref})`;
const size = { width: 100, height: 50, pixelRatio: 2 };

const bar = (c: LineBarEntry["colour"]): LineBarEntry => ({
  type: "lineBar",
  voice: 0,
  line: 0,
  x: 0,
  y: 0,
  width: 10,
  height: 8,
  colour: c,
});

const fills = (calls: Call[]) =>
  calls.filter((c) => c[0] === "set" && c[1] === "fillStyle").map((c) => c[2]);

describe("the Timing editor's painter", () => {
  it("colours a Line by its share's hue, mixing the two fit tokens in HSL", () => {
    const { ctx, calls } = recordingContext();
    createEditorPainter(ctx, colour).paintOverview(
      [
        bar({ type: "share", share: 0.3125 }),
        bar({ type: "share", share: 0.9 }),
      ],
      size,
    );
    expect(fills(calls)).toEqual([
      "color-mix(in hsl, value(--color-fit-high) 50%, value(--color-fit-low))",
      "color-mix(in hsl, value(--color-fit-high) 100%, value(--color-fit-low))",
    ]);
  });

  it("fills a pill green from its left edge, clipped to the pill", () => {
    const { ctx, calls } = recordingContext();
    const pill: PillEntry = {
      type: "pill",
      kind: "normal",
      voice: 0,
      line: 0,
      note: 0,
      x: 10,
      y: 5,
      width: 40,
      height: 12,
      fill: "white",
      dashed: false,
      outline: "--color-ink",
      outlineWidth: 2.5,
      match: { share: 0.25, width: 10 },
      matchColour: "--color-green",
      lyric: { text: "la", x: 10, y: 30, italic: false },
    };
    createEditorPainter(ctx, colour).paintDetail([pill], size);
    const names = calls.map((c) => c[0]);
    const clip = names.indexOf("clip");
    expect(clip).toBeGreaterThan(-1);
    expect(calls.slice(clip)).toContainEqual(["fillRect", 10, 5, 10, 12]);
    expect(calls).toContainEqual(["fillText", "la", 10, 30]);
    expect(calls[0]).toEqual(["setTransform", 2, 0, 0, 2, 0, 0]);
  });
});
