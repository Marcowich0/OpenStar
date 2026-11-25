import { describe, expect, it } from "vitest";

import { validatePhoneSearch } from "./phoneSearch";

describe("the Phone route's search validator", () => {
  it("keeps a well-formed Join code", () => {
    expect(validatePhoneSearch({ join: "0427" })).toEqual({ join: "0427" });
  });

  it("keeps a Join code the router already parsed as a number", () => {
    // The router JSON-parses search values, so `?join=4271` arrives as 4271.
    expect(validatePhoneSearch({ join: 4271 })).toEqual({ join: "4271" });
  });

  it.each([
    ["too short", "123"],
    ["too long", "12345"],
    ["not digits", "12a4"],
    ["padded", " 1234"],
    ["a short number", 427],
    ["a fraction", 1234.5],
    ["empty", ""],
    ["an object", { code: "1234" }],
    ["a list", ["1234"]],
  ])("drops a malformed Join code (%s)", (_, join) => {
    expect(validatePhoneSearch({ join })).toEqual({});
  });

  it("has no Join code when there is none", () => {
    expect(validatePhoneSearch({})).toEqual({});
  });

  it("drops search parameters it does not know", () => {
    expect(validatePhoneSearch({ join: "1234", other: "x" })).toEqual({
      join: "1234",
    });
  });
});
