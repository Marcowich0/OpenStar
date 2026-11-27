/**
 * The one mapping from `AudioContext` time to the Stage's clock (#53, "One
 * mapping from AudioContext time to the Stage's clock"). Anything scheduled on
 * an `AudioContext` (Calibration tones, the Check A/V sync click, the Timing
 * editor's clicks and hums) gets its reported output time from here, so it
 * shares `songTime()`'s reference: what the browser reports reaching the
 * output.
 *
 * It works for any page's `AudioContext`, not only the Stage's.
 */

/** The part of an `AudioContext` the mapping reads. */
export type OutputTimestampSource = Pick<AudioContext, "getOutputTimestamp">;

/**
 * The Stage time (ms, `performance.now()`) at which a sound scheduled at
 * `contextTime` (s) on `context` reaches the output, as the browser reports
 * it: `ts.performanceTime + (contextTime − ts.contextTime) × 1000`, with
 * `ts = context.getOutputTimestamp()` read now. Never derived from
 * `currentTime`. `null` while the context reports no output yet (not
 * started, or suspended before its first output).
 */
export function outputTime(
  context: OutputTimestampSource,
  contextTime: number,
): number | null {
  const ts = context.getOutputTimestamp();
  const { contextTime: at, performanceTime } = ts;
  if (at === undefined || performanceTime === undefined) return null;
  if (at === 0 && performanceTime === 0) return null;
  return performanceTime + (contextTime - at) * 1000;
}

/**
 * The same mapping read the other way: the `AudioContext` time (s) whose
 * sound the browser reports reaching the output at Stage time `stageTime`
 * (ms). The Timing editor (#220) schedules its clicks and hums at it, so a
 * Note's sound lands when `songTime()` reaches the Note. `null` like
 * `outputTime`.
 */
export function contextTimeAt(
  context: OutputTimestampSource,
  stageTime: number,
): number | null {
  const ts = context.getOutputTimestamp();
  const { contextTime: at, performanceTime } = ts;
  if (at === undefined || performanceTime === undefined) return null;
  if (at === 0 && performanceTime === 0) return null;
  return at + (stageTime - performanceTime) / 1000;
}
