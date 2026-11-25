import { describe, expect, it, vi } from "vitest";

import type { Note } from "../../generated/Note";
import type { TokenRef } from "../../theme/tokens";
import type { DrawList, LaneEntry, PillEntry, PlayheadEntry } from "./frame";
import { createPainter, referenceTransform } from "./painter";
import painterSource from "./painter.ts?raw";

type Call = [string, ...unknown[]];

/** A 2D context that records every call and property write, in order. */
function recordingContext(width = 3840, height = 2160) {
  const calls: Call[] = [];
  const gradients: { stops: [number, string][] }[] = [];
  const target: Record<string, unknown> = {
    canvas: { width, height },
    createLinearGradient: (...args: unknown[]) => {
      calls.push(["createLinearGradient", ...args]);
      const gradient = {
        stops: [] as [number, string][],
        addColorStop(offset: number, colour: string) {
          gradient.stops.push([offset, colour]);
        },
      };
      gradients.push(gradient);
      return gradient;
    },
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
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, gradients };
}

/** Each token resolves to a recognisable fake value. */
const colour = vi.fn((ref: TokenRef) => `value(${ref})`);

const note: Note = {
  kind: "normal",
  start: 4,
  length: 2,
  pitch: 0,
  text: "la",
  line: 1,
};

const lane: LaneEntry = {
  type: "lane",
  lane: 0,
  x: 60,
  y: 702,
  width: 1800,
  height: 170,
  notesX: 320,
  colour: "cherry",
  separator: {
    x: 318,
    top: 724,
    bottom: 850,
    colour: "--color-ink",
    alpha: 0.12,
    width: 2,
  },
};
const pill: PillEntry = {
  type: "pill",
  lane: 0,
  note,
  kind: "normal",
  passed: false,
  x: 600,
  y: 800,
  width: 79.2,
  height: 20,
  fill: { type: "solid", colour: "--color-white" },
  outline: "--color-ink",
  outlineWidth: 4.5,
  dash: [],
};
const playhead: PlayheadEntry = {
  type: "playhead",
  lane: 0,
  x: 600,
  top: 702,
  bottom: 872,
  colour: "--color-ink",
  alpha: 0.3,
  width: 4,
  dash: [1, 12],
};
const view = referenceTransform(1920, 1080, 2);

describe("referenceTransform", () => {
  it("scales the 1920 × 1080 reference frame uniformly to the screen, in device pixels", () => {
    expect(referenceTransform(1920, 1080, 2)).toEqual({ scale: 2, x: 0, y: 0 });
    expect(referenceTransform(3840, 2160, 1)).toEqual({ scale: 2, x: 0, y: 0 });
    // A wider screen centres the frame horizontally.
    expect(referenceTransform(2560, 1080, 1)).toEqual({
      scale: 1,
      x: 320,
      y: 0,
    });
    expect(referenceTransform(960, 1080, 1)).toEqual({
      scale: 0.5,
      x: 0,
      y: 270,
    });
  });
});

