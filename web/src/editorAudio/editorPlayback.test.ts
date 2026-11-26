import { describe, expect, it } from "vitest";

import type { GainChain } from "../playback/gainChain";
import type { PlaybackPlan } from "../playback/playbackPlan";
import {
  createEditorPlayback,
  type EditorAudio,
  type EditorPlaybackState,
} from "./editorPlayback";
import type { NoteSound } from "./noteScheduler";

/** A media element whose position and events the test sets by hand. */
class FakeMedia extends EventTarget {
  currentTime = 0;
  paused = true;
  playbackRate = 1;
  preservesPitch = false;
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  fire(type: string) {
    if (type === "ended") this.paused = true;
    this.dispatchEvent(new Event(type));
  }
}

const plan: PlaybackPlan = {
  element: "audio",
  url: "/api/songs/7/media/audio",
  clock: "audio",
  startSeconds: 0,
  endSeconds: null,
  loudnessLufs: null,
  follow: null,
};

function setUp() {
  let now = 1000;
  let tick: (() => void) | null = null;
  const played: NoteSound[] = [];
  const cancelled: NoteSound[] = [];
  const states: EditorPlaybackState[] = [];
  let resumed = 0;
  const audio: EditorAudio = {
    context: () =>
      ({
        getOutputTimestamp: () => ({
          contextTime: 1,
          performanceTime: now,
        }),
      }) as unknown as AudioContext,
    chain: () =>
      ({
        connectMedia: () => () => undefined,
        setSongLoudness: () => undefined,
      }) as unknown as GainChain,
    outputLatencyMs: () => 0,
    resume: () => {
      resumed += 1;
      return Promise.resolve();
    },
  };
  const media = new FakeMedia();
  const playback = createEditorPlayback({
    plan,
    element: media,
    audio,
    now: () => now,
    requestFrame: () => 1,
    cancelFrame: () => undefined,
    timer: {
      every(_, callback) {
        const previous = tick;
        tick = () => {
          previous?.();
          callback();
        };
        return () => {
          tick = null;
        };
      },
    },
    sink: {
      play(sound) {
        played.push(sound);
        return () => {
          cancelled.push(sound);
        };
      },
    },
    onChange: (state) => states.push(state),
  });
  return {
    playback,
    media,
    played,
    cancelled,
    states,
    get resumed() {
      return resumed;
    },
    tick: () => tick?.(),
    advance(ms: number) {
      now += ms;
    },
  };
}

const click = (at: number): NoteSound => ({ kind: "click", at, end: at });

describe("the Timing editor's playback", () => {
  it("plays from the playhead and pauses again", async () => {
    const s = setUp();
    s.playback.seek(12);
    expect(s.playback.clock.songTime()).toBe(12);
    await s.playback.togglePlay();
    expect(s.resumed).toBe(1);
    expect(s.media.currentTime).toBe(12);
    expect(s.media.paused).toBe(false);
    expect(s.playback.state().playing).toBe(true);
    s.media.fire("playing");
    s.advance(1000);
    expect(s.playback.clock.songTime()).toBeCloseTo(13, 9);
    await s.playback.togglePlay();
    expect(s.media.paused).toBe(true);
    expect(s.playback.state().playing).toBe(false);
  });

  it("seeks the playing Song through the adapter", async () => {
    const s = setUp();
    await s.playback.play();
    s.media.fire("playing");
    s.playback.seek(40);
    expect(s.media.currentTime).toBe(40);
    expect(s.playback.clock.songTime()).toBe(40);
  });

  it("sets the speed on the clock and the element, with the pitch kept, before and while playing", async () => {
    const s = setUp();
    s.playback.setRate(0.75);
    expect(s.playback.clock.rate).toBe(0.75);
    expect(s.playback.state().rate).toBe(0.75);
    await s.playback.play();
    expect(s.media.playbackRate).toBe(0.75);
    expect(s.media.preservesPitch).toBe(true);
    s.playback.setRate(0.5);
    expect(s.media.playbackRate).toBe(0.5);
    expect(s.playback.clock.rate).toBe(0.5);
    expect(s.states.at(-1)?.rate).toBe(0.5);
  });

  it("clicks the Notes ahead while playing, and reschedules after a seek, a speed change and new sounds", async () => {
    const s = setUp();
    s.playback.setSounds([click(0.1), click(5.1)]);
    await s.playback.play();
    s.media.fire("playing");
    s.tick();
    expect(s.played.map((p) => p.at)).toEqual([0.1]);
    s.playback.seek(5);
    expect(s.cancelled.map((p) => p.at)).toEqual([0.1]);
    s.media.fire("seeked");
    s.tick();
    expect(s.played.map((p) => p.at)).toEqual([0.1, 5.1]);
    s.playback.setRate(0.5);
    expect(s.cancelled.map((p) => p.at)).toEqual([0.1, 5.1]);
    s.tick();
    s.playback.setSounds([click(5.05)]);
    expect(s.cancelled.map((p) => p.at)).toEqual([0.1, 5.1, 5.1]);
  });

  it("goes round a loop: plays from its start and seeks back at its end", async () => {
    const s = setUp();
    s.playback.setLoop({ start: 18.5, end: 23.6 });
    expect(s.playback.state().loop).toEqual({ start: 18.5, end: 23.6 });
    await s.playback.play();
    expect(s.media.currentTime).toBe(18.5);
    s.media.fire("playing");
    s.advance(5000);
    s.tick();
    expect(s.playback.clock.songTime()).toBeCloseTo(23.5, 9);
    s.advance(100);
    s.tick();
    expect(s.playback.clock.songTime()).toBe(18.5);
  });

  it("turning the loop on while playing jumps to its start; off plays on", async () => {
    const s = setUp();
    await s.playback.play();
    s.media.fire("playing");
    s.playback.setLoop({ start: 18.5, end: 23.6 });
    expect(s.media.currentTime).toBe(18.5);
    s.playback.setLoop(null);
    expect(s.playback.state().loop).toBeNull();
    s.media.fire("seeked");
    s.advance(10_000);
    s.tick();
    expect(s.playback.clock.songTime()).toBeCloseTo(28.5, 9);
  });

  it("can play again after the audio played out", async () => {
    const s = setUp();
    await s.playback.play();
    s.media.fire("playing");
    s.media.fire("ended");
    expect(s.playback.state().playing).toBe(false);
    s.playback.seek(3);
    await s.playback.play();
    expect(s.media.currentTime).toBe(3);
    expect(s.media.paused).toBe(false);
  });
});
