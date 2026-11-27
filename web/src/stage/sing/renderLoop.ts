/**
 * The sing screen's one `requestAnimationFrame` loop. Each frame it reads the
 * time to draw in exactly one place (`songTime()` minus the Stage's A/V
 * offset), computes the draw list with the pure `frame()` and hands it to the
 * painter. Nothing else in the frontend reads the media element's position.
 *
 * Effects move on real frame time instead (#134): before drawing, the loop
 * advances the state's particle pool and Line rating pops (#216) by the real
 * time since the previous animation frame, whatever the display's refresh
 * rate.
 *
 * Apart from the draw list itself, a frame allocates nothing: the frame
 * callback is made once, the lane layout is recomputed only when the Player
 * count changes, and the particle pool is allocated once.
 */

import type { SongClock } from "../../clock/songClock";
import { GoldenSparkles } from "./effects";
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
  /**
   * The real time in milliseconds that moves the effects, given the
   * animation frame's timestamp; that timestamp by default. A constant
   * freezes them (screenshots).
   */
  frameTime?: (timestamp: number) => number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

export interface RenderLoop {
  start(): void;
  stop(): void;
  /**
   * Draws one frame now, after moving the effects by `delta` real seconds
   * (none by default). The loop calls it on every animation frame.
   */
  step(delta?: number): void;
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
  const sparkles = new GoldenSparkles();
  let handle: number | null = null;
  /** The previous animation frame's time, ms; null on the first frame. */
  let lastFrameTime: number | null = null;

  function step(delta = 0) {
    const state = options.state();
    state.effects?.advance(delta);
    state.ratings?.advance(delta);
    if (layout.length !== state.lanes.length) {
      layout = laneLayout(state.lanes.length);
    }
    // The one place the drawing time is read.
    const drawTime = options.clock().songTime() - options.avOffset();
    const list = frame(state, drawTime, layout);
    // A head ball on a golden Note sparkles; the new particles show from
    // the next frame on.
    if (state.effects) sparkles.emit(list, state.effects, delta);
    options.paint(list);
  }

  function onFrame(timestamp: number) {
    if (handle === null) return;
    const now = options.frameTime ? options.frameTime(timestamp) : timestamp;
    const delta = lastFrameTime === null ? 0 : (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    step(delta);
    handle = requestFrame(onFrame);
  }

  return {
    start() {
      if (handle !== null) return;
      lastFrameTime = null;
      handle = requestFrame(onFrame);
    },
    stop() {
      if (handle !== null) cancelFrame(handle);
      handle = null;
    },
    step,
  };
}
