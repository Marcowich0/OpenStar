import { describe, expect, it, vi } from "vitest";

import type { Note } from "../../generated/Note";
import type { TokenRef } from "../../theme/tokens";
import type {
  BackgroundEntry,
  DrawList,
  HeadBallEntry,
  LaneEntry,
  ParticleEntry,
  PillEntry,
  PitchLineEntry,
  PauseHintEntry,
  PlayheadEntry,
  TimeLeftEntry,
  TitleCardEntry,
  TracePoint,
} from "./frame";
import { coverTransform, createPainter, referenceTransform } from "./painter";
import painterSource from "./painter.ts?raw";

type Call = [string, ...unknown[]];

/** A 2D context that records every call and property write, in order. */
function recordingContext(width = 3840, height = 2160) {
  const calls: Call[] = [];
  const gradients: { stops: [number, string][] }[] = [];
  const radials: { args: unknown[]; stops: [number, string][] }[] = [];
  const target: Record<string, unknown> = {
    canvas: { width, height },
    // Every text is 10 px wide per character.
    measureText: (text: string) => {
      calls.push(["measureText", text]);
      return { width: 10 * text.length };
    },
    createRadialGradient: (...args: unknown[]) => {
      calls.push(["createRadialGradient", ...args]);
      const gradient = {
        args,
        stops: [] as [number, string][],
        addColorStop(offset: number, colour: string) {
          gradient.stops.push([offset, colour]);
        },
      };
      radials.push(gradient);
      return gradient;
    },
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
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    calls,
    gradients,
    radials,
  };
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
  radius: 40,
  colour: "cherry",
  lost: null,
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
  star: null,
  shimmer: null,
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

describe("coverTransform", () => {
  it("scales the reference frame uniformly to cover the screen, centred", () => {
    expect(coverTransform(1920, 1080, 0.25)).toEqual({
      scale: 0.25,
      x: 0,
      y: 0,
    });
    // A 16:10 screen: the frame is cropped left and right, not letterboxed.
    expect(coverTransform(1280, 800, 1)).toEqual({
      scale: 800 / 1080,
      x: (1280 - (1920 * 800) / 1080) / 2,
      y: 0,
    });
  });
});

const blobs: BackgroundEntry = {
  type: "background",
  kind: "blobs",
  base: "--color-cream",
  blobs: [
    { x: 300, y: 200, radius: 500, colour: "cherry", alpha: 0.7 },
    { x: 1500, y: 800, radius: 520, colour: "--color-slate", alpha: 0.7 },
    { x: 900, y: 600, radius: 480, colour: "cherry", alpha: 0.7 },
  ],
};

describe("the background painter", () => {
  const small = referenceTransform(480, 270, 1);

  it("fills the whole canvas with the base, then each blob as a soft radial gradient at its alpha", () => {
    const { ctx, calls } = recordingContext(480, 270);
    createPainter(ctx, colour, "background").paint([blobs], small);
    expect(calls.slice(0, 4)).toEqual([
      ["setTransform", 1, 0, 0, 1, 0, 0],
      ["set", "globalAlpha", 1],
      ["set", "fillStyle", "value(--color-cream)"],
      ["fillRect", 0, 0, 480, 270],
    ]);
    // Each blob: a unit gradient moved and scaled onto it.
    const placed = calls.filter(([op]) => op === "setTransform").slice(1);
    expect(placed).toEqual([
      ["setTransform", 0.25 * 500, 0, 0, 0.25 * 500, 0.25 * 300, 0.25 * 200],
      ["setTransform", 0.25 * 520, 0, 0, 0.25 * 520, 0.25 * 1500, 0.25 * 800],
      ["setTransform", 0.25 * 480, 0, 0, 0.25 * 480, 0.25 * 900, 0.25 * 600],
    ]);
    expect(calls.filter(([op]) => op === "fillRect").slice(1)).toEqual([
      ["fillRect", -1, -1, 2, 2],
      ["fillRect", -1, -1, 2, 2],
      ["fillRect", -1, -1, 2, 2],
    ]);
    expect(calls).toContainEqual(["set", "globalAlpha", 0.7]);
  });

  it("makes one gradient per colour, fading to a clear stop of the same colour", () => {
    const { ctx, radials } = recordingContext(480, 270);
    const painter = createPainter(ctx, colour, "background");
    painter.paint([blobs], small);
    painter.paint(
      [{ ...blobs, blobs: blobs.blobs.map((b) => ({ ...b, x: b.x + 1 })) }],
      small,
    );
    expect(radials).toHaveLength(2);
    expect(radials[0]?.args).toEqual([0, 0, 0, 0, 0, 1]);
    expect(radials[0]?.stops[0]).toEqual([0, "value(cherry)"]);
    expect(radials[0]?.stops.at(-1)).toEqual([
      1,
      "color-mix(in srgb, value(cherry) 1%, transparent)",
    ]);
  });

  it("repaints only when the background changed: still blobs or a paused Song cost nothing", () => {
    const { ctx, calls } = recordingContext(480, 270);
    const painter = createPainter(ctx, colour, "background");
    painter.paint([blobs], small);
    const first = calls.length;
    painter.paint(
      [{ ...blobs, blobs: blobs.blobs.map((b) => ({ ...b })) }],
      small,
    );
    expect(calls).toHaveLength(first);
    const moved = blobs.blobs.map((b, i) =>
      i === 1 ? { ...b, y: b.y + 0.5 } : b,
    );
    painter.paint([{ ...blobs, blobs: moved }], small);
    expect(calls.length).toBeGreaterThan(first);
    const again = calls.length;
    painter.paint(
      [{ ...blobs, blobs: moved }],
      referenceTransform(960, 540, 1),
    );
    expect(calls.length).toBeGreaterThan(again);
  });

  it("clears its canvas once for a video or an image, which the DOM shows", () => {
    const { ctx, calls } = recordingContext(480, 270);
    const painter = createPainter(ctx, colour, "background");
    painter.paint([blobs], small);
    calls.length = 0;
    painter.paint([{ type: "background", kind: "video" }, lane, pill], small);
    expect(calls).toEqual([
      ["setTransform", 1, 0, 0, 1, 0, 0],
      ["clearRect", 0, 0, 480, 270],
    ]);
    calls.length = 0;
    painter.paint([{ type: "background", kind: "video" }], small);
    painter.paint([], small);
    expect(calls).toEqual([]);
  });

  it("draws nothing but the background", () => {
    const { ctx, calls } = recordingContext(480, 270);
    createPainter(ctx, colour, "background").paint(
      [lane, pill, playhead, dot, { type: "laneEnd", lane: 0 }],
      small,
    );
    expect(calls).toEqual([
      ["setTransform", 1, 0, 0, 1, 0, 0],
      ["clearRect", 0, 0, 480, 270],
    ]);
  });
});

const dot: ParticleEntry = {
  type: "particle",
  x: 300,
  y: 200,
  size: 12,
  shape: "dot",
  colour: "--color-red",
  rotation: 1,
  alpha: 0.5,
};

describe("the effects painter", () => {
  it("clears its canvas, then fills a dot particle as a circle at its alpha", () => {
    const { ctx, calls } = recordingContext();
    createPainter(ctx, colour, "effects").paint([dot], view);
    expect(calls).toEqual([
      ["setTransform", 1, 0, 0, 1, 0, 0],
      ["clearRect", 0, 0, 3840, 2160],
      ["setTransform", 2, 0, 0, 2, 0, 0],
      ["set", "globalAlpha", 0.5],
      ["set", "fillStyle", "value(--color-red)"],
      ["beginPath"],
      ["arc", 300, 200, 6, 0, 2 * Math.PI],
      ["fill"],
      ["set", "globalAlpha", 1],
    ]);
  });

  it("fills a star particle as a five-pointed path turned by its rotation", () => {
    const { ctx, calls } = recordingContext();
    createPainter(ctx, colour, "effects").paint(
      [{ ...dot, shape: "star", rotation: Math.PI / 2, alpha: 1 }],
      view,
    );
    const path = calls.filter(([op]) => op === "moveTo" || op === "lineTo");
    expect(path).toHaveLength(10);
    // The first point, turned a quarter clockwise from straight up: right.
    const [, x, y] = path[0] as [string, number, number];
    expect(x).toBeCloseTo(306, 6);
    expect(y).toBeCloseTo(200, 6);
    expect(calls).toContainEqual(["closePath"]);
    expect(calls).toContainEqual(["fill"]);
  });

  it("draws nothing but particles", () => {
    const { ctx, calls } = recordingContext();
    createPainter(ctx, colour, "effects").paint(
      [lane, pill, playhead, { type: "laneEnd", lane: 0 }],
      view,
    );
    expect(calls).toHaveLength(3);
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

  it("strokes a lane's separator and clips the lane's Notes to its Notes area inside its rounded shape until laneEnd", () => {
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
      ["roundRect", 60, 702, 1800, 170, 40],
      ["clip"],
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

  it("draws a golden pill's star as a filled five-pointed path", () => {
    const { ctx, calls } = recordingContext();
    createPainter(ctx, colour).paint(
      [
        {
          ...pill,
          star: { x: 610, y: 810, outer: 6, inner: 3, colour: "--color-white" },
        },
      ],
      view,
    );
    const stroke = calls.findIndex(([name]) => name === "stroke");
    const star = calls.slice(stroke + 1);
    expect(star[0]).toEqual(["beginPath"]);
    // The top point first, then nine more corners.
    expect(star[1]).toEqual(["moveTo", 610, 804]);
    expect(star.filter(([name]) => name === "lineTo")).toHaveLength(9);
    expect(star.slice(-3)).toEqual([
      ["closePath"],
      ["set", "fillStyle", "value(--color-white)"],
      ["fill"],
    ]);
  });

  it("sweeps a shimmer band clipped to its pill, with one cached gradient per band width", () => {
    const { ctx, calls, gradients } = recordingContext();
    const shining: PillEntry = {
      ...pill,
      shimmer: { x: 620, width: 48, colour: "--color-white", alpha: 0.6 },
    };
    const painter = createPainter(ctx, colour);
    painter.paint([shining, { ...shining, x: 900 }], view);
    painter.paint([shining], view);
    expect(gradients).toHaveLength(1);
    expect(gradients[0]?.stops).toEqual([
      [0, "color-mix(in srgb, value(--color-white) 1%, transparent)"],
      [0.5, "value(--color-white)"],
      [1, "color-mix(in srgb, value(--color-white) 1%, transparent)"],
    ]);
    expect(calls).toContainEqual(["createLinearGradient", 0, 0, 48, 0]);
    const drawn = calls.filter(([name]) => name !== "createLinearGradient");
    const save = drawn.findIndex(([name]) => name === "save");
    // The band is clipped to the pill's own path, which the outline reuses.
    expect(drawn.slice(save - 3, save + 9)).toEqual([
      ["roundRect", 600, 800, 79.2, 20, 10],
      ["set", "fillStyle", "value(--color-white)"],
      ["fill"],
      ["save"],
      ["clip"],
      ["translate", 620, 800],
      ["set", "globalAlpha", 0.6],
      ["set", "fillStyle", gradients[0]],
      ["fillRect", 0, 0, 48, 20],
      ["set", "globalAlpha", 1],
      ["restore"],
      // The outline goes over the band.
      ["set", "strokeStyle", "value(--color-ink)"],
    ]);
  });

  it("strokes the pitch grid as faint horizontal lines across the Notes area", () => {
    const { ctx, calls } = recordingContext();
    createPainter(ctx, colour).paint(
      [
        {
          type: "grid",
          lane: 0,
          left: 320,
          right: 1860,
          ys: [850, 820],
          colour: "--color-ink",
          alpha: 0.07,
          width: 2,
        },
      ],
      view,
    );
    expect(calls.slice(3)).toEqual([
      ["set", "globalAlpha", 0.07],
      ["set", "strokeStyle", "value(--color-ink)"],
      ["set", "lineWidth", 2],
      ["set", "lineCap", "butt"],
      ["setLineDash", []],
      ["beginPath"],
      ["moveTo", 320, 850],
      ["lineTo", 1860, 850],
      ["moveTo", 320, 820],
      ["lineTo", 1860, 820],
      ["stroke"],
      ["set", "globalAlpha", 1],
    ]);
  });

  it("draws the progress bar as a half-transparent track and a yellow fill, full radius", () => {
    const { ctx, calls } = recordingContext();
    createPainter(ctx, colour).paint(
      [
        {
          type: "progress",
          x: 80,
          y: 20,
          width: 1760,
          height: 10,
          fraction: 0.25,
          track: "--color-white",
          trackAlpha: 0.5,
          fill: "--color-yellow",
        },
      ],
      view,
    );
    expect(calls.slice(3)).toEqual([
      ["set", "globalAlpha", 0.5],
      ["set", "fillStyle", "value(--color-white)"],
      ["beginPath"],
      ["roundRect", 80, 20, 1760, 10, 5],
      ["fill"],
      ["set", "globalAlpha", 1],
      ["set", "fillStyle", "value(--color-yellow)"],
      ["beginPath"],
      ["roundRect", 80, 20, 440, 10, 5],
      ["fill"],
    ]);
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

  it("washes a lost lane in its grey before clipping its Notes", () => {
    const { ctx, calls } = recordingContext();
    createPainter(ctx, colour).paint(
      [{ ...lane, lost: { colour: "--color-slate", alpha: 0.55, radius: 40 } }],
      view,
    );
    const wash = calls.findIndex(([name]) => name === "roundRect");
    expect(calls.slice(wash - 3, wash + 3)).toEqual([
      ["set", "globalAlpha", 0.55],
      ["set", "fillStyle", "value(--color-slate)"],
      ["beginPath"],
      ["roundRect", 60, 702, 1800, 170, 40],
      ["fill"],
      ["set", "globalAlpha", 1],
    ]);
    expect(wash).toBeLessThan(calls.findIndex(([name]) => name === "clip"));
  });

  it("strokes a pitch line's hits in the Party colour over an ink edge, and misses thin", () => {
    const point = (x: number, hit: boolean): TracePoint => ({
      songTime: x,
      pitch: 0,
      x,
      y: 800,
      hit,
      guessed: false,
    });
    const line: PitchLineEntry = {
      type: "pitchLine",
      lane: 0,
      // Hit 10 → 20 → 30, miss 30 → 40, hit 40 → 50.
      points: [
        point(10, true),
        point(20, true),
        point(30, true),
        point(40, false),
        point(50, true),
      ],
      hit: { colour: "cherry", width: 12, edge: "--color-ink", edgeWidth: 17 },
      miss: { colour: "--color-ink", alpha: 0.22, width: 6.6 },
    };
    const { ctx, calls } = recordingContext();
    createPainter(ctx, colour).paint([line], view);
    const strokes = (style: string, width: number) => {
      const start = calls.findIndex(
        (c, i) =>
          c[1] === "strokeStyle" &&
          c[2] === style &&
          calls[i + 1]?.[2] === width,
      );
      const end = calls.findIndex((c, i) => i > start && c[0] === "stroke");
      return calls.slice(start, end + 1).filter(([n]) => n !== "set");
    };
    const hitPath = [
      ["beginPath"],
      ["moveTo", 10, 800],
      ["lineTo", 20, 800],
      ["lineTo", 30, 800],
      ["moveTo", 40, 800],
      ["lineTo", 50, 800],
      ["stroke"],
    ];
    expect(strokes("value(--color-ink)", 17).slice(1)).toEqual(hitPath);
    expect(strokes("value(cherry)", 12).slice(1)).toEqual(hitPath);
    expect(strokes("value(--color-ink)", 6.6).slice(1)).toEqual([
      ["beginPath"],
      ["moveTo", 30, 800],
      ["lineTo", 40, 800],
      ["stroke"],
    ]);
    // The edge goes down first, under the coloured stroke; caps and joins round.
    const order = calls.filter((c) => c[1] === "lineWidth").map((c) => c[2]);
    expect(order.indexOf(17)).toBeLessThan(order.indexOf(12));
    expect(calls).toContainEqual(["set", "lineCap", "round"]);
    expect(calls).toContainEqual(["set", "lineJoin", "round"]);
    expect(calls).toContainEqual(["set", "globalAlpha", 0.22]);
  });

  it("draws a one-point pitch line as a dot", () => {
    const { ctx, calls } = recordingContext();
    createPainter(ctx, colour).paint(
      [
        {
          type: "pitchLine",
          lane: 0,
          points: [
            { songTime: 1, pitch: 0, x: 5, y: 6, hit: true, guessed: false },
          ],
          hit: {
            colour: "cherry",
            width: 12,
            edge: "--color-ink",
            edgeWidth: 17,
          },
          miss: { colour: "--color-ink", alpha: 0.22, width: 6.6 },
        },
      ],
      view,
    );
    expect(calls).toContainEqual(["moveTo", 5, 6]);
    expect(calls).toContainEqual(["lineTo", 5, 6]);
  });

  it("fills the head ball in the Party colour with a white rim, squashed by its bounce", () => {
    const ball: HeadBallEntry = {
      type: "headBall",
      lane: 0,
      x: 600,
      y: 780,
      pitch: 0,
      radius: 14,
      colour: "cherry",
      rim: "--color-white",
      rimWidth: 3,
      squash: { x: 1.1, y: 1 / 1.1 },
    };
    const { ctx, calls } = recordingContext();
    createPainter(ctx, colour).paint([ball], view);
    expect(calls.slice(3)).toEqual([
      ["beginPath"],
      ["ellipse", 600, 780, 14 * 1.1, 14 / 1.1, 0, 0, 2 * Math.PI],
      ["set", "fillStyle", "value(cherry)"],
      ["fill"],
      ["set", "strokeStyle", "value(--color-white)"],
      ["set", "lineWidth", 3],
      ["setLineDash", []],
      ["stroke"],
    ]);
  });

  const titleCard: TitleCardEntry = {
    type: "titleCard",
    x: 80,
    y: 52,
    height: 104,
    maxWidth: 760,
    paddingRight: 36,
    fill: "--color-white",
    alpha: 0.94,
    ledge: "--color-lane-ledge",
    ledgeDepth: 6,
    cover: {
      x: 92,
      y: 64,
      size: 80,
      radius: 18,
      url: "/cover.jpg",
      tile: "navy",
      rim: "--color-white",
      rimWidth: 4,
      letter: null,
    },
    title: {
      text: "Made-up Song",
      x: 192,
      y: 102,
      size: 34,
      weight: 700,
      colour: "--color-ink",
    },
    artist: {
      text: "Nobody",
      x: 192,
      y: 136,
      size: 26,
      weight: 500,
      colour: "--color-ink-2",
    },
  };

  it("sizes the title card's pill to its longer text, over its ledge, with the cover's tile inside a white rim", () => {
    const { ctx, calls } = recordingContext();
    createPainter(ctx, colour).paint([titleCard], view);
    // 192 - 80 + 120 (12 characters) + 36.
    const width = 268;
    expect(calls).toContainEqual(["roundRect", 80, 58, width, 104, 52]);
    expect(calls).toContainEqual(["roundRect", 80, 52, width, 104, 52]);
    expect(calls).toContainEqual(["set", "globalAlpha", 0.94]);
    expect(calls).toContainEqual(["roundRect", 92, 64, 80, 80, 18]);
    expect(calls).toContainEqual(["set", "fillStyle", "value(navy)"]);
    expect(calls).toContainEqual(["roundRect", 96, 68, 72, 72, 14]);
    // Without a loaded image, the tile is all there is.
    expect(calls.some(([op]) => op === "drawImage")).toBe(false);
    expect(calls).toContainEqual([
      "set",
      "font",
      "700 34px value(--font-sans)",
    ]);
    expect(calls).toContainEqual(["fillText", "Made-up Song", 192, 102, 120]);
    expect(calls).toContainEqual(["fillText", "Nobody", 192, 136, 120]);
  });

  it("caps the title card at its widest and squeezes the text into it", () => {
    const { ctx, calls } = recordingContext();
    const long = { ...titleCard.title, text: "A".repeat(100) };
    createPainter(ctx, colour).paint([{ ...titleCard, title: long }], view);
    expect(calls).toContainEqual(["roundRect", 80, 52, 760, 104, 52]);
    expect(calls).toContainEqual(["fillText", long.text, 192, 102, 612]);
  });

  it("draws the loaded cover over its tile, cropped square from the middle and clipped to the tile", () => {
    const { ctx, calls } = recordingContext();
    const image = { naturalWidth: 400, naturalHeight: 300 } as HTMLImageElement;
    const images = vi.fn((url: string) =>
      url === "/cover.jpg" ? image : null,
    );
    createPainter(ctx, colour, "lanes", images).paint([titleCard], view);
    expect(images).toHaveBeenCalledWith("/cover.jpg");
    const tile = calls.findIndex((c) => c[0] === "roundRect" && c[1] === 96);
    const drawn = calls.findIndex(([op]) => op === "drawImage");
    expect(drawn).toBeGreaterThan(tile);
    expect(calls.slice(tile, drawn)).toContainEqual(["clip"]);
    expect(calls[drawn]).toEqual([
      "drawImage",
      image,
      50,
      0,
      300,
      300,
      96,
      68,
      72,
      72,
    ]);
  });

  it("draws a generated cover's letter over the image, centred, over its shadow", () => {
    const { ctx, calls } = recordingContext();
    const image = { naturalWidth: 100, naturalHeight: 100 } as HTMLImageElement;
    const letter = {
      text: "M",
      x: 132,
      y: 104,
      size: 29,
      weight: 700,
      colour: "--color-white",
      shadow: "--color-ink",
      shadowAlpha: 0.25,
      shadowDy: 2,
    } as const;
    createPainter(ctx, colour, "lanes", () => image).paint(
      [{ ...titleCard, cover: { ...titleCard.cover, letter } }],
      view,
    );
    const drawn = calls.findIndex(([op]) => op === "drawImage");
    const shadow = calls.findIndex(
      (c) => c[0] === "fillText" && c[1] === "M" && c[3] === 106,
    );
    const face = calls.findIndex(
      (c) => c[0] === "fillText" && c[1] === "M" && c[3] === 104,
    );
    expect(shadow).toBeGreaterThan(drawn);
    expect(face).toBeGreaterThan(shadow);
    expect(calls[shadow]).toEqual(["fillText", "M", 132, 106]);
    const before = calls.slice(drawn, face);
    expect(before).toContainEqual(["set", "textAlign", "center"]);
    expect(before).toContainEqual(["set", "textBaseline", "middle"]);
    expect(before).toContainEqual([
      "set",
      "font",
      "700 29px value(--font-sans)",
    ]);
    expect(before).toContainEqual(["set", "fillStyle", "value(--color-ink)"]);
    expect(before).toContainEqual(["set", "globalAlpha", 0.25]);
    expect(calls.slice(shadow, face)).toContainEqual([
      "set",
      "fillStyle",
      "value(--color-white)",
    ]);
  });

  it("draws the pause hint as an ink pill around its text", () => {
    const { ctx, calls } = recordingContext();
    const hint: PauseHintEntry = {
      type: "pauseHint",
      x: 80,
      y: 176,
      height: 48,
      padding: 22,
      fill: "--color-ink",
      text: {
        text: "Space: pause",
        x: 102,
        y: 208,
        size: 24,
        weight: 600,
        colour: "--color-white",
      },
    };
    createPainter(ctx, colour).paint([hint], view);
    expect(calls).toContainEqual(["set", "fillStyle", "value(--color-ink)"]);
    expect(calls).toContainEqual(["roundRect", 80, 176, 164, 48, 24]);
    expect(calls.at(-1)).toEqual(["fillText", "Space: pause", 102, 208]);
  });

  it("outlines the time left in ink under its white text, right-aligned and centred", () => {
    const { ctx, calls } = recordingContext();
    const label: TimeLeftEntry = {
      type: "timeLeft",
      text: {
        text: "2:41",
        x: 1840,
        y: 25,
        size: 28,
        weight: 700,
        colour: "--color-white",
      },
      outline: "--color-ink",
      outlineWidth: 6,
    };
    createPainter(ctx, colour).paint([label], view);
    expect(calls).toContainEqual(["set", "textAlign", "right"]);
    expect(calls).toContainEqual(["set", "textBaseline", "middle"]);
    const stroke = calls.findIndex(([op]) => op === "strokeText");
    const fill = calls.findIndex(([op]) => op === "fillText");
    expect(calls[stroke]).toEqual(["strokeText", "2:41", 1840, 25]);
    expect(calls[fill]).toEqual(["fillText", "2:41", 1840, 25]);
    expect(stroke).toBeLessThan(fill);
    expect(calls).toContainEqual(["set", "lineWidth", 6]);
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

  it("leaves particles to the effects canvas", () => {
    const { ctx, calls } = recordingContext();
    createPainter(ctx, colour).paint([dot], view);
    expect(calls).toHaveLength(3);
  });

  it("leaves the background to the background canvas", () => {
    const { ctx, calls } = recordingContext();
    createPainter(ctx, colour).paint([blobs], view);
    expect(calls).toHaveLength(3);
  });

  it("holds no game logic: it imports nothing but types", () => {
    const imports = [...painterSource.matchAll(/^import\s+(type\s+)?.*$/gm)];
    expect(imports.length).toBeGreaterThan(0);
    for (const [line, typeOnly] of imports) {
      expect(typeOnly, line).toBe("type ");
    }
  });
});
