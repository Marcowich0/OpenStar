// What Start hands the scorer and the traces for each seated Mic (#169):
// the values stored at the current Stage output (or the defaults), with the
// Mic threshold fixed at the OpenStar volume of that Start.

import { afterEach, describe, expect, it } from "vitest";

import type { MicId } from "../../../generated/MicId";
import type { ServerMessage } from "../../../generated/ServerMessage";
import type { StageOutputMicSettings } from "../../../generated/StageOutputMicSettings";
import type { LiveClientOptions } from "../../../live/liveClient";
import { createLiveStore } from "../../../live/liveStore";
import { stageMicSettings } from "../../../mics/stageMicSettings";
import { createPitchRouter } from "../../../pitch/pitchRouter";
import { createStageSong, type StageSong } from "./stageSong";
import { PROFILES, testDetail, testParty } from "./testSong";

const PLAYING = { requestId: 5, songId: 7, paused: false };
const MIA_MIC: MicId = { kind: "phone", phoneId: "phone-mia" };

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function setup() {
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  const pitch = createPitchRouter();
  const store = createLiveStore(
    (given) => {
      handlers = given;
      return { send: () => true, close: () => {} };
    },
    undefined,
    pitch,
  );
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
  let stageMs = 0;
  let nextFrame: (() => void) | null = null;
  const song: StageSong = createStageSong({
    store,
    loadSong: () => Promise.resolve(testDetail()),
    profiles: () => PROFILES,
    pitch,
    createPlayback: ({ onEnded }) => ({
      start: () => Promise.resolve(),
      pause: () => {},
      resume: () => Promise.resolve(),
      restart: () => Promise.resolve(),
      seek: () => {},
      end: () => {
        onEnded("ended");
      },
      dispose: () => {},
    }),
    resumeAudio: () => Promise.resolve(),
    postRound: () => Promise.resolve(),
    wait: () => Promise.resolve(),
    stageNow: () => stageMs,
    requestFrame: (callback) => {
      nextFrame = callback;
      return 1;
    },
    cancelFrame: () => {
      nextFrame = null;
    },
  });
  const volume = (v: number, stepped = true) => {
    server({ type: "volume", volume: v, stepped });
  };
  const start = async () => {
    server({
      type: "partyChanged",
      party: testParty({ playing: PLAYING }),
      change: {
        actor: { kind: "stage" },
        event: {
          code: "songStarted",
          params: { requestId: 5, songId: 7, title: "Test Song" },
        },
      },
    });
    server({ type: "controlSong", requestId: 5, songId: 7, control: "start" });
    await flush();
    song.attach({} as HTMLMediaElement);
    await flush();
    // The media plays from the Stage time of Start.
    const view = song.view();
    if (view.kind === "singing") view.clock.play();
  };
  /** Mia's lane's trace threshold, as the sing screen draws it. */
  const traceThreshold = () => {
    const view = song.view();
    if (view.kind !== "singing") throw new Error("not singing");
    return view.state.lanes[0]?.trace?.micThresholdDbfs;
  };
  /**
   * Mia sings Beats 0–3 (the test Song: #GAP 1 s, 250 ms Beats) in tune at
   * `loudness` dBFS, each reading stamped `delayMs` after the moment sung.
   */
  const sing = (loudness: number, delayMs = 100) => {
    const frames = (ms: number) => {
      while (stageMs < ms) {
        stageMs = Math.min(stageMs + 20, ms);
        nextFrame?.();
      }
    };
    const receive = (captureMs: number, p: number | null, l: number) => {
      pitch.receive(MIA_MIC, {
        captureMs,
        pitch: p,
        clarity: 0.95,
        loudness: l,
      });
    };
    frames(600);
    receive(600, null, -90);
    for (let b = 0; b <= 3; b++) {
      const beatMs = 1000 + 250 * b;
      frames(beatMs + 250 + 150);
      for (const offset of [25, 85, 145, 205]) {
        receive(beatMs + offset + delayMs, 60, loudness);
      }
    }
    // Beat 3 is final at 2.0 s + 300 ms; leave room for late placements.
    frames(stageMs + 1000);
  };
  /** Ends the Song and gives Mia's live-scored total. */
  const end = () => {
    server({ type: "controlSong", requestId: 5, songId: 7, control: "end" });
    return song.lastRound()?.scoring.players[0]?.score.total ?? null;
  };
  return { song, volume, start, traceThreshold, sing, end };
}

const MIA_CALIBRATED: StageOutputMicSettings = {
  stageOutput: "Speakers",
  mics: [
    {
      mic: { kind: "phone", phoneId: "phone-mia" },
      // Bleed −20 dBFS: her threshold is −14 dBFS at volume 80.
      settings: { calibration: { micDelayMs: 100, bleedLevelDbfs: -20 } },
    },
  ],
};

afterEach(() => {
  stageMicSettings().set(null);
});

describe("Mic settings handed over at Start", () => {
  it("sings an uncalibrated Phone on −30 dBFS at volume 80, and its singing at −10 dBFS scores", async () => {
    const t = setup();
    t.volume(80, false);
    await t.start();
    expect(t.traceThreshold()).toBe(-30);
    t.sing(-10);
    expect(t.end()).toBeGreaterThan(0);
  });

  it("hands the scorer a calibrated Mic's threshold: singing below it is no voice", async () => {
    stageMicSettings().set(MIA_CALIBRATED);
    const t = setup();
    t.volume(80, false);
    await t.start();
    expect(t.traceThreshold()).toBe(-14);
    t.sing(-16);
    expect(t.end()).toBe(0);
  });

  it("keeps the threshold of Start when the volume changes during the Song; the next Song uses the volume at its own Start", async () => {
    const t = setup();
    t.volume(80, false);
    await t.start();
    // Louder during the Song: −30 + 40·log10(100/80) ≈ −26.1 if it moved.
    t.volume(100);
    expect(t.traceThreshold()).toBe(-30);
    // Singing at −28 dBFS passes −30 but not −26.1: it still scores.
    t.sing(-28);
    expect(t.end()).toBeGreaterThan(0);

    await t.start();
    expect(t.traceThreshold()).toBeCloseTo(-30 + 40 * Math.log10(100 / 80));
  });

  it("places readings with the stored Mic delay, adding nothing for the Stage's output delay", async () => {
    stageMicSettings().set({
      stageOutput: "Speakers",
      mics: [
        {
          mic: { kind: "phone", phoneId: "phone-mia" },
          settings: { calibration: { micDelayMs: 400, bleedLevelDbfs: -60 } },
        },
      ],
    });
    const t = setup();
    await t.start();
    // Every reading stamped 400 ms after the moment sung: all 12 Beats hit.
    t.sing(-10, 400);
    expect(t.end()).toBe(3000);
    expect(t.song.lastRound()?.setup.players[0]?.micDelayMs).toBe(400);
  });

  it("uses values stored after a Calibration at the next Start, without a reload", async () => {
    const t = setup();
    t.volume(80, false);
    await t.start();
    expect(t.traceThreshold()).toBe(-30);
    t.end();

    // The loader refetched after the `micSettings` notice.
    stageMicSettings().set(MIA_CALIBRATED);
    await t.start();
    expect(t.traceThreshold()).toBe(-14);
  });

  it("starts on the defaults while no Stage output's values are loaded, and before the server tells the volume", async () => {
    const t = setup();
    await t.start();
    expect(t.song.view().kind).toBe("singing");
    expect(t.traceThreshold()).toBe(-30);
  });
});
