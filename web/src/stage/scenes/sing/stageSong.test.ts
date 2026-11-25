import { describe, expect, it, vi } from "vitest";

import type { ClientMessage } from "../../../generated/ClientMessage";
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
  let resumeLater: (() => void) | null = null;
  const rounds: RoundOutcome[] = [];
  const pitch = createPitchRouter();
  const loadSong = vi.fn(() => Promise.resolve(testDetail()));
  let playback: ReturnType<typeof fakePlayback> | null = null;
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
    now: () => 1_700_000_000_000,
    schedule: (run) => {
      resumeLater = run;
      return () => {
        resumeLater = null;
      };
    },
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
  const reachedResults = () => sent.filter((m) => m.type === "reachedResults");

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
    reachedResults,
    connection,
    playedOut: () => ended?.("played"),
    countdownDone: () => {
      // The countdown's steps and its end are all scheduled; run them all.
      resumeLater?.();
    },
    playback: () => playback,
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

  it("raises one end of the Song when End stops it", async () => {
    const t = setup();
    await t.start();
    t.control("end");
    expect(t.log.at(-1)).toBe("end");
    expect(t.reachedResults()).toEqual([
      { type: "reachedResults", requestId: 5, ended: "ended" },
    ]);
    expect(t.song.view()).toMatchObject({ ended: "ended" });
    // A second End, or the media ending after all, raises nothing more.
    t.control("end");
    t.playedOut();
    expect(t.reachedResults()).toHaveLength(1);
    expect(t.pitch.buffers()).toHaveLength(0);
  });

  it("raises the end of the Song for an End that comes while the Song still loads", async () => {
    const t = setup();
    t.party({ playing: PLAYING });
    t.control("start");
    t.control("end");
    await flush();
    expect(t.reachedResults()).toEqual([
      { type: "reachedResults", requestId: 5, ended: "ended" },
    ]);
    t.song.attach({} as HTMLMediaElement);
    await flush();
    expect(t.log).toEqual([]);
  });

  it("raises one end of the Song when it plays out", async () => {
    const t = setup();
    await t.start();
    t.playedOut();
    t.playedOut();
    expect(t.reachedResults()).toEqual([
      { type: "reachedResults", requestId: 5, ended: "played" },
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
});
