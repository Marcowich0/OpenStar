// The live scoring session (#165), driven without a browser: a real Song
// clock on a scripted Stage clock, the real Pitch router placing recorded
// readings, and the session reading the router's buffers.
//
// Grid: #GAP 500 ms, one Beat = 250 ms (`beatsPerMinute` 240 after the
// parser's ×4), so Beat b spans [0.5 + 0.25 b, 0.75 + 0.25 b) s and every
// boundary is exact in binary. The Song clock starts at Stage time 0 at Song
// time 0, so Song time = Stage time / 1000 while it plays.

import { describe, expect, it } from "vitest";

import { createSongClock, type SongClock } from "../clock/songClock";
import type { BeatValue } from "../generated/BeatValue";
import type { MicId } from "../generated/MicId";
import type { Note } from "../generated/Note";
import type { NoteKind } from "../generated/NoteKind";
import type { ParsedSong } from "../generated/ParsedSong";
import type { Voice } from "../generated/Voice";
import { createPitchRouter } from "../pitch/pitchRouter";
import { testHeaders } from "../stage/scenes/sing/testSong";
import {
  createLiveScoring,
  type LiveScoring,
  type LiveScoringPlayer,
} from "./liveScoring";
import { scoreBeats } from "./scorer";

const HEADERS = testHeaders({ gapSeconds: 0.5, beatsPerMinute: 240 });

function note(
  start: number,
  length: number,
  pitch = 0,
  kind: NoteKind = "normal",
): Note {
  return { kind, start, length, pitch, text: "la ", line: 1 };
}

/** Line 0: Beats 0–1; Line 1: Beats 4–5 (both pitch `pitch`). */
function twoLines(pitch = 0): Voice {
  return {
    lines: [
      { notes: [note(0, 2, pitch)], end: { beat: 3, line: 2 } },
      { notes: [note(4, 2, pitch)], end: null },
    ],
  };
}

function song(voices: Voice[] = [twoLines()]): ParsedSong {
  return { headers: HEADERS, voices };
}

function player(over: Partial<LiveScoringPlayer> = {}): LiveScoringPlayer {
  return {
    voice: 0,
    difficulty: "medium",
    micKind: "phone",
    micDelayMs: 0,
    micThresholdDbfs: -30,
    ...over,
  };
}

const FIRST_MIC: MicId = { kind: "phone", connection: 1 };
const MICS: MicId[] = [FIRST_MIC, { kind: "phone", connection: 2 }];

/** Start of Beat `b` in Stage ms (Song time × 1000 while playing from 0). */
const beatMs = (b: number) => 500 + 250 * b;

interface Rig {
  clock: SongClock;
  session: LiveScoring;
  /** Moves the Stage clock to `ms` and ticks the session there. */
  at(ms: number): void;
  /** Moves the Stage clock to `ms` without a tick. */
  to(ms: number): void;
  /** Ticks every 50 ms of Stage time from now up to `ms`. */
  run(ms: number): void;
  /** Restart now, as the Song controls do: seek to 0, clear the buffers, reset. */
  restart(): void;
  /** A lost-Mic signal for seat `player`, now. */
  micEvent(
    player: number,
    kind: "connectionClosed" | "connectionBack" | "pageHidden" | "pageVisible",
  ): void;
  /** Delivers a reading now, captured at `captureMs` (Stage ms), to Mic `mic`. */
  sing(
    captureMs: number,
    pitch: number | null,
    options?: { mic?: number; clarity?: number; loudness?: number },
  ): void;
}

function rig(
  options: { song?: ParsedSong; players?: LiveScoringPlayer[] } = {},
): Rig {
  let now = 0;
  const clock = createSongClock({ media: "audio", now: () => now });
  const players = options.players ?? [player()];
  const pitch = createPitchRouter();
  const session = createLiveScoring({
    song: options.song ?? song(),
    noteFingerprint: "fp",
    players,
    clock,
    buffers: () => pitch.buffers(),
    now: () => now,
  });
  pitch.start({
    players: players.length,
    mics: players.map((_, i) => [MICS[i] ?? FIRST_MIC, i] as const),
    capacity: 1000,
    place: session.placement,
  });
  clock.play();
  return {
    clock,
    session,
    at(ms) {
      now = ms;
      session.tick();
    },
    to(ms) {
      now = ms;
    },
    run(ms) {
      while (now + 50 <= ms) {
        now += 50;
        session.tick();
      }
      now = ms;
      session.tick();
    },
    micEvent(p, kind) {
      session.micEvent(p, kind);
    },
    restart() {
      clock.seek(0);
      for (const buffer of pitch.buffers()) buffer.clear();
      session.reset();
    },
    sing(captureMs, pitchValue, o = {}) {
      const mic = MICS[o.mic ?? 0] ?? FIRST_MIC;
      pitch.receive(mic, {
        captureMs,
        pitch: pitchValue,
        clarity: o.clarity ?? 0.95,
        loudness: o.loudness ?? -10,
      });
      // A reading counts as heard by the lost-Mic rule when it arrives.
      session.micEvent(o.mic ?? 0, "reading");
    },
  };
}

