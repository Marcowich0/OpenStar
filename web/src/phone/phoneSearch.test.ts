import { describe, expect, it } from "vitest";

import { isJoinCode, validatePhoneSearch } from "./phoneSearch";

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
    ["not digits", "12ab"],
    ["padded", " 1234"],
  ])(
    "keeps a malformed Join code (%s), so the Phone can say it is not on the Stage",
    (_, join) => {
      expect(validatePhoneSearch({ join })).toEqual({ join });
    },
  );

  it("keeps a short number as its digits", () => {
    expect(validatePhoneSearch({ join: 427 })).toEqual({ join: "427" });
  });

  it.each([
    ["empty", ""],
    ["a fraction", 1234.5],
    ["an object", { code: "1234" }],
    ["a list", ["1234"]],
  ])("drops a Join code that is no text (%s)", (_, join) => {
    expect(validatePhoneSearch({ join })).toEqual({});
  });

  it.each([
    ["4 digits", "0427", true],
    ["3 digits", "427", false],
    ["letters", "12ab", false],
  ])("tells a Join code apart from other text (%s)", (_, text, ok) => {
    expect(isJoinCode(text)).toBe(ok);
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
