import { describe, expect, it, vi } from "vitest";

import { ApiFailure } from "../../../api/api";
import type { ClientMessage } from "../../../generated/ClientMessage";
import type { MicId } from "../../../generated/MicId";
import type { PartySnapshot } from "../../../generated/PartySnapshot";
import type { RoundOutcome } from "../../../generated/RoundOutcome";
import type { ServerMessage } from "../../../generated/ServerMessage";
import type { SongControl } from "../../../generated/SongControl";
import type { LiveClientOptions } from "../../../live/liveClient";
import { createLiveStore } from "../../../live/liveStore";
import type { SongEnding } from "../../../playback/mediaPlayback";
import { createPitchRouter } from "../../../pitch/pitchRouter";
import { createStageSong, type StageSongOptions } from "./stageSong";
import { PROFILES, testDetail, testParty } from "./testSong";

const PLAYING = { requestId: 5, songId: 7, paused: false };

/** Mia's Phone as relayed readings name it. */
const MIA_MIC: MicId = { kind: "phone", connection: 1 };

/**
 * Mia sings Beats `first`–`last` of the test Song (#GAP 1 s, 250 ms Beats)
 * in tune on her Phone (default 100 ms Mic delay), each Beat's readings
 * arriving in a burst 150 ms after it ends; the Song clock started at Stage
 * time `songStartMs`. Before the first Beat the Phone sends one quiet reading
 * during the intro, so it is never silent for the lost-Mic rule's 1 s.
 */
function sing(
  t: ReturnType<typeof setup>,
  first: number,
  last: number,
  songStartMs = 0,
) {
  const receive = (
    captureMs: number,
    pitch: number | null,
    loudness: number,
  ) => {
    t.pitch.receive(MIA_MIC, { captureMs, pitch, clarity: 0.95, loudness });
  };
  t.frames(songStartMs + 600);
  receive(songStartMs + 600, null, -90);
  for (let b = first; b <= last; b++) {
    const beatMs = songStartMs + 1000 + 250 * b;
    t.frames(beatMs + 250 + 150);
    for (const offset of [25, 85, 145, 205]) {
      receive(beatMs + offset + 100, 60, -10);
    }
  }
}

