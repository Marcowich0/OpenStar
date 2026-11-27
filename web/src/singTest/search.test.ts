import { describe, expect, it } from "vitest";

import { parseSingTestSearch } from "./search";

describe("parseSingTestSearch", () => {
  it("takes a known case and a Song time", () => {
    expect(parseSingTestSearch("?case=duet&t=12.5")).toEqual({
      case: "duet",
      t: 12.5,
      lyricSize: "m",
    });
  });

  it("takes a Lyric size", () => {
    expect(parseSingTestSearch("?case=four&lyricSize=xl")).toMatchObject({
      case: "four",
      lyricSize: "xl",
    });
    expect(parseSingTestSearch("?lyricSize=huge").lyricSize).toBe("m");
  });

  it("falls back to one Player at 6 s for anything else", () => {
    const fallback = { case: "one", t: 6, lyricSize: "m" };
    expect(parseSingTestSearch("?case=nine&t=soon")).toEqual(fallback);
    expect(parseSingTestSearch("?t=")).toEqual(fallback);
    expect(parseSingTestSearch("")).toEqual(fallback);
  });
});
