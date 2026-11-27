import { describe, expect, it } from "vitest";

import css from "./stageFrame.css?raw";

const flat = css.replace(/\s+/g, " ");

describe("the Stage's focus ring", () => {
  it("is a 6 px yellow ring, then a 10 px ink edge, keeping the ledge", () => {
    expect(flat).toContain(
      "box-shadow: 0 0 0 6px var(--color-yellow), 0 0 0 10px var(--color-ink), var(--tw-shadow, 0 0 transparent);",
    );
  });

  it("bounces the focused element 1 → 1.06 → 1 as the ring lands (ticket 260)", () => {
    // `--animate-focus-bounce` is the motion tokens' `focus-bounce`, which
    // peaks at `--motion-focus-scale` (1.06); "fade" turns it off.
    expect(flat).toContain("animation: var(--animate-focus-bounce);");
  });

  it("squashes a pressed element with the press tokens and springs it back", () => {
    expect(flat).toContain("scale: var(--motion-press-scale);");
    expect(flat).toContain("scale var(--motion-press) var(--ease-spring)");
    expect(flat).toContain(
      ":is( :active, [data-pressed], [data-stage-pressed] )",
    );
  });

  it("applies to every button and marked element in the frame, on focus", () => {
    expect(flat).toContain(
      "[data-stage-frame] :is(button, [data-stage-focus]):focus {",
    );
  });
});
