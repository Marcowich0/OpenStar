// The golden Note glint's rate limit (#262): at most once per 250 ms per seat.

import { describe, expect, it } from "vitest";

import { GOLDEN_HIT_INTERVAL_MS, createGoldenHits } from "./goldenHits";

function setUp() {
  let nowMs = 1000;
  let played = 0;
  const hits = createGoldenHits({
    play: () => {
      played++;
    },
    now: () => nowMs,
  });
  return {
    hits,
    played: () => played,
    at: (ms: number) => {
      nowMs = ms;
    },
  };
}

describe("golden Note glints", () => {
  it("play at most once per 250 ms per seat", () => {
    expect(GOLDEN_HIT_INTERVAL_MS).toBe(250);
    const t = setUp();
    for (let ms = 1000; ms < 2000; ms += 20) {
      t.at(ms);
      t.hits.hit(0);
    }
    // 1000, 1260, 1520, 1780: every hit 250 ms or more after the last glint.
    expect(t.played()).toBe(4);
  });

  it("plays again exactly 250 ms after the last glint", () => {
    const t = setUp();
    t.hits.hit(0);
    t.at(1249);
    t.hits.hit(0);
    expect(t.played()).toBe(1);
    t.at(1250);
    t.hits.hit(0);
    expect(t.played()).toBe(2);
  });

  it("limits each seat on its own", () => {
    const t = setUp();
    t.hits.hit(0);
    t.hits.hit(1);
    t.hits.hit(0);
    t.hits.hit(1);
    expect(t.played()).toBe(2);
  });
});
