import { describe, expect, it } from "vitest";

import type { Note } from "../generated/Note";
import type { NoteKind } from "../generated/NoteKind";
import type { BeatGrid } from "../clock/beats";
import {
  createNoteScheduler,
  NOTE_SOUNDS,
  noteSounds,
  type NoteSound,
  type SchedulerClock,
} from "./noteScheduler";

/** 60 Beats a minute, `#GAP` 0: Beat b starts at b seconds. */
const grid: BeatGrid = { gapSeconds: 0, beatsPerMinute: 60 };

function note(kind: NoteKind, start: number, length = 1, pitch = 0): Note {
  return { kind, start, length, pitch, text: "la", line: 1 };
}

function song(...notes: Note[]) {
  return { voices: [{ lines: [{ notes }] }] };
}

describe("the sounds of a Song's Notes", () => {
  it("clicks on every Note start, accented on Golden notes", () => {
    const sounds = noteSounds(
      song(
        note("normal", 1),
        note("golden", 2),
        note("rap", 3),
        note("goldenRap", 4),
        note("freestyle", 5),
      ),
      grid,
      { clicks: true, hum: false },
    );
    expect(sounds.map((s) => [s.kind, s.at])).toEqual([
      ["click", 1],
      ["accent", 2],
      ["click", 3],
      ["accent", 4],
      ["click", 5],
    ]);
  });

  it("hums only Normal and Golden notes, at their pitch, for their length", () => {
    const sounds = noteSounds(
      song(
        note("normal", 1, 2, 9),
        note("golden", 4, 1, 21),
        note("rap", 6),
        note("goldenRap", 7),
        note("freestyle", 8),
      ),
      grid,
      { clicks: false, hum: true },
    );
    expect(sounds).toEqual([
      { kind: "hum", at: 1, end: 3, hz: 440 },
      { kind: "hum", at: 4, end: 5, hz: 880 },
    ]);
  });

  it("makes nothing with clicks and hum off", () => {
    expect(
      noteSounds(song(note("normal", 1)), grid, { clicks: false, hum: false }),
    ).toEqual([]);
  });

  it("lists the sounds of every Voice in time order", () => {
    const sounds = noteSounds(
      {
        voices: [
          { lines: [{ notes: [note("normal", 3)] }] },
          { lines: [{ notes: [note("normal", 1)] }] },
        ],
      },
      grid,
      { clicks: true, hum: false },
    );
    expect(sounds.map((s) => s.at)).toEqual([1, 3]);
  });
});

/** A clock, a Stage clock, a timer, a mapping and a sink, all driven by hand. */
function harness(sounds: NoteSound[]) {
  const state = { songTime: 10, rate: 1, playing: true, now: 50_000 };
  const clock: SchedulerClock = {
    songTime: () => state.songTime,
    get rate() {
      return state.rate;
    },
    get playing() {
      return state.playing;
    },
  };
  let tick: (() => void) | null = null;
  let tickMs: number | null = null;
  const played: { sound: NoteSound; start: number; end: number }[] = [];
  const cancelled: NoteSound[] = [];
  let mapping: ((stageMs: number) => number | null) | null = (stageMs) =>
    // The context's output: context time 0 left the speakers at Stage time 40 000.
    (stageMs - 40_000) / 1000;
  const scheduler = createNoteScheduler({
    clock,
    now: () => state.now,
    contextTimeAt: (stageMs) => (mapping ? mapping(stageMs) : null),
    sink: {
      play(sound, start, end) {
        played.push({ sound, start, end });
        return () => {
          cancelled.push(sound);
        };
      },
    },
    timer: {
      every(ms, callback) {
        tickMs = ms;
        tick = callback;
        return () => {
          tick = null;
        };
      },
    },
  });
  scheduler.setSounds(sounds);
  return {
    state,
    scheduler,
    played,
    cancelled,
    tick: () => tick?.(),
    get tickMs() {
      return tickMs;
    },
    get ticking() {
      return tick !== null;
    },
    noMapping() {
      mapping = null;
    },
    mapping() {
      mapping = (stageMs) => (stageMs - 40_000) / 1000;
    },
    /** Song time and the Stage clock move on together, at the rate. */
    advance(ms: number) {
      state.now += ms;
      state.songTime += (ms / 1000) * state.rate;
    },
  };
}

const click = (at: number): NoteSound => ({ kind: "click", at, end: at });

