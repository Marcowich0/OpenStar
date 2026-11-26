/**
 * The Timing editor's playback (v1 spec #57, "Checking by ear", ticket
 * #220): the Stage's clock module and playback adapter over one media
 * element routed through the page's one `AudioContext`, plus what only the
 * editor does: play from the playhead, seek, the speeds, the clicks and hums
 * (`noteScheduler.ts`) and Loop a Line (`loop.ts`).
 *
 * The editor reads the position only through `clock.songTime()`; the adapter
 * stays the one owner of the media element. The clock lives as long as the
 * editor, so a seek before the first Play, or after the audio played out,
 * just moves it; the adapter is made on Play (from a user gesture, which
 * also resumes the context) and made again after the audio played out.
 */

import { createSongClock, type SongClock } from "../clock/songClock";
import type { GainChain } from "../playback/gainChain";
import {
  createMediaPlayback,
  type FollowingVideoElement,
  type MediaPlayback,
  type PlaybackElement,
} from "../playback/mediaPlayback";
import { contextTimeAt } from "../playback/outputTime";
import type { PlaybackPlan } from "../playback/playbackPlan";
import { loopSeek, type LoopRange } from "./loop";
import {
  createNoteScheduler,
  NOTE_SOUNDS,
  type NoteSound,
  type SchedulerTimer,
  type SoundSink,
} from "./noteScheduler";
import { createNoteSink } from "./noteSink";

/** The page's audio: its one `AudioContext` and gain chain (`stageAudio()`). */
export interface EditorAudio {
  context(): AudioContext;
  chain(): GainChain;
  outputLatencyMs(): number;
  resume(): Promise<void>;
}

/** The speeds, keys `1`, `2` and `3`. */
export const SPEEDS = [1, 0.75, 0.5] as const;

export interface EditorPlaybackState {
  /** Play was pressed and the Song has not been paused or played out. */
  playing: boolean;
  rate: number;
  /** The range Loop a Line goes round, `null` while not looping. */
  loop: LoopRange | null;
}

export interface EditorPlaybackOptions {
  plan: PlaybackPlan;
  element: PlaybackElement;
  /** The muted video following the audio (separate files, #212). */
  video?: FollowingVideoElement | null;
  audio: EditorAudio;
  onChange?: (state: EditorPlaybackState) => void;
  /** Tests: where the sounds go (the chain's input by default). */
  sink?: SoundSink;
  now?: () => number;
  timer?: SchedulerTimer;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

export interface EditorPlayback {
  readonly clock: SongClock;
  state(): EditorPlaybackState;
  /** Space or `P`. */
  togglePlay(): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  /** Moves the playhead (Song time, seconds). */
  seek(seconds: number): void;
  setRate(rate: number): void;
  /** The Notes' sounds after an edit, or with clicks or hum switched. */
  setSounds(sounds: readonly NoteSound[]): void;
  /** Loop a Line on (jumping to its start while playing) or off. */
  setLoop(range: LoopRange | null): void;
  /** A typed `#VIDEOGAP`: the muted video follows at audio + `seconds`. */
  setVideoGap(seconds: number): void;
  dispose(): void;
}

const browserTimer: SchedulerTimer = {
  every(ms, callback) {
    const handle = window.setInterval(callback, ms);
    return () => {
      window.clearInterval(handle);
    };
  },
};

export function createEditorPlayback(
  options: EditorPlaybackOptions,
): EditorPlayback {
  const { plan, element, audio } = options;
  const now = options.now ?? (() => performance.now());
  const timer = options.timer ?? browserTimer;
  const clock = createSongClock({ media: plan.clock, now });

  let adapter: MediaPlayback | null = null;
  let videoGap = plan.follow?.gapSeconds ?? 0;
  let state: EditorPlaybackState = { playing: false, rate: 1, loop: null };

  function change(next: Partial<EditorPlaybackState>) {
    state = { ...state, ...next };
    options.onChange?.(state);
  }

  let sink: SoundSink | null = options.sink ?? null;
  const lazySink: SoundSink = {
    play(sound, start, end) {
      if (!sink) {
        sink = createNoteSink(audio.chain());
      }
      return sink.play(sound, start, end);
    },
  };
  const scheduler = createNoteScheduler({
    clock,
    now,
    contextTimeAt: (stageMs) => contextTimeAt(audio.context(), stageMs),
    sink: lazySink,
    timer,
  });

  function seek(seconds: number) {
    const to = Math.max(0, seconds);
    if (adapter) adapter.seek(to);
    else clock.seek(to);
    scheduler.reset();
  }

  // Loop a Line: back to the start once Song time reaches the end.
  const cancelLoop = timer.every(NOTE_SOUNDS.topUpMs, () => {
    if (!state.loop || !clock.playing) return;
    const to = loopSeek(clock.songTime(), state.loop);
    if (to !== null) seek(to);
  });

  function makeAdapter(): MediaPlayback {
    const made = createMediaPlayback({
      element,
      plan: {
        ...plan,
        startSeconds: 0,
        endSeconds: null,
        follow: plan.follow && { ...plan.follow, gapSeconds: videoGap },
      },
      chain: audio.chain(),
      video: options.video ?? null,
      clock,
      outputLatencyMs: () => audio.outputLatencyMs(),
      now,
      ...(options.requestFrame ? { requestFrame: options.requestFrame } : {}),
      ...(options.cancelFrame ? { cancelFrame: options.cancelFrame } : {}),
      onEnded: () => {
        // Played out: the adapter let go of the element; Play makes a new one.
        adapter = null;
        scheduler.reset();
        change({ playing: false });
      },
    });
    made.setRate(state.rate);
    return made;
  }

  function inLoop(t: number): boolean {
    const { loop } = state;
    return loop === null || (t >= loop.start && t < loop.end);
  }

  async function play() {
    if (state.playing) return;
    change({ playing: true });
    await audio.resume().catch(() => undefined);
    const from = inLoop(clock.songTime())
      ? clock.songTime()
      : (state.loop?.start ?? 0);
    scheduler.reset();
    if (!adapter) {
      adapter = makeAdapter();
      await adapter.start(from).catch(() => {
        change({ playing: false });
      });
      return;
    }
    if (from !== clock.songTime()) adapter.seek(from);
    await adapter.resume().catch(() => {
      change({ playing: false });
    });
  }

  function pause() {
    if (!state.playing) return;
    adapter?.pause();
    scheduler.reset();
    change({ playing: false });
  }

  return {
    clock,
    state: () => state,
    togglePlay: () => (state.playing ? (pause(), Promise.resolve()) : play()),
    play,
    pause,
    seek,
    setRate(rate) {
      if (adapter) adapter.setRate(rate);
      else clock.setRate(rate);
      scheduler.reset();
      change({ rate });
    },
    setSounds(sounds) {
      scheduler.setSounds(sounds);
    },
    setLoop(range) {
      change({ loop: range });
      if (range && state.playing && !inLoop(clock.songTime()))
        seek(range.start);
    },
    setVideoGap(seconds) {
      videoGap = seconds;
      adapter?.setVideoGap(seconds);
    },
    dispose() {
      cancelLoop();
      scheduler.stop();
      adapter?.dispose();
      adapter = null;
    },
  };
}
