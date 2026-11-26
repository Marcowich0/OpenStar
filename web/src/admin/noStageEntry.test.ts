import { describe, expect, it } from "vitest";

// v1 spec #45: the Stage's sofa interface (the S, Q and P overlays) has no
// admin entry, and `/stage` is never navigated away from: on the Stage
// computer the Admin area opens in its own browser tab. So no Stage code
// names the Admin area's path or imports its code.
const stageSources = import.meta.glob<string>(
  ["../stage/**/*.{ts,tsx}", "!../stage/**/*.test.{ts,tsx}"],
  { query: "?raw", import: "default", eager: true },
);

describe("the Stage", () => {
  it("has Stage code to look at", () => {
    expect(Object.keys(stageSources).length).toBeGreaterThan(10);
  });

  it.each(Object.entries(stageSources))(
    "%s has no route or link to the Admin area",
    (_file, source) => {
      expect(source).not.toMatch(/["'`]\/admin\b/);
      expect(source).not.toMatch(/from\s+["'][./]*admin\//);
    },
  );
});