/** Sings `pitch` at four readings across Beat `b` (captured on time, delivered now). */
function singBeat(r: Rig, b: number, pitch: number | null, mic = 0, delay = 0) {
  for (const offset of [25, 85, 145, 205]) {
    r.sing(beatMs(b) + offset + delay, pitch, { mic });
  }
}

const P = (pitch: number): BeatValue => ({ kind: "pitch", pitch });
const NONE: BeatValue = { kind: "noVoice" };

describe("finalising a Beat", () => {
  it("fixes a Beat's value only once Song time reaches its end plus 300 ms, readings placed with the Mic delay", () => {
    // A Phone with a 100 ms Mic delay: captured 100 ms after it was sung.
    const r = rig({ players: [player({ micDelayMs: 100 })] });
    r.to(beatMs(2) + 100);
    singBeat(r, 0, 60, 0, 100);
    singBeat(r, 1, 60, 0, 100);
    // Beat 1 ends at beatMs(2); grace runs until beatMs(2) + 300.
    r.at(beatMs(2) + 299);
    expect(r.session.score(0).total).toBe(2250); // Beat 0 only: 9000 / 4
    r.at(beatMs(2) + 300);
    expect(r.session.score(0).total).toBe(4500 + 500);
  });
});

describe("Beat values with a Mic delay", () => {
  it("places each reading at songTimeAt(capture − Mic delay): exact boundary and the half rule", () => {
    // A Local mic with a 40 ms Mic delay.
    const r = rig({
      players: [player({ micDelayMs: 40, micKind: "localMic" })],
    });
    r.to(beatMs(2) + 40);
    // Beat 0: two of four voiced (half, rounded up) → pitch, the lower median.
    r.sing(beatMs(0) + 40 + 10, 72);
    r.sing(beatMs(0) + 40 + 60, 60);
    r.sing(beatMs(0) + 40 + 110, null, { clarity: 0.2 });
    r.sing(beatMs(0) + 40 + 160, 60, { loudness: -50 });
    // Placed exactly on Beat 1's start: Beat 1. One voiced of three → voice
    // without pitch (two pass the threshold), not a pitch.
    r.sing(beatMs(1) + 40, 61, { clarity: 0.5 });
    r.sing(beatMs(1) + 40 + 100, 61);
    r.sing(beatMs(1) + 40 + 200, null, { loudness: -60 });
    r.run(beatMs(2) + 300);
    expect(r.session.outcome().players[0]?.beatValues.slice(0, 2)).toEqual([
      P(60),
      { kind: "voiceWithoutPitch" },
    ]);
  });
});

describe("which readings score", () => {
  it("does not score a reading that arrives after its Beat was finalised", () => {
    const r = rig();
    r.to(beatMs(1) + 300);
    r.at(beatMs(1) + 300); // Beat 0 is final: nothing had arrived
    singBeat(r, 0, 60); // captured on time, delivered too late
    r.run(beatMs(8));
    expect(r.session.score(0).total).toBe(0);
    expect(r.session.outcome().players[0]?.beatValues[0]).toEqual(NONE);
  });

  it("drops readings captured inside a pause, and a pause holds open Beats", () => {
    const r = rig();
    // Paused at Song time 0.85 s: Beat 0 (final at 1.05 s) and Beat 1 are open.
    r.to(beatMs(1) + 100);
    r.clock.pause();
    // During the pause, readings captured before it arrive late (Wi-Fi), in
    // capture order: Beat 0 in tune, then two in-tune readings of Beat 1...
    r.to(2000);
    singBeat(r, 0, 60);
    r.sing(beatMs(1) + 25, 60);
    r.sing(beatMs(1) + 50, 60);
    // ...and the Phone keeps sending, off pitch, while paused: dropped. Had
    // they counted, Beat 1's lower median would be 70.
    for (let ms = 2100; ms <= 4000; ms += 100) {
      r.to(ms);
      r.sing(ms, 70);
      r.at(ms);
    }
    expect(r.session.score(0).total).toBe(0); // Song time is frozen
    r.clock.play(); // Song time 0.85 s at Stage 4000 ms
    r.run(4000 + 200); // Beat 0 final at 1.05 s
    expect(r.session.score(0).total).toBe(2250);
    r.run(4000 + 450); // Beat 1 final at 1.30 s
    const outcome = r.session.outcome().players[0];
    expect(outcome?.beatValues.slice(0, 2)).toEqual([P(60), P(60)]);
    expect(r.session.score(0).total).toBe(5000);
  });
});

