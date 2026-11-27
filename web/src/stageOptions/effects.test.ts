import { describe, expect, it } from "vitest";

import { STAGE_OPTIONS, effectsOff } from "./stageOptions";

describe("effectsOff, the one reader of Effects (the seam ticket 268 rewires)", () => {
  it("is off only when the Stage options turn Effects off", () => {
    expect(effectsOff(STAGE_OPTIONS.defaults)).toBe(false);
    expect(effectsOff({ ...STAGE_OPTIONS.defaults, effects: false })).toBe(
      true,
    );
  });
});