describe("scheduling the Note sounds ahead", () => {
  it("tops up every 30 ms", () => {
    expect(NOTE_SOUNDS.topUpMs).toBe(30);
    expect(harness([]).tickMs).toBe(30);
  });

  it("schedules about 250 ms of Song time ahead at full speed", () => {
    const h = harness([click(10.1), click(10.24), click(10.26), click(11)]);
    h.tick();
    expect(h.played.map((p) => p.sound.at)).toEqual([10.1, 10.24]);
  });

  it("scales the 250 ms by the rate", () => {
    const h = harness([click(10.1), click(10.13)]);
    h.state.rate = 0.5;
    h.tick();
    // 250 ms × 0.5 = 125 ms of Song time.
    expect(h.played.map((p) => p.sound.at)).toEqual([10.1]);
  });

  it("maps each Song time to AudioContext time through the shared mapping", () => {
    const h = harness([{ kind: "hum", at: 10.1, end: 10.2, hz: 440 }]);
    h.state.rate = 0.5;
    h.state.songTime = 10.04;
    h.tick();
    // 0.06 s of Song time at half speed is 120 ms on the Stage clock:
    // Stage time 50 120 is context time 10.12; the end, 0.16 s of Song
    // time on, lands 320 ms after now: context time 10.32.
    expect(h.played).toHaveLength(1);
    expect(h.played[0]?.start).toBeCloseTo(10.12, 9);
    expect(h.played[0]?.end).toBeCloseTo(10.32, 9);
  });

  it("schedules each sound once as it tops up", () => {
    const h = harness([click(10.1), click(10.3), click(10.5), click(10.7)]);
    h.tick();
    h.advance(30);
    h.tick();
    h.advance(200);
    h.tick();
    h.advance(30);
    h.tick();
    expect(h.played.map((p) => p.sound.at)).toEqual([10.1, 10.3, 10.5]);
  });

  it("schedules nothing while the clock does not play", () => {
    const h = harness([click(10.1)]);
    h.state.playing = false;
    h.tick();
    expect(h.played).toEqual([]);
  });

  it("drops what it scheduled when playback stops", () => {
    const h = harness([click(10.1), click(10.2)]);
    h.tick();
    h.state.playing = false;
    h.tick();
    expect(h.cancelled.map((s) => s.at)).toEqual([10.1, 10.2]);
    h.state.playing = true;
    h.tick();
    expect(h.played.map((p) => p.sound.at)).toEqual([10.1, 10.2, 10.1, 10.2]);
  });

  it("waits for the mapping before the context reports output", () => {
    const h = harness([click(10.1)]);
    h.noMapping();
    h.tick();
    expect(h.played).toEqual([]);
    h.mapping();
    h.tick();
    expect(h.played.map((p) => p.sound.at)).toEqual([10.1]);
  });

  it("drops everything scheduled and reschedules from the new position on a reset", () => {
    // A seek: Song time jumps back; whatever was scheduled is dropped.
    const h = harness([click(5.1), click(10.1), click(10.2)]);
    h.tick();
    h.state.songTime = 5;
    h.scheduler.reset();
    expect(h.cancelled.map((s) => s.at)).toEqual([10.1, 10.2]);
    h.tick();
    expect(h.played.map((p) => p.sound.at)).toEqual([10.1, 10.2, 5.1]);
  });

  it("reschedules from the new Notes after an edit", () => {
    const h = harness([click(10.1)]);
    h.tick();
    h.scheduler.setSounds([click(10.15)]);
    expect(h.cancelled.map((s) => s.at)).toEqual([10.1]);
    h.tick();
    expect(h.played.map((p) => p.sound.at)).toEqual([10.1, 10.15]);
  });

  it("reschedules with the new lookahead after a speed change", () => {
    const h = harness([click(10.1), click(10.2)]);
    h.state.rate = 0.5;
    h.tick();
    h.state.rate = 1;
    h.scheduler.reset();
    expect(h.cancelled.map((s) => s.at)).toEqual([10.1]);
    h.tick();
    expect(h.played.map((p) => p.sound.at)).toEqual([10.1, 10.1, 10.2]);
  });

  it("forgets sounds that have played, so a reset no longer touches them", () => {
    const h = harness([click(10.1)]);
    h.tick();
    h.advance(500);
    h.tick();
    h.scheduler.reset();
    expect(h.cancelled).toEqual([]);
  });

  it("stops ticking and drops everything on stop", () => {
    const h = harness([click(10.1)]);
    h.tick();
    h.scheduler.stop();
    expect(h.cancelled.map((s) => s.at)).toEqual([10.1]);
    expect(h.ticking).toBe(false);
  });
});
