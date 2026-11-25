/**
 * The sing screen's one `requestAnimationFrame` loop. Each frame it reads the
 * time to draw in exactly one place (`songTime()` minus the Stage's A/V
 * offset), computes the draw list with the pure `frame()` and hands it to the
 * painter. Nothing else in the frontend reads the media element's position.
 *
 * Apart from the draw list itself, a frame allocates nothing: the frame
 * callback is made once, and the lane layout is recomputed only when the
 * Player count changes.
 */

import type { SongClock } from "../../clock/songClock";
import { frame, type DrawList, type SingState } from "./frame";
import { laneLayout, type LaneLayout } from "./laneLayout";

export interface RenderLoopOptions {
  /** The current Song clock (#96). Only its `songTime()` is read. */
  clock: () => Pick<SongClock, "songTime">;
  /** The Stage's A/V offset in seconds; drawing runs this much behind the clock. */
  avOffset: () => number;
  /** The current sing state, read each frame (no React re-render). */
  state: () => SingState;
  /** Turns a draw list into pixels. */
  paint: (list: DrawList) => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

export interface RenderLoop {
  start(): void;
  stop(): void;
  /** Draws one frame now. The loop calls it on every animation frame. */
  step(): void;
}

export function createRenderLoop(options: RenderLoopOptions): RenderLoop {
  const requestFrame =
    options.requestFrame ?? ((cb) => window.requestAnimationFrame(cb));
  const cancelFrame =
    options.cancelFrame ??
    ((handle) => {
      window.cancelAnimationFrame(handle);
    });
  let layout: LaneLayout = [];
  let handle: number | null = null;

  function step() {
    const state = options.state();
    if (layout.length !== state.lanes.length) {
      layout = laneLayout(state.lanes.length);
    }
    // The one place the drawing time is read.
    const drawTime = options.clock().songTime() - options.avOffset();
    options.paint(frame(state, drawTime, layout));
  }

  function onFrame() {
    if (handle === null) return;
    step();
    handle = requestFrame(onFrame);
  }

  return {
    start() {
      if (handle !== null) return;
      handle = requestFrame(onFrame);
    },
    stop() {
      if (handle !== null) cancelFrame(handle);
      handle = null;
    },
    step,
  };
}
