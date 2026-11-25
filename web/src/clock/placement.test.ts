import { describe, expect, it } from "vitest";

import { placedSongTime, placeReading } from "./placement";
import { createSongClock, type ClockMedia, type SongClock } from "./songClock";

/** One Mic's kind, as the fixtures name it. Placement treats them all alike. */
type MicKind = "phone" | "micBridge" | "localMic";

type ClockEvent =
  | { at: number; event: "play" | "pause" | "stall" }
  | { at: number; event: "seek"; position: number }
  | { at: number; event: "setRate"; rate: number };

interface PlacementCase {
  name: string;
  mic: MicKind;
  captureTime: number;
  micDelayMs: number;
  placedAt: number;
  songTime: number | null;
}

interface PlacementFixture {
  description: string;
  media: ClockMedia;
  clock: ClockEvent[];
  readings: PlacementCase[];
}

const files = import.meta.glob<string>(
  "../../../fixtures/scoring/placement/*.json",
  { query: "?raw", import: "default", eager: true },
);

const fixtures = Object.entries(files).map(([path, text]) => ({
  file: path.split("/").pop() ?? path,
  ...(JSON.parse(text) as PlacementFixture),
}));

/** A Song clock that has lived through `events`, read at Stage time `at`. */
function clockAt(fixture: PlacementFixture, at: number): SongClock {
  let t = 0;
  const clock = createSongClock({ media: fixture.media, now: () => t });
  for (const e of fixture.clock) {
    if (e.at > at) break;
    t = e.at;
    switch (e.event) {
      case "play":
        clock.play();
        break;
      case "pause":
        clock.pause();
        break;
      case "stall":
        clock.stall();
        break;
      case "seek":
        clock.seek(e.position);
        break;
      case "setRate":
        clock.setRate(e.rate);
        break;
    }
  }
  t = at;
  return clock;
}

const MIC_KINDS: MicKind[] = ["phone", "micBridge", "localMic"];

it("finds the placement fixtures", () => {
  expect(fixtures.map((f) => f.file)).toEqual(
    expect.arrayContaining([
      "pause-and-countdown.json",
      "restart.json",
      "stall.json",
    ]),
  );
});

describe.each(fixtures)("$file", (fixture) => {
  it.each(fixture.readings)("$name", (c) => {
    const clock = clockAt(fixture, c.placedAt);
    const reading = {
      mic: c.mic,
      captureTime: c.captureTime,
      pitch: 69,
      clarity: 0.9,
    };
    const placed = placeReading(clock, reading, c.micDelayMs);
    if (c.songTime === null) {
      expect(placed).toBeNull();
    } else {
      expect(placed?.songTime).toBeCloseTo(c.songTime, 9);
      // The reading reaches the scorer unchanged apart from its Song time.
      expect(placed).toMatchObject(reading);
    }
  });

  it.each(fixture.readings)(
    "$name: the same for a Phone, a Mic bridge and a Local mic",
    (c) => {
      const clock = clockAt(fixture, c.placedAt);
      const results = MIC_KINDS.map(
        (mic) =>
          placeReading(clock, { mic, captureTime: c.captureTime }, c.micDelayMs)
            ?.songTime ?? null,
      );
      expect(new Set(results).size).toBe(1);
    },
  );

  it.each(fixture.readings)(
    "$name: the allocation-free form gives the same Song time",
    (c) => {
      const clock = clockAt(fixture, c.placedAt);
      const songTime = placedSongTime(clock, c.captureTime, c.micDelayMs);
      expect(songTime).toBe(
        placeReading(clock, { captureTime: c.captureTime }, c.micDelayMs)
          ?.songTime ?? null,
      );
      if (c.songTime !== null) expect(songTime).toBeCloseTo(c.songTime, 9);
    },
  );
});

describe("what placement reads", () => {
  it("takes only the clock, the reading and the Mic delay: the A/V offset never enters", () => {
    // The A/V offset shifts drawing only. Placement has no way to receive it.
    expect(placeReading.length).toBe(3);
  });

  it("drops a reading whose moment is later than now", () => {
    let t = 0;
    const clock = createSongClock({ media: "audio", now: () => t });
    clock.play();
    t = 1000;
    expect(placeReading(clock, { captureTime: 1200 }, 100)).toBeNull();
  });
});
