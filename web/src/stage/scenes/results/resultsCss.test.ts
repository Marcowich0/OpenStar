import { describe, expect, it } from "vitest";

import css from "./results.css?raw";

const flat = css.replace(/\s+/g, " ");

describe("the results screen's motion", () => {
  it("grows the bars with the spring easing", () => {
    expect(flat).toContain(
      "animation: results-bar-grow 1.1s var(--ease-spring) both;",
    );
  });

  it("holds the bars and the sticker still in the fade motion mode: reduced motion or Effects off (#260)", () => {
    // `MotionMode` sets it from `prefersReducedMotion()` and `effectsOff`.
    expect(flat).toContain(
      ':root[data-motion="fade"] :is(.results-bar, .results-sticker) { animation: none; }',
    );
  });
});