/** A playback that records what it was told; `end()` signals like the real one. */
function fakePlayback(onEnded: (how: SongEnding) => void, log: string[]) {
  return {
    clock: { songTime: () => 0 },
    start: vi.fn(() => {
      log.push("start");
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      log.push("pause");
    }),
    resume: vi.fn(() => {
      log.push("resume");
      return Promise.resolve();
    }),
    restart: vi.fn(() => {
      log.push("restart");
      return Promise.resolve();
    }),
    end: vi.fn(() => {
      log.push("end");
      onEnded("ended");
    }),
    dispose: vi.fn(() => {
      log.push("dispose");
    }),
  };
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function setup(over: Partial<StageSongOptions> = {}) {
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  const sent: ClientMessage[] = [];
  const store = createLiveStore((given) => {
    handlers = given;
    return {
      send: (message) => {
        sent.push(message);
        return true;
      },
      close: () => {},
    };
  });
  const server = (message: ServerMessage) => {
    handlers?.onMessage(message);
  };
  const connection = (state: "open" | "reconnecting") => {
    handlers?.onConnection(state);
  };
  connection("open");
  server({
    type: "liveState",
    stageId: "main",
    party: testParty(),
    isStage: true,
  });

  const log: string[] = [];
  let ended: ((how: SongEnding) => void) | null = null;
  let nowMs = 1_700_000_000_000;
  let resumeLater: (() => void) | null = null;
  const rounds: RoundOutcome[] = [];
  const pitch = createPitchRouter();
  const loadSong = vi.fn(() => Promise.resolve(testDetail()));
  let playback: ReturnType<typeof fakePlayback> | null = null;
  let stageMs = 0;
  let nextFrame: (() => void) | null = null;
  const song = createStageSong({
    store,
    loadSong,
    profiles: () => PROFILES,
    pitch,
    createPlayback: ({ onEnded }) => {
      ended = onEnded;
      playback = fakePlayback(onEnded, log);
      return playback;
    },
    resumeAudio: () => Promise.resolve(),
    postRound: (outcome) => {
      rounds.push(outcome);
      return Promise.resolve();
    },
    now: () => nowMs,
    wait: () => Promise.resolve(),
    schedule: (run) => {
      resumeLater = run;
      return () => {
        resumeLater = null;
      };
    },
    stageNow: () => stageMs,
    requestFrame: (callback) => {
      nextFrame = callback;
      return 1;
    },
    cancelFrame: () => {
      nextFrame = null;
    },
    micIdFor: (mic) =>
      mic.kind === "phone" && mic.phoneId === "phone-mia" ? MIA_MIC : null,
    ...over,
  });

  const party = (over: Partial<PartySnapshot>) => {
    server({
      type: "partyChanged",
      party: testParty(over),
      change: {
        actor: { kind: "stage" },
        event: {
          code: "songStarted",
          params: { requestId: 5, songId: 7, title: "Test Song" },
        },
      },
    });
  };
  const control = (c: SongControl) => {
    server({ type: "controlSong", requestId: 5, songId: 7, control: c });
  };
  /** Start as the server sends it: the Party says it plays, then the control. */
  const start = async () => {
    party({ playing: PLAYING });
    control("start");
    await flush();
    song.attach({} as HTMLMediaElement);
    await flush();
  };
  const reported = () => rounds.filter((r) => r.ended !== "skipped");

  return {
    song,
    server,
    party,
    control,
    start,
    sent,
    log,
    rounds,
    pitch,
    loadSong,
    reachedResults: reported,
    setNow: (ms: number) => {
      nowMs = ms;
    },
    connection,
    playedOut: () => ended?.("played"),
    countdownDone: () => {
      // The countdown's steps and its end are all scheduled; run them all.
      resumeLater?.();
    },
    playback: () => playback,
    /** Moves the Stage clock to `ms`, running an animation frame every 20 ms. */
    frames(ms: number) {
      while (stageMs < ms) {
        stageMs = Math.min(stageMs + 20, ms);
        nextFrame?.();
      }
    },
    framesRunning: () => nextFrame !== null,
  };
}

describe("the Stage plays the head's Request", () => {
  it("loads the head's Song on Start and plays it from #START once the media is there", async () => {
    const t = setup();
    t.party({ playing: PLAYING });
    t.control("start");
    expect(t.song.view().kind).toBe("loading");
    await flush();
    expect(t.loadSong).toHaveBeenCalledWith(7);
    const view = t.song.view();
    expect(view.kind).toBe("singing");
    if (view.kind !== "singing") return;
    expect(view.plan.startSeconds).toBe(0);
    expect(view.state.lanes).toHaveLength(1);
    expect(t.log).toEqual([]);

    t.song.attach({} as HTMLMediaElement);
    await flush();
    expect(t.log).toEqual(["start"]);
  });

  it("starts the Pitch router with one buffer per Player, the lanes reading them", async () => {
    const t = setup();
    await t.start();
    const view = t.song.view();
    if (view.kind !== "singing") throw new Error("not singing");
    expect(t.pitch.buffers()).toHaveLength(1);
    expect(view.state.lanes[0]?.trace?.readings).toBe(t.pitch.buffers()[0]);
  });

  it("fixes the Mic thresholds at the OpenStar volume of Start", async () => {
    const t = setup();
    t.server({ type: "volume", volume: 40, stepped: false });
    await t.start();
    const view = t.song.view();
    if (view.kind !== "singing") throw new Error("not singing");
    // A Phone's fallback −30 dBFS at volume 80, 40·log10(40/80) dB lower at 40.
    expect(view.state.lanes[0]?.trace?.micThresholdDbfs).toBeCloseTo(
      -30 + 40 * Math.log10(40 / 80),
    );
  });

  it("acts on Pause, Resume (after the 3-2-1 countdown) and Restart from the server", async () => {
    const t = setup();
    await t.start();

    t.control("pause");
    expect(t.log.at(-1)).toBe("pause");
    expect(t.song.view()).toMatchObject({ controls: { phase: "paused" } });

    t.control("resume");
    expect(t.song.view()).toMatchObject({
      controls: { phase: "countdown", count: 3 },
    });
    expect(t.log.at(-1)).toBe("pause");
    t.countdownDone();
    expect(t.log.at(-1)).toBe("resume");

    const buffer = t.pitch.buffers()[0];
    if (!buffer) throw new Error("no buffer");
    const clear = vi.spyOn(buffer, "clear");
    t.control("restart");
    expect(t.log.at(-1)).toBe("restart");
    expect(clear).toHaveBeenCalledOnce();
  });

  it("ignores controls for another Request", async () => {
    const t = setup();
    await t.start();
    t.server({
      type: "controlSong",
      requestId: 99,
      songId: 7,
      control: "pause",
    });
    expect(t.log).toEqual(["start"]);
  });

  it("reports the ended round once when End stops it, one Score per seat", async () => {
    const t = setup();
    await t.start();
    t.control("end");
    expect(t.log.at(-1)).toBe("end");
    await flush();
    expect(t.reachedResults()).toEqual([
      {
        songId: 7,
        requestId: 5,
        noteFingerprint: "f1ng3rpr1nt",
        partyId: "party-1",
        mode: "normal",
        startedAtMs: 1_700_000_000_000,
        ended: "ended",
        scores: [
          expect.objectContaining({
            player: { kind: "profile", profileId: 11 },
            voice: 0,
            difficulty: "hard",
            total: 0,
            micKind: "phone",
            unfinished: true,
            beatRange: { firstBeat: 0, lastBeat: 15 },
          }),
        ],
      },
    ]);
    expect(t.sent.map((m) => m.type)).not.toContain("reachedResults");
    expect(t.song.view()).toMatchObject({ ended: "ended" });
    // A second End, or the media ending after all, raises nothing more.
    t.control("end");
    t.playedOut();
    await flush();
    expect(t.reachedResults()).toHaveLength(1);
    expect(t.pitch.buffers()).toHaveLength(0);
  });

  it("reports an End that comes while the Song still loads once it has loaded, nothing sung", async () => {
    const t = setup();
    t.party({ playing: PLAYING });
    t.control("start");
    t.control("end");
    await flush();
    expect(t.reachedResults()).toEqual([
      expect.objectContaining({
        requestId: 5,
        ended: "ended",
        scores: [
          expect.objectContaining({
            player: { kind: "profile", profileId: 11 },
            total: 0,
            unfinished: true,
            beatValues: Array.from({ length: 16 }, () => ({ kind: "noVoice" })),
          }),
        ],
      }),
    ]);
    t.song.attach({} as HTMLMediaElement);
    await flush();
    expect(t.log).toEqual([]);
  });

  it("reports the played round once when it plays out", async () => {
    const t = setup();
    await t.start();
    t.playedOut();
    t.playedOut();
    await flush();
    expect(t.reachedResults()).toEqual([
      expect.objectContaining({ requestId: 5, ended: "played" }),
    ]);
    expect(t.song.lastRound()).toMatchObject({
      requestId: 5,
      ended: "played",
      startedAtMs: 1_700_000_000_000,
    });
  });

  it("stops the Song on Skip and reports the skipped round once, with no Scores", async () => {
    const t = setup();
    await t.start();
    t.party({ playing: null });
    t.control("skip");
    await flush();
    expect(t.log.at(-1)).toBe("dispose");
    expect(t.reachedResults()).toEqual([]);
    expect(t.rounds).toEqual([
      {
        songId: 7,
        requestId: 5,
        noteFingerprint: "f1ng3rpr1nt",
        partyId: "party-1",
        mode: "normal",
        startedAtMs: 1_700_000_000_000,
        ended: "skipped",
        scores: [],
      },
    ]);
    expect(t.song.view().kind).toBe("idle");
    expect(t.pitch.buffers()).toHaveLength(0);
  });

  it("reports a Skip that comes while the Song still loads, once it has loaded", async () => {
    const t = setup();
    t.party({ playing: PLAYING });
    t.control("start");
    t.party({ playing: null });
    t.control("skip");
    await flush();
    expect(t.rounds).toHaveLength(1);
    expect(t.song.view().kind).toBe("idle");
  });

  it("applies a Pause that came while the Song loaded once it plays", async () => {
    const t = setup();
    t.party({ playing: PLAYING });
    t.control("start");
    t.party({ playing: { ...PLAYING, paused: true } });
    t.control("pause");
    await flush();
    t.song.attach({} as HTMLMediaElement);
    await flush();
    expect(t.log).toEqual(["start", "pause"]);
  });

  it("stops and reports nothing when the Stage's connection drops mid-Song", async () => {
    const t = setup();
    await t.start();
    t.connection("reconnecting");
    expect(t.log.at(-1)).toBe("dispose");
    expect(t.reachedResults()).toEqual([]);
    expect(t.rounds).toEqual([]);
    expect(t.song.view().kind).toBe("idle");
  });

  it("stops when the Party no longer plays the Song (the server dropped it)", async () => {
    const t = setup();
    await t.start();
    t.party({ playing: null });
    expect(t.log.at(-1)).toBe("dispose");
    expect(t.reachedResults()).toEqual([]);
  });

  it("does not play a Song it never heard Start for (a reloaded Stage)", async () => {
    const t = setup();
    t.party({ playing: PLAYING });
    await flush();
    t.song.attach({} as HTMLMediaElement);
    await flush();
    expect(t.song.view().kind).toBe("idle");
    expect(t.log).toEqual([]);
  });

  it("offers to play again when the browser refused to play", async () => {
    let refuse = true;
    const t = setup({
      resumeAudio: () =>
        refuse ? Promise.reject(new Error("no gesture")) : Promise.resolve(),
    });
    await t.start();
    expect(t.song.view()).toMatchObject({ playFailed: true });
    refuse = false;
    t.song.retryPlay();
    await flush();
    expect(t.song.view()).toMatchObject({ playFailed: false });
    expect(t.log).toEqual(["start"]);
  });

  it("scores Mia live: the running Score reaches her lane, and the round carries the outcome", async () => {
    const t = setup();
    await t.start();
    const view = t.song.view();
    if (view.kind !== "singing") throw new Error("not singing");
    const totals: number[] = [];
    t.song.onScoring((change) => totals.push(change.score.total));
    view.clock.play(); // the media plays from Stage time 0

    sing(t, 0, 3); // delivered late, but inside the grace period
    t.frames(2300); // Beat 3 final at 2.0 s + 300 ms
    // 12 scored Beats: 750 points each.
    expect(view.state.lanes[0]?.player?.score).toBe(3000);
    expect(totals.at(-1)).toBe(3000);

    t.playedOut();
    expect(t.framesRunning()).toBe(false);
    const round = t.song.lastRound();
    expect(round?.scoring.noteFingerprint).toBe("f1ng3rpr1nt");
    expect(round?.scoring.players).toEqual([
      expect.objectContaining({
        voice: 0,
        difficulty: "hard",
        micKind: "phone",
        beatRange: { firstBeat: 0, lastBeat: 15 },
        score: { total: 3000, notes: 3000, golden: 0, lineBonus: 0 },
        finished: false,
        micLost: false,
      }),
    ]);
  });

  it("starts the Score over on Restart", async () => {
    const t = setup();
    await t.start();
    const view = t.song.view();
    if (view.kind !== "singing") throw new Error("not singing");
    view.clock.play();
    sing(t, 0, 3);
    t.frames(2300);
    expect(view.state.lanes[0]?.player?.score).toBe(3000);

    t.control("restart");
    view.clock.seek(0); // the media's Restart re-anchors the clock
    expect(view.state.lanes[0]?.player?.score).toBe(0);
    sing(t, 0, 0, 2300);
    t.frames(4600); // Beat 0 final at 1.25 s + 300 ms after the Restart
    expect(view.state.lanes[0]?.player?.score).toBe(750);
  });

  it("starts the round when the Song last started from its beginning: after the last Restart", async () => {
    const t = setup();
    t.setNow(1_000);
    await t.start();
    t.setNow(5_000);
    t.control("restart");
    t.setNow(9_000);
    t.control("end");
    await flush();
    expect(t.reachedResults()).toEqual([
      expect.objectContaining({ startedAtMs: 5_000 }),
    ]);
  });

  it("sends the same outcome again when the answer is lost, and stops on a refusal", async () => {
    const answers: (() => Promise<unknown>)[] = [
      () => Promise.reject(new ApiFailure({ kind: "network" })),
      () => Promise.reject(new ApiFailure({ kind: "unexpected", status: 502 })),
      () => Promise.resolve(),
    ];
    const posted: RoundOutcome[] = [];
    const t = setup({
      postRound: (outcome) => {
        posted.push(outcome);
        return (answers.shift() ?? (() => Promise.resolve()))();
      },
    });
    await t.start();
    t.control("end");
    await flush();
    await flush();
    expect(posted).toHaveLength(3);
    expect(posted[1]).toEqual(posted[0]);
    expect(posted[2]).toEqual(posted[0]);

    const refusedPosts: RoundOutcome[] = [];
    const r = setup({
      postRound: (outcome) => {
        refusedPosts.push(outcome);
        return Promise.reject(
          new ApiFailure({
            kind: "refused",
            status: 409,
            error: { code: "noSongPlaying" },
          }),
        );
      },
    });
    await r.start();
    r.control("end");
    await flush();
    await flush();
    expect(refusedPosts).toHaveLength(1);
  });
});
