/**
 * The Check A/V sync test pattern as a draw list (v1 spec #53, ticket #163):
 * a ball bouncing on a lane line once a second. It is a pure function of the
 * clicks' landing times, the Stage time to draw and the A/V offset, so tests
 * check it without pixels; the sing screen's painter (`createPainter`) draws
 * it, from the same entry types as a lane.
 *
 * The ball touches the line when the shifted clock (`nowMs − offsetMs`) is at
 * a landing time: each click's reported output time on the Stage's clock
 * (`outputTime`). With a positive offset the sound reaches the room later
 * than the picture, so the ball lands that much later too.
 *
 * Coordinates are in a 1920 × `AV_SYNC_FRAME.height` strip of the reference
 * frame; `avSyncTransform` maps it onto a canvas.
 */

import type { DrawList } from "../stage/sing/frame";
import { DEFAULT_SING_LOOK, laneFill } from "../stage/sing/singLook";

/** The strip the pattern is drawn in, and its parts. */
export const AV_SYNC_FRAME = {
  width: 1920,
  height: 600,
  lane: { x: 60, y: 30, width: 1800, height: 540 },
  /** The lane line the ball lands on. */
  lineY: 490,
  ball: { x: 960, radius: 40 },
  /** How high the ball's bottom rises above the line, halfway between landings. */
  bounce: 360,
  /** One bounce, ms: the clicks come once a second. */
  periodMs: 1000,
} as const;

const SQUARE = { x: 1, y: 1 } as const;

/**
 * Where the ball is between two landings on the shifted clock `t`: 0 on a
 * landing, 0.5 halfway. Before the first and after the last scheduled click
 * it keeps bouncing once a second; with no click yet it rests on the line.
 */
function phase(landings: readonly number[], t: number): number {
  const first = landings[0];
  if (first === undefined) return 0;
  const period = AV_SYNC_FRAME.periodMs;
  let previous = first - period;
  let next = first;
  for (const landing of landings) {
    if (landing <= t) previous = landing;
    else {
      next = landing;
      break;
    }
  }
  if (previous >= next) next = previous + period;
  if (t < previous || t >= next) {
    // Outside the scheduled clicks: the same once-a-second beat.
    const anchor = t < first ? first : previous;
    return ((((t - anchor) % period) + period) % period) / period;
  }
  return (t - previous) / (next - previous);
}

/**
 * The draw list at Stage time `nowMs` for clicks landing at `landingsMs`
 * (ascending, Stage clock ms) and an A/V offset of `offsetMs`.
 */
export function avSyncFrame(
  landingsMs: readonly number[],
  nowMs: number,
  offsetMs: number,
): DrawList {
  const { lane, lineY, ball, bounce } = AV_SYNC_FRAME;
  const p = phase(landingsMs, nowMs - offsetMs);
  const lift = 4 * bounce * p * (1 - p);
  return [
    {
      type: "lane",
      lane: 0,
      ...lane,
      notesX: lane.x,
      radius: 40,
      colour: "sky",
      fill: laneFill(DEFAULT_SING_LOOK),
      lost: null,
      separator: {
        x: lane.x,
        top: lane.y,
        bottom: lane.y,
        colour: "--color-ink",
        alpha: 0,
        width: 0,
      },
    },
    {
      type: "grid",
      lane: 0,
      left: lane.x + 40,
      right: lane.x + lane.width - 40,
      ys: [lineY],
      colour: "--color-ink",
      alpha: 0.6,
      width: 6,
    },
    {
      type: "headBall",
      lane: 0,
      x: ball.x,
      y: lineY - ball.radius - lift,
      pitch: 0,
      radius: ball.radius,
      colour: "cherry",
      rim: "--color-white",
      rimWidth: 6,
      squash: SQUARE,
    },
    { type: "laneEnd", lane: 0 },
  ];
}
