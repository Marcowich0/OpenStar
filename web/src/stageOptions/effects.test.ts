import { describe, expect, it } from "vitest";

import { STAGE_OPTIONS, effectsOff } from "./stageOptions";

describe("effectsOff, the Stage's reader of Effects off (tickets 260 and 268)", () => {
  it("is off only when the Stage options set Effects to Off, not Calm", () => {
    expect(effectsOff(STAGE_OPTIONS.defaults)).toBe(false);
    const at = (effects: "off" | "calm" | "full") =>
      effectsOff({ ...STAGE_OPTIONS.defaults, effects });
    expect(at("full")).toBe(false);
    expect(at("calm")).toBe(false);
    expect(at("off")).toBe(true);
  });
});