describe("the painter", () => {
  it("clears the canvas, then draws in the reference frame", () => {
    const { ctx, calls } = recordingContext();
    createPainter(ctx, colour).paint([], view);
    expect(calls).toEqual([
      ["setTransform", 1, 0, 0, 1, 0, 0],
      ["clearRect", 0, 0, 3840, 2160],
      ["setTransform", 2, 0, 0, 2, 0, 0],
    ]);
  });

  it("strokes a lane's separator and clips the lane's Notes to its Notes area until laneEnd", () => {
    const { ctx, calls } = recordingContext();
    createPainter(ctx, colour).paint(
      [lane, { type: "laneEnd", lane: 0 }],
      view,
    );
    expect(calls.slice(3)).toEqual([
      ["set", "globalAlpha", 0.12],
      ["set", "strokeStyle", "value(--color-ink)"],
      ["set", "lineWidth", 2],
      ["set", "lineCap", "butt"],
      ["setLineDash", []],
      ["beginPath"],
      ["moveTo", 318, 724],
      ["lineTo", 318, 850],
      ["stroke"],
      ["set", "globalAlpha", 1],
      ["save"],
      ["beginPath"],
      ["rect", 320, 702, 1540, 170],
      ["clip"],
      ["restore"],
    ]);
  });

  it("fills and outlines a pill with full radius and the entry's dash", () => {
    const { ctx, calls } = recordingContext();
    createPainter(ctx, colour).paint([{ ...pill, dash: [9, 9] }], view);
    expect(calls.slice(3)).toEqual([
      ["beginPath"],
      ["roundRect", 600, 800, 79.2, 20, 10],
      ["set", "fillStyle", "value(--color-white)"],
      ["fill"],
      ["set", "strokeStyle", "value(--color-ink)"],
      ["set", "lineWidth", 4.5],
      ["setLineDash", [9, 9]],
      ["stroke"],
    ]);
  });

  it("leaves a hollow pill unfilled", () => {
    const { ctx, calls } = recordingContext();
    createPainter(ctx, colour).paint([{ ...pill, fill: null }], view);
    expect(calls.some(([name]) => name === "fill")).toBe(false);
    expect(calls.some(([name]) => name === "stroke")).toBe(true);
  });

  it("fills a golden pill with a top-to-bottom gradient, made once per pill height", () => {
    const { ctx, calls, gradients } = recordingContext();
    const painter = createPainter(ctx, colour);
    const golden: PillEntry = {
      ...pill,
      fill: {
        type: "vertical",
        top: "--color-golden-top",
        bottom: "--color-golden-bottom",
      },
    };
    painter.paint([golden, { ...golden, x: 900 }], view);
    painter.paint([golden], view);
    expect(gradients).toHaveLength(1);
    expect(gradients[0]?.stops).toEqual([
      [0, "value(--color-golden-top)"],
      [1, "value(--color-golden-bottom)"],
    ]);
    // The gradient runs over the pill's height, placed at the pill's top.
    expect(calls).toContainEqual(["createLinearGradient", 0, 0, 0, 20]);
    expect(calls).toContainEqual(["translate", 600, 800]);
    expect(calls).toContainEqual(["roundRect", 0, 0, 79.2, 20, 10]);
    expect(calls).toContainEqual(["set", "fillStyle", gradients[0]]);
  });

  it("strokes the playhead as a dotted line with round caps", () => {
    const { ctx, calls } = recordingContext();
    createPainter(ctx, colour).paint([playhead], view);
    expect(calls.slice(3)).toEqual([
      ["set", "globalAlpha", 0.3],
      ["set", "strokeStyle", "value(--color-ink)"],
      ["set", "lineWidth", 4],
      ["set", "lineCap", "round"],
      ["setLineDash", [1, 12]],
      ["beginPath"],
      ["moveTo", 600, 702],
      ["lineTo", 600, 872],
      ["stroke"],
      ["set", "globalAlpha", 1],
    ]);
  });

  it("reads each colour from the token reader once per frame", () => {
    const { ctx } = recordingContext();
    const reader = vi.fn((ref: TokenRef) => `value(${ref})`);
    const painter = createPainter(ctx, reader);
    const list: DrawList = [pill, { ...pill, x: 700 }, playhead];
    painter.paint(list, view);
    expect(reader.mock.calls.map(([ref]) => ref).sort()).toEqual([
      "--color-ink",
      "--color-white",
    ]);
    painter.paint(list, view);
    expect(reader).toHaveBeenCalledTimes(4);
  });

  it("holds no game logic: it imports nothing but types", () => {
    const imports = [...painterSource.matchAll(/^import\s+(type\s+)?.*$/gm)];
    expect(imports.length).toBeGreaterThan(0);
    for (const [line, typeOnly] of imports) {
      expect(typeOnly, line).toBe("type ");
    }
  });
});
