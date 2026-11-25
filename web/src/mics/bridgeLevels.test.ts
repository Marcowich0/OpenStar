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
