import { describe, expect, it } from "vitest";

import { validateSingTestSearch } from "./singTestSearch";

describe("validateSingTestSearch", () => {
  it("takes a known case and a Song time", () => {
    expect(validateSingTestSearch({ case: "duet", t: 12.5 })).toEqual({
      case: "duet",
      t: 12.5,
    });
  });

  it("falls back to one Player at 6 s for anything else", () => {
    expect(validateSingTestSearch({ case: "nine", t: "soon" })).toEqual({
      case: "one",
      t: 6,
    });
    expect(validateSingTestSearch({})).toEqual({ case: "one", t: 6 });
  });
});
