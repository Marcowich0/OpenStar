import { describe, expect, it } from "vitest";

import css from "./stageFrame.css?raw";

const flat = css.replace(/\s+/g, " ");

describe("the Stage's focus ring", () => {
  it("is a 6 px yellow ring, then a 10 px ink edge, keeping the ledge", () => {
    expect(flat).toContain(
      "box-shadow: 0 0 0 6px var(--color-yellow), 0 0 0 10px var(--color-ink), var(--tw-shadow, 0 0 transparent);",
    );
  });

  it("grows the focused element to 103 % with the spring easing", () => {
    expect(flat).toContain("scale: 1.03;");
    expect(flat).toContain("scale 0.25s var(--ease-spring)");
  });

  it("applies to every button and marked element in the frame, on focus", () => {
    expect(flat).toContain(
      "[data-stage-frame] :is(button, [data-stage-focus]):focus {",
    );
  });
});
