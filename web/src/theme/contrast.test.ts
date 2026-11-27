// WCAG 2 contrast between two opaque colours, as the theme tests check text
// against its background.

import { describe, expect, it } from "vitest";

import { contrastRatio } from "./contrast";

describe("contrastRatio", () => {
  it("is 21 for black on white and 1 for a colour on itself", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#2b2d42", "#2b2d42")).toBeCloseTo(1, 5);
  });

  it("is the same either way round", () => {
    expect(contrastRatio("#ffffff", "#2b2d42")).toBe(
      contrastRatio("#2b2d42", "#ffffff"),
    );
  });

  it("puts WCAG's worked grey just under AA on white", () => {
    // #767676 is the lightest grey that meets 4.5 : 1 on white; #777777 is not.
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
  });

  it("reads upper-case hex too", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
  });

  it("refuses what is not a six-digit hex colour", () => {
    expect(() => contrastRatio("rgba(0, 0, 0, 0.4)", "#ffffff")).toThrow();
  });
});
