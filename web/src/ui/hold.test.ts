import { describe, expect, it } from "vitest";

import { HOLD_DURATION_MS, IDLE, holdStep, type HoldState } from "./hold";

describe("hold timing", () => {
  it("is one 700 ms constant", () => {
    expect(HOLD_DURATION_MS).toBe(700);
  });

  const pressed: HoldState = { phase: "holding", since: 1000 };

  it("starts holding on a press", () => {
    expect(holdStep(IDLE, { type: "press", at: 1000 })).toEqual({
      state: pressed,
      fire: false,
      hint: false,
    });
  });

  it("completes at 700 ms and fires once", () => {
    const done = holdStep(pressed, { type: "tick", at: 1700 });
    expect(done).toEqual({ state: IDLE, fire: true, hint: false });
    // A late release after completion fires nothing more.
    expect(holdStep(done.state, { type: "release", at: 1750 })).toEqual({
      state: IDLE,
      fire: false,
      hint: false,
    });
  });

  it("does not complete before 700 ms", () => {
    expect(holdStep(pressed, { type: "tick", at: 1699 })).toEqual({
      state: pressed,
      fire: false,
      hint: false,
    });
  });

  it("cancels on an early release and shows the hint", () => {
    expect(holdStep(pressed, { type: "release", at: 1100 })).toEqual({
      state: IDLE,
      fire: false,
      hint: true,
    });
  });

  it("fires on a release at 700 ms that comes before the timer", () => {
    expect(holdStep(pressed, { type: "release", at: 1700 })).toEqual({
      state: IDLE,
      fire: true,
      hint: false,
    });
  });

  it("cancels without the hint when the pointer leaves", () => {
    expect(holdStep(pressed, { type: "leave" })).toEqual({
      state: IDLE,
      fire: false,
      hint: false,
    });
  });

  it("ignores a second press while holding, so a held key's repeats do not restart it", () => {
    expect(holdStep(pressed, { type: "press", at: 1300 }).state).toEqual(
      pressed,
    );
  });

  it("ignores ticks and releases while idle", () => {
    expect(holdStep(IDLE, { type: "tick", at: 5000 }).fire).toBe(false);
    expect(holdStep(IDLE, { type: "release", at: 5000 }).hint).toBe(false);
  });
});