describe("Restart", () => {
  it("discards the Beat values, sums and Line results so far", () => {
    const r = rig();
    r.to(beatMs(2));
    singBeat(r, 0, 60);
    singBeat(r, 1, 60);
    r.run(beatMs(3) + 100); // Beat 1 final at 1300 ms
    expect(r.session.score(0).total).toBe(5000);
    expect(r.session.lineResults(0)).toHaveLength(1);

    const totals: number[] = [];
    r.session.onChange((change) => totals.push(change.score.total));
    r.restart(); // Song time 0 at Stage 1350 ms
    expect(totals).toEqual([0]); // the lane header goes back to 0 at once
    expect(r.session.score(0).total).toBe(0);
    expect(r.session.lineResults(0)).toEqual([]);
    // The restarted Song starts from 0: Beat 0 again, 1350 ms later.
    const shift = beatMs(3) + 100;
    r.to(shift + beatMs(1));
    for (const offset of [25, 85, 145, 205])
      r.sing(shift + beatMs(0) + offset, 61);
    r.run(shift + beatMs(1) + 300);
    expect(r.session.score(0).total).toBe(2250);
    expect(r.session.outcome().players[0]?.beatValues[0]).toEqual(P(61));
  });
});

/** Three Lines of one Note each: Beats 0–1, 4–5 and 8–9. */
function threeLines(): Voice {
  return {
    lines: [
      { notes: [note(0, 2)], end: { beat: 3, line: 2 } },
      { notes: [note(4, 2)], end: { beat: 7, line: 3 } },
      { notes: [note(8, 2)], end: null },
    ],
  };
}

/** Sings every Beat from `first` to `last` in tune, delivering each Beat as it ends. */
function singThrough(r: Rig, first: number, last: number, pitch = 60) {
  for (let b = first; b <= last; b++) {
    r.run(beatMs(b + 1));
    singBeat(r, b, pitch);
  }
}

describe("a lost Mic", () => {
  it("scores the Beats while the Mic is lost as no voice, then resumes on the same Player", () => {
    const r = rig({ song: song([threeLines()]) });
    singThrough(r, 0, 3);
    expect(r.session.lost(0)).toBe(false);
    // The Phone's connection closes during Beat 4; readings still trickle in.
    r.micEvent(0, "connectionClosed");
    expect(r.session.lost(0)).toBe(false); // seen at the next tick
    singThrough(r, 4, 5);
    expect(r.session.lost(0)).toBe(true);
    // Back during Beat 6, before Line 2.
    r.run(beatMs(6) + 100);
    r.micEvent(0, "connectionBack");
    singBeat(r, 6, 60);
    singThrough(r, 7, 11);
    r.run(beatMs(12) + 300);
    expect(r.session.lost(0)).toBe(false);

    const outcome = r.session.outcome().players[0];
    // Line 0 and Line 2 sung in full, Line 1 lost: 6000 Notes + 2 × 333.3.
    expect(outcome?.beatValues).toEqual([
      // Beat 6 was lost for its first 100 ms: no voice too.
      P(60),
      P(60),
      P(60),
      P(60),
      NONE,
      NONE,
      NONE,
      P(60),
      P(60),
      P(60),
    ]);
    expect(outcome?.score).toEqual({
      total: 6667,
      notes: 6000,
      golden: 0,
      lineBonus: 667,
    });
    expect(outcome?.micLost).toBe(true);
    expect(outcome?.finished).toBe(true);
  });

  it("exposes each seat's lost state as it changes", () => {
    const r = rig({ players: [player(), player()] });
    const changes: [number, boolean][] = [];
    r.session.onChange((change) => {
      changes.push([change.player, change.lost]);
    });
    r.micEvent(1, "pageHidden");
    r.at(10);
    r.micEvent(1, "pageVisible");
    r.at(20);
    expect(changes).toEqual([
      [1, true],
      [1, false],
    ]);
  });
});

describe("a lost Mic's moments", () => {
  it("tells the Song time the loss was first seen, and which change is the Mic coming back", () => {
    const r = rig({ players: [player(), player()] });
    const changes: [number, number | null, boolean][] = [];
    r.session.onChange((change) => {
      changes.push([change.player, change.lostAt, change.back]);
    });
    r.at(200);
    r.micEvent(1, "pageHidden");
    r.at(300); // Song time 0.3 s
    r.at(400); // still lost: no change
    r.micEvent(1, "pageVisible");
    r.at(500);
    expect(changes).toEqual([
      [1, 0.3, false],
      [1, null, true],
    ]);
  });

  it("is not a return on a Restart", () => {
    const r = rig();
    const back: boolean[] = [];
    r.session.onChange((change) => back.push(change.back));
    r.micEvent(0, "connectionClosed");
    r.at(100);
    r.restart();
    expect(back).toEqual([false, false]);
  });
});

