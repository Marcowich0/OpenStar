/**
 * The Song clock: a pure model of Song time fed with observations.
 *
 * `songTime()` is the Song position (seconds of audio, never Beats) that the
 * browser reports reaching the speakers and screen at the current Stage time.
 * The model is `anchorPosition + (now − anchorStageTime) × rate`, re-anchored
 * from frame callbacks (with video) or `currentTime` samples (audio only).
 *
 * The clock owns no media element. Whoever owns the element forwards its
 * observations here: frame callbacks, `currentTime` samples, and play, pause,
 * stall, seek and rate events. The Timing editor reuses this module with other
 * rates.
 *
 * Stage time is in milliseconds (`performance.now()`, `expectedDisplayTime`);
 * Song time is in seconds.
 */

export const SONG_CLOCK = {
  /** A drift between model and observations above this is snapped, below it slewed. */
  snapThresholdS: 0.05,
  /** While slewing, Song time runs at most this fraction faster or slower than the rate. */
  maxSlew: 0.05,
  /** Drift below this is left alone. */
  deadbandS: 0.0005,
  /** Observations from this far back decide where the media really is. */
  observationWindowMs: 1000,
  /** How far back `songTimeAt` answers. */
  historyMs: 5000,
} as const;

/** Where the Song clock reads the media's position from. */
export type ClockMedia = "video" | "audio";

/** A `requestVideoFrameCallback` callback's metadata, as the browser gives it. */
export interface FrameObservation {
  /** The shown frame's media position, seconds. */
  mediaTime: number;
  /** Stage time (ms) at which the browser expects the frame on screen. */
  expectedDisplayTime: number;
}

/** A sample of the media element's `currentTime`. */
export interface CurrentTimeObservation {
  /** The media element's `currentTime`, seconds. */
  currentTime: number;
  /**
   * Stage time (ms) at which that position reaches the output: the time it
   * was read plus the output latency the browser reports.
   */
  stageTime: number;
}

export interface SongClockOptions {
  /** `video`: re-anchor from frame callbacks; `audio`: from `currentTime` samples. */
  media: ClockMedia;
  /** The Stage clock, in milliseconds. Defaults to `performance.now()`. */
  now?: () => number;
}

export interface SongClock {
  /** Song time at the current Stage time, seconds. */
  songTime(): number;
  /**
   * Song time at a past Stage time `stageTime` (ms) within the last
   * `SONG_CLOCK.historyMs`; `null` when the clock cannot answer (too old,
   * before the clock existed, or in the future).
   */
  songTimeAt(stageTime: number): number | null;
  /** The rate set by `setRate` (1 unless changed). */
  readonly rate: number;
  /** Whether the clock is running (played, not paused or stalled). */
  readonly playing: boolean;

  observeFrame(frame: FrameObservation): void;
  observeCurrentTime(sample: CurrentTimeObservation): void;
  /** The media started or resumed playing. */
  play(): void;
  /** The media was paused: Song time freezes. */
  pause(): void;
  /** The media stalled (`waiting`): Song time freezes like a pause. */
  stall(): void;
  /** The media seeked (Restart): Song time re-anchors at `position`, seconds. */
  seek(position: number): void;
  /** Song time advances at `rate` from now on, without a jump. */
  setRate(rate: number): void;
}

/** From `start` (Stage ms) on, Song time is `position + elapsed × rate`. */
interface Segment {
  start: number;
  position: number;
  rate: number;
}

interface Sample {
  stageTime: number;
  /** Song time at Stage time 0 implied by the observation, at the current rate. */
  intercept: number;
}

export function createSongClock(options: SongClockOptions): SongClock {
  const now = options.now ?? (() => performance.now());
  const media = options.media;
  const createdAt = now();

  let rate = 1;
  let playing = false;
  /** Sorted by start. May hold one future segment: where a slew or hold ends. */
  let segments: Segment[] = [{ start: createdAt, position: 0, rate: 0 }];
  let samples: Sample[] = [];

  function positionAt(t: number): number | null {
    let found: Segment | undefined;
    for (const segment of segments) {
      if (segment.start > t) break;
      found = segment;
    }
    if (!found) return null;
    return found.position + ((t - found.start) / 1000) * found.rate;
  }

  function current(): number {
    return positionAt(now()) ?? 0;
  }

  /** Replaces everything from `at` on with the given segments. */
  function anchor(at: number, ...next: Segment[]) {
    segments = segments.filter((segment) => segment.start < at);
    segments.push(...next);
    const oldest = at - SONG_CLOCK.historyMs;
    while (segments.length > 1 && segments[1].start <= oldest) {
      segments.shift();
    }
  }

  function observe(position: number, stageTime: number) {
    if (!playing || !Number.isFinite(position) || !Number.isFinite(stageTime)) {
      return;
    }
    const t = now();
    samples.push({
      stageTime,
      intercept: position - (rate * stageTime) / 1000,
    });
    const oldest = t - SONG_CLOCK.observationWindowMs;
    samples = samples.filter((sample) => sample.stageTime >= oldest);
    if (samples.length === 0) return;

    // A media position is reported late (frames and `currentTime` step), never
    // early, so the observations' upper envelope is where the media is.
    const intercept = Math.max(...samples.map((sample) => sample.intercept));
    const position_ = current();
    const drift = intercept + (rate * t) / 1000 - position_;

    if (drift > SONG_CLOCK.snapThresholdS) {
      anchor(t, { start: t, position: position_ + drift, rate });
    } else if (drift < -SONG_CLOCK.snapThresholdS) {
      // Song time never runs backwards while playing: hold until the media catches up.
      const holdMs = (-drift / rate) * 1000;
      anchor(
        t,
        { start: t, position: position_, rate: 0 },
        { start: t + holdMs, position: position_, rate },
      );
    } else if (Math.abs(drift) < SONG_CLOCK.deadbandS) {
      anchor(t, { start: t, position: position_, rate });
    } else {
      const slew = Math.sign(drift) * SONG_CLOCK.maxSlew * rate;
      const slewMs = (drift / slew) * 1000;
      anchor(
        t,
        { start: t, position: position_, rate: rate + slew },
        {
          start: t + slewMs,
          position: position_ + drift + (rate * slewMs) / 1000,
          rate,
        },
      );
    }
  }

  function freeze() {
    if (!playing) return;
    const t = now();
    anchor(t, { start: t, position: current(), rate: 0 });
    playing = false;
    samples = [];
  }

  return {
    songTime: current,
    songTimeAt(stageTime) {
      const t = now();
      if (stageTime > t || stageTime < t - SONG_CLOCK.historyMs) return null;
      return positionAt(stageTime);
    },
    get rate() {
      return rate;
    },
    get playing() {
      return playing;
    },
    observeFrame(frame) {
      if (media === "video")
        observe(frame.mediaTime, frame.expectedDisplayTime);
    },
    observeCurrentTime(sample) {
      if (media === "audio") observe(sample.currentTime, sample.stageTime);
    },
    play() {
      if (playing) return;
      const t = now();
      anchor(t, { start: t, position: current(), rate });
      playing = true;
      samples = [];
    },
    pause: freeze,
    stall: freeze,
    seek(position) {
      const t = now();
      anchor(t, { start: t, position, rate: playing ? rate : 0 });
      samples = [];
    },
    setRate(next) {
      if (!(next > 0) || !Number.isFinite(next)) {
        throw new RangeError(`Song clock rate must be positive, got ${next}`);
      }
      const t = now();
      if (playing) anchor(t, { start: t, position: current(), rate: next });
      rate = next;
      samples = [];
    },
  };
}
