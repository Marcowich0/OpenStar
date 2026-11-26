import { describe, expect, it } from "vitest";

import { createSongClock } from "../clock/songClock";
import type { MicId } from "../generated/MicId";
import type { PitchReading } from "../generated/PitchReading";
import type { PitchBuffer } from "./pitchBuffer";
import {
  clockPlacement,
  createPitchRouter,
  type Placement,
} from "./pitchRouter";

const phone = (connection: number): MicId => ({ kind: "phone", connection });

function reading(captureMs: number, pitch: number | null = 60): PitchReading {
  return { captureMs, pitch, clarity: 0.9, loudness: -20 };
}

/** Song time = capture time in seconds. */
const asSeconds: Placement = (r) => r.captureMs / 1000;

function captures(buffer: PitchBuffer | undefined): number[] {
  const out: number[] = [];
  buffer?.forEachFrom(-Infinity, (_t, _p, _c, _l, captureMs) => {
    out.push(captureMs);
  });
  return out;
}

describe("Pitch router", () => {
  it("puts each reading into the buffer of the Player its Mic is assigned to", () => {
    const router = createPitchRouter();
    const buffers = router.start({
      players: 2,
      mics: [
        [phone(7), 1],
        [phone(3), 0],
      ],
      capacity: 8,
      place: asSeconds,
    });

    router.receive(phone(3), reading(100));
    router.receive(phone(7), reading(200));
    router.receive(phone(3), reading(300));

    expect(buffers).toHaveLength(2);
    expect(captures(buffers[0])).toEqual([100, 300]);
    expect(captures(buffers[1])).toEqual([200]);
    expect(buffers[0]?.newestSongTime()).toBe(0.3);
  });

  it("drops a reading from a Mic assigned to no Player", () => {
    const router = createPitchRouter();
    const buffers = router.start({
      players: 1,
      mics: [[phone(1), 0]],
      capacity: 8,
      place: asSeconds,
    });
    router.receive(phone(2), reading(100));
    expect(buffers[0]?.size).toBe(0);
  });

  it("drops every reading while no Song has started", () => {
    const router = createPitchRouter();
    router.receive(phone(1), reading(100));
    expect(router.buffers()).toEqual([]);
  });

  it("drops a reading placement refuses", () => {
    const router = createPitchRouter();
    const buffers = router.start({
      players: 1,
      mics: [[phone(1), 0]],
      capacity: 8,
      place: (r) => (r.captureMs < 500 ? null : r.captureMs / 1000),
    });
    router.receive(phone(1), reading(100));
    router.receive(phone(1), reading(600));
    expect(captures(buffers[0])).toEqual([600]);
  });

  it("tells the session of every reading from a Mic of the Song, also one placement drops", () => {
    const router = createPitchRouter();
    const heard: number[] = [];
    router.start({
      players: 2,
      mics: [[phone(7), 1]],
      capacity: 8,
      place: () => null,
      heard: (player) => heard.push(player),
    });
    router.receive(phone(7), reading(10));
    router.receive(phone(3), reading(20));
    expect(heard).toEqual([1]);
    router.stop();
    router.receive(phone(7), reading(30));
    expect(heard).toEqual([1]);
  });

  it("tells the session when a Mic of the Song closes, and that it is back at its next reading", () => {
    const router = createPitchRouter();
    const events: string[] = [];
    router.start({
      players: 2,
      mics: [
        [phone(7), 1],
        [phone(4), 0],
      ],
      capacity: 8,
      place: asSeconds,
      heard: (player) => events.push(`reading ${String(player)}`),
      signal: (player, kind) => events.push(`${kind} ${String(player)}`),
    });
    router.signal(phone(7), "connectionClosed");
    router.signal(phone(3), "connectionClosed"); // not in this Song
    router.receive(phone(7), reading(10));
    router.receive(phone(7), reading(20));
    router.signal(phone(4), "pageHidden");
    router.signal(phone(4), "pageVisible");
    expect(events).toEqual([
      "connectionClosed 1",
      "connectionBack 1",
      "reading 1",
      "reading 1",
      "pageHidden 0",
      "pageVisible 0",
    ]);
    router.stop();
    router.signal(phone(7), "connectionClosed");
    expect(events).toHaveLength(6);
  });

  it("forgets a closed Mic at the next Start", () => {
    const router = createPitchRouter();
    const events: string[] = [];
    const session = {
      players: 1,
      mics: [[phone(7), 0]] as const,
      capacity: 8,
      place: asSeconds,
      signal: (_: number, kind: string) => events.push(kind),
    };
    router.start(session);
    router.signal(phone(7), "connectionClosed");
    router.start(session);
    router.receive(phone(7), reading(10));
    expect(events).toEqual(["connectionClosed"]);
  });

  it("tells placement which Player the reading belongs to", () => {
    const router = createPitchRouter();
    const seen: number[] = [];
    router.start({
      players: 2,
      mics: [[phone(5), 1]],
      capacity: 8,
      place: (r, player) => {
        seen.push(player);
        return r.captureMs / 1000;
      },
    });
    router.receive(phone(5), reading(100));
    expect(seen).toEqual([1]);
  });

  it("gives every Player a buffer of the capacity fixed at Start", () => {
    const router = createPitchRouter();
    const buffers = router.start({
      players: 3,
      mics: [],
      capacity: 42,
      place: asSeconds,
    });
    expect(buffers.map((buffer) => buffer.capacity)).toEqual([42, 42, 42]);
    expect(router.buffers()).toBe(buffers);
  });

  it("stops routing when the Song stops", () => {
    const router = createPitchRouter();
    const buffers = router.start({
      players: 1,
      mics: [[phone(1), 0]],
      capacity: 8,
      place: asSeconds,
    });
    router.stop();
    router.receive(phone(1), reading(100));
    expect(buffers[0]?.size).toBe(0);
    expect(router.buffers()).toEqual([]);
  });

  it("starts each Song with fresh, empty buffers", () => {
    const router = createPitchRouter();
    const first = router.start({
      players: 1,
      mics: [[phone(1), 0]],
      capacity: 8,
      place: asSeconds,
    });
    router.receive(phone(1), reading(100));
    const second = router.start({
      players: 1,
      mics: [[phone(1), 0]],
      capacity: 8,
      place: asSeconds,
    });
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]?.size).toBe(0);
  });

  it("refuses a Mic assigned to a Player outside the Line-up", () => {
    const router = createPitchRouter();
    expect(() =>
      router.start({
        players: 1,
        mics: [[phone(1), 1]],
        capacity: 8,
        place: asSeconds,
      }),
    ).toThrow(RangeError);
  });
});

describe("placement on the Song clock", () => {
  it("places a reading with its Player's Mic delay, and drops one before playback", () => {
    let now = 0;
    const clock = createSongClock({ media: "audio", now: () => now });
    now = 1000;
    clock.play();
    now = 3000;
    const delays = [100, 250];
    const place = clockPlacement(clock, (player) => delays[player] ?? 0);

    // Captured at 2600 ms with a 100 ms delay: sung at 2500 ms, 1.5 s in.
    expect(place(reading(2600), 0)).toBeCloseTo(1.5, 9);
    // The same capture on Player 1's Mic (250 ms): 1.35 s in.
    expect(place(reading(2600), 1)).toBeCloseTo(1.35, 9);
    // Sung before playback began.
    expect(place(reading(900), 0)).toBeNull();
  });
});
