// WCAG 2 contrast between two opaque colours, as the theme tests check text
// against its background.

import { describe, expect, it } from "vitest";

import { colourDistance, contrastRatio, over, VISIONS } from "./contrast";

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

describe("over", () => {
  it("lays a colour at an alpha over an opaque background", () => {
    expect(over("#ffffff", 1, "#000000")).toBe("#ffffff");
    expect(over("#ffffff", 0, "#2b2d42")).toBe("#2b2d42");
    // Blended in sRGB, as the browser draws `color-mix(in srgb …)` and opacity.
    expect(over("#ffffff", 0.5, "#000000")).toBe("#808080");
    expect(over("#ff0000", 0.25, "#ffffff")).toBe("#ffbfbf");
  });
});

describe("colourDistance", () => {
  it("is CIE76 ΔE: 100 from black to white, 0 for a colour and itself", () => {
    expect(colourDistance("#000000", "#ffffff")).toBeCloseTo(100, 1);
    expect(colourDistance("#9b5cff", "#9b5cff")).toBe(0);
  });

  it("puts pure red at CIELAB (53.2, 80.1, 67.2), its textbook value", () => {
    // Distance from black is then √(53.2² + 80.1² + 67.2²) ≈ 117.3.
    expect(colourDistance("#ff0000", "#000000")).toBeCloseTo(117.3, 0);
  });

  it("brings red and green much closer for red-green colour-blind viewers, not for blue-yellow", () => {
    const normal = colourDistance("#ff4b5c", "#3ddc84");
    for (const vision of ["protan", "deutan"] as const) {
      expect(colourDistance("#ff4b5c", "#3ddc84", vision)).toBeLessThan(
        normal / 2,
      );
    }
    expect(colourDistance("#ff4b5c", "#3ddc84", "tritan")).toBeGreaterThan(
      normal / 2,
    );
  });

  it("keeps black and white apart in every vision", () => {
    for (const vision of VISIONS) {
      expect(colourDistance("#000000", "#ffffff", vision)).toBeCloseTo(100, 0);
    }
  });
});
