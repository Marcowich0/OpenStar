import { describe, expect, it } from "vitest";

import { rankTitle } from "./rankTitles";

describe("Rank titles", () => {
  it("names each of the eight Rank title bands", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(rankTitle)).toEqual([
      "Shower Singer",
      "Hummingbird",
      "Warming Up",
      "Getting Loud",
      "Crowd Pleaser",
      "Headliner",
      "Rock Star",
      "OpenStar",
    ]);
  });

  it("keeps a band out of range on the nearest title", () => {
    expect(rankTitle(-1)).toBe("Shower Singer");
    expect(rankTitle(8)).toBe("OpenStar");
  });
});
