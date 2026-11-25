import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Note } from "../../generated/Note";
import type { ParsedSong } from "../../generated/ParsedSong";
import { singVoices, type SingState } from "./frame";
import { SingScreen } from "./SingScreen";

const notes: Note[] = [4, 8].map((start) => ({
  kind: "normal",
  start,
  length: 2,
  pitch: start,
  text: "la ",
  line: 1,
}));
const song = {
  headers: { gapSeconds: 1, beatsPerMinute: 120 },
  voices: [{ lines: [{ notes, end: null }] }],
} as unknown as ParsedSong;
const state: SingState = {
  grid: { gapSeconds: 1, beatsPerMinute: 120 },
  voices: singVoices(song),
  lanes: [
    { colour: "cherry", voice: 0 },
    { colour: "teal", voice: 0 },
  ],
};

const contexts = new Map<HTMLCanvasElement, string[]>();
let frames: FrameRequestCallback[] = [];
let cancelFrame: ReturnType<typeof vi.spyOn>;

function setWindow(width: number, height: number, ratio: number) {
  Object.assign(window, {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: ratio,
  });
}

beforeEach(() => {
  contexts.clear();
  frames = [];
  setWindow(1920, 1080, 2);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement) {
      const calls: string[] = [];
      contexts.set(this, calls);
      return new Proxy(
        { canvas: this, createLinearGradient: () => ({ addColorStop() {} }) },
        {
          get: (obj, prop: string) =>
            prop in obj
              ? obj[prop as keyof typeof obj]
              : () => calls.push(prop),
          set: () => true,
        },
      ) as unknown as CanvasRenderingContext2D;
    },
  );
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  cancelFrame = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function runFrame() {
  const next = frames.shift();
  act(() => next?.(0));
}

function layers(container: HTMLElement) {
  return [...container.querySelectorAll("[data-layer]")].map((el) =>
    el.getAttribute("data-layer"),
  );
}

describe("SingScreen", () => {
  it("stacks its layers bottom to top: backdrop, panels, lanes, headers and lyrics, effects, overlays", () => {
    const { container } = render(
      <SingScreen
        state={state}
        clock={{ songTime: () => 3 }}
        avOffset={() => 0}
      />,
    );
    expect(layers(container)).toEqual([
      "backdrop",
      "panels",
      "lanes",
      "headers",
      "effects",
      "overlays",
    ]);
  });

  it("renders both canvases at devicePixelRatio and resizes them with the window", () => {
    const { container } = render(
      <SingScreen
        state={state}
        clock={{ songTime: () => 3 }}
        avOffset={() => 0}
      />,
    );
    const canvases = [...container.querySelectorAll("canvas")];
    expect(canvases).toHaveLength(2);
    for (const canvas of canvases) {
      expect([canvas.width, canvas.height]).toEqual([3840, 2160]);
    }
    act(() => {
      setWindow(1280, 720, 1.5);
      window.dispatchEvent(new Event("resize"));
    });
    for (const canvas of canvases) {
      expect([canvas.width, canvas.height]).toEqual([1920, 1080]);
    }
  });

  it("places one frosted panel per lane, from the lane layout", () => {
    const { container } = render(
      <SingScreen
        state={state}
        clock={{ songTime: () => 3 }}
        avOffset={() => 0}
      />,
    );
    const panels = container.querySelectorAll<HTMLElement>("[data-lane-panel]");
    expect(panels).toHaveLength(2);
    expect(panels[1]?.style).toMatchObject({
      left: "60px",
      top: "732px",
      width: "1800px",
      height: "140px",
    });
  });

  it("paints the lanes canvas on each animation frame and marks the screen painted", () => {
    const { container } = render(
      <SingScreen
        state={state}
        clock={{ songTime: () => 3 }}
        avOffset={() => 0}
      />,
    );
    const root = container.querySelector<HTMLElement>("[data-sing-screen]");
    expect(root?.dataset.painted).toBeUndefined();
    runFrame();
    const lanesCanvas = container.querySelector<HTMLCanvasElement>(
      'canvas[data-layer="lanes"]',
    );
    const calls = lanesCanvas ? contexts.get(lanesCanvas) : undefined;
    expect(calls?.filter((c) => c === "roundRect")).toHaveLength(4);
    expect(root?.dataset.painted).toBe("true");
    expect(frames).toHaveLength(1); // the next frame is asked for
  });

  it("stops the loop when it unmounts", () => {
    const { unmount } = render(
      <SingScreen
        state={state}
        clock={{ songTime: () => 3 }}
        avOffset={() => 0}
      />,
    );
    unmount();
    expect(cancelFrame).toHaveBeenCalled();
  });
});
