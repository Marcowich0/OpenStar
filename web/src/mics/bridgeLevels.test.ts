import { describe, expect, it } from "vitest";

import { LEVEL_STALE_MS, createBridgeLevels } from "./bridgeLevels";

describe("bridge levels", () => {
  it("give a Local mic's latest level", () => {
    const levels = createBridgeLevels();
    levels.receive(
      [
        { localMicId: "bridge:b:x.wav:0", levelDbfs: -20 },
        { localMicId: "bridge:b:x.wav:1", levelDbfs: -100 },
      ],
      1000,
    );
    levels.receive([{ localMicId: "bridge:b:x.wav:0", levelDbfs: -8 }], 1100);
    expect(levels.levelDbfs("bridge:b:x.wav:0", 1150)).toBe(-8);
    expect(levels.levelDbfs("bridge:b:x.wav:1", 1150)).toBe(-100);
  });

  it("know nothing of a Local mic the bridge never sent", () => {
    expect(createBridgeLevels().levelDbfs("bridge:b:x.wav:3", 0)).toBeNull();
  });

  it("forget a level once the bridge has stopped sending it", () => {
    const levels = createBridgeLevels();
    levels.receive([{ localMicId: "bridge:b:x.wav:0", levelDbfs: -8 }], 1000);
    expect(levels.levelDbfs("bridge:b:x.wav:0", 1000 + LEVEL_STALE_MS)).toBe(
      -8,
    );
    expect(
      levels.levelDbfs("bridge:b:x.wav:0", 1001 + LEVEL_STALE_MS),
    ).toBeNull();
  });
});

describe("a bridge Local mic's digital silence", () => {
  it("is what the latest level says, and unknown once stale or never sent", () => {
    const levels = createBridgeLevels();
    const id = "bridge:b:x.wav:2";
    expect(levels.digitalZero(id, 0)).toBeNull();
    levels.receive(
      [{ localMicId: id, levelDbfs: -100, digitalSilence: true }],
      1000,
    );
    expect(levels.digitalZero(id, 1050)).toBe(true);
    levels.receive(
      [{ localMicId: id, levelDbfs: -100, digitalSilence: false }],
      1100,
    );
    expect(levels.digitalZero(id, 1150)).toBe(false);
    expect(levels.digitalZero(id, 1100 + LEVEL_STALE_MS + 1)).toBeNull();
  });
});
