import { describe, expect, it } from "vitest";

import type { ClientMessage } from "../../generated/ClientMessage";
import type { MicId } from "../../generated/MicId";
import type { PitchReading } from "../../generated/PitchReading";
import { createStageMicSettings } from "../../mics/stageMicSettings";
import { startStageMicReports } from "./StageMicReports";

function fakeStore() {
  const sent: ClientMessage[] = [];
  let reading: ((mic: MicId, r: PitchReading) => void) | null = null;
  let request: ((mic: MicId) => void) | null = null;
  return {
    sent,
    send: (message: ClientMessage) => {
      sent.push(message);
      return true;
    },
    onPitchReading: (listener: (mic: MicId, r: PitchReading) => void) => {
      reading = listener;
      return () => {
        reading = null;
      };
    },
    onMicReportRequest: (listener: (mic: MicId) => void) => {
      request = listener;
      return () => {
        request = null;
      };
    },
    read: (mic: MicId, r: PitchReading) => reading?.(mic, r),
    ask: (mic: MicId) => request?.(mic),
  };
}

const BO: MicId = { kind: "phone", phoneId: "bo" };

describe("the Stage's answers to a Phone's mic diagnostics", () => {
  it("counts the Phone's readings and answers with them and the Mic settings Start would use", () => {
    let now = 5000;
    const store = fakeStore();
    const settings = createStageMicSettings();
    settings.set({
      stageOutput: "Speakers",
      mics: [
        {
          mic: { kind: "phone", phoneId: "bo" },
          settings: {
            calibration: { micDelayMs: 240, bleedLevelDbfs: -44 },
            micThreshold: { referenceDbfs: -37, setBy: "hand" },
          },
        },
      ],
    });
    const reporter = startStageMicReports(store, {
      now: () => now,
      volume: () => 80,
      settings,
    });
    for (let k = 0; k < 50; k++) {
      now = 5000 + 10 * k;
      store.read(BO, {
        captureMs: now - 70,
        pitch: 60,
        clarity: 0.9,
        loudness: -28,
      });
    }
    // A bridge's Local mic is not a Phone: not counted.
    store.read(
      { kind: "bridge", bridgeId: "b", localMicId: "bridge:b:card:0" },
      { captureMs: now, pitch: null, clarity: 0, loudness: -90 },
    );
    store.ask(BO);
    expect(store.sent).toEqual([
      {
        type: "micReport",
        mic: BO,
        report: {
          receivedPerSecond: 50,
          arrivalP50Ms: 70,
          arrivalP95Ms: 70,
          arrivalMaxMs: 70,
          largestGapMs: 10,
          lateShare: 0,
          loudnessDbfs: -28,
          micDelayMs: 240,
          micThresholdDbfs: -37,
        },
      },
    ]);
    expect([...reporter.reports().keys()]).toEqual(["bo"]);

    reporter.stop();
    store.ask(BO);
    expect(store.sent).toHaveLength(1);
  });

  it("answers a Phone it has heard nothing from with its defaults", () => {
    const store = fakeStore();
    startStageMicReports(store, {
      now: () => 0,
      volume: () => 80,
      settings: createStageMicSettings(),
    });
    store.ask(BO);
    expect(store.sent[0]).toMatchObject({
      type: "micReport",
      report: {
        receivedPerSecond: 0,
        arrivalP50Ms: null,
        micDelayMs: 100,
        micThresholdDbfs: -30,
      },
    });
  });
});