describe("a duet", () => {
  it("scores two Players on different Voices and Difficulties against their own Voice", () => {
    const r = rig({
      song: song([twoLines(0), twoLines(7)]),
      players: [
        player({ voice: 0, difficulty: "easy" }),
        player({ voice: 1, difficulty: "hard", micKind: "localMic" }),
      ],
    });
    for (const b of [0, 1, 4, 5]) {
      r.run(beatMs(b + 1));
      // P1: 240 cents sharp of C (an Easy hit). P2: G plus 100 cents (a Hard miss)
      // on Line 0, in tune on Line 1.
      singBeat(r, b, 62.4, 0);
      singBeat(r, b, b < 4 ? 68 : 67, 1);
    }
    r.run(beatMs(6) + 300);
    const { players } = r.session.outcome();
    expect(players.map((p) => p.score.total)).toEqual([10000, 5000]);
    expect(players[1]).toMatchObject({
      voice: 1,
      difficulty: "hard",
      micKind: "localMic",
      beatRange: { firstBeat: 0, lastBeat: 5 },
    });
    expect(r.session.lineResults(1).map((l) => l.rating)).toEqual([0, 8]);
  });
});

describe("inputs taken at Start", () => {
  it("keeps each Player's inputs fixed for the Song", () => {
    const input = player({ micThresholdDbfs: -30, micDelayMs: 0 });
    const r = rig({ players: [input] });
    // Changing the caller's object later changes nothing.
    input.micThresholdDbfs = 0;
    input.micDelayMs = 400;
    input.difficulty = "hard";
    r.to(beatMs(1));
    singBeat(r, 0, 61); // 100 cents: a Medium hit, a Hard miss; at −10 dBFS
    r.run(beatMs(1) + 300);
    expect(r.session.score(0).total).toBe(2250);
    expect(r.session.players[0]).toEqual(player());
  });
});

describe("the outcome", () => {
  it("yields the record's fields, and a batch run over its Beat values gives the same Score", () => {
    const r = rig({ song: song([threeLines()]) });
    // Mixed singing: Beat 1 voiceless, Beat 4 off pitch, Beat 9 silent.
    for (let b = 0; b <= 9; b++) {
      r.run(beatMs(b + 1));
      if (b === 1) {
        for (const o of [25, 85, 145])
          r.sing(beatMs(b) + o, 60, { clarity: 0.5 });
      } else if (b !== 9) {
        singBeat(r, b, b === 4 ? 66 : 60);
      } else {
        for (const o of [25, 85, 145])
          r.sing(beatMs(b) + o, null, { loudness: -90 });
      }
    }
    r.run(beatMs(10) + 300); // played out
    const outcome = r.session.outcome();
    expect(outcome.noteFingerprint).toBe("fp");
    const result = outcome.players[0];
    expect(result?.beatValues).toEqual([
      P(60),
      { kind: "voiceWithoutPitch" },
      P(60),
      P(60),
      P(66),
      P(60),
      P(60),
      P(60),
      P(60),
      NONE,
    ]);
    const batch = scoreBeats(
      { voice: threeLines(), headers: HEADERS, difficulty: "medium" },
      0,
      result?.beatValues ?? [],
    );
    expect(result?.score).toEqual(batch.score);
    expect(result?.sums).toEqual({
      notes: batch.notes,
      golden: batch.golden,
      lineBonus: batch.lineBonus,
    });
    // Hits on Beats 0, 5 and 8 (1500 each); each Line half sung (~166.8 each).
    expect(result?.score).toEqual({
      total: 5000,
      notes: 4500,
      golden: 0,
      lineBonus: 500,
    });
  });

  it("ended early: Finished is false and the Beats never finalised are no voice", () => {
    const r = rig({ song: song([threeLines()]) });
    singThrough(r, 0, 4);
    r.run(beatMs(5) + 300); // Beat 4 final, Beat 5 not yet
    r.clock.pause(); // End
    const result = r.session.outcome().players[0];
    expect(result?.finished).toBe(false);
    expect(result?.beatValues.slice(4)).toEqual([
      P(60),
      NONE,
      NONE,
      NONE,
      NONE,
      NONE,
    ]);
    // Line 1 never ended, so it gave no bonus.
    expect(result?.score).toEqual({
      total: 4833,
      notes: 4500,
      golden: 0,
      lineBonus: 333,
    });
  });
});
