import { describe, expect, it } from "vitest";

import { parseSingTestSearch } from "./search";

describe("parseSingTestSearch", () => {
  it("takes a known case and a Song time", () => {
    expect(parseSingTestSearch("?case=duet&t=12.5")).toEqual({
      case: "duet",
      t: 12.5,
    });
  });

  it("takes the no-video case", () => {
    expect(parseSingTestSearch("?case=noVideo&t=6").case).toBe("noVideo");
  });

  it("falls back to one Player at 6 s for anything else", () => {
    expect(parseSingTestSearch("?case=nine&t=soon")).toEqual({
      case: "one",
      t: 6,
    });
    expect(parseSingTestSearch("?t=")).toEqual({ case: "one", t: 6 });
    expect(parseSingTestSearch("")).toEqual({ case: "one", t: 6 });
  });
});
