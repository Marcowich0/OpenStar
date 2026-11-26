import { describe, expect, it } from "vitest";

import type { RequestId } from "../generated/RequestId";
import type { SongProgress } from "../generated/SongProgress";
import { anchorProgress, progressAt } from "./songProgress";

const request = 4 as unknown as RequestId;

function report(overrides: Partial<SongProgress> = {}): SongProgress {
  return {
    requestId: request,
    positionSeconds: 30,
    rate: 1,
    lengthSeconds: 180,
    ageMs: 0,
    ...overrides,
  };
}

describe("progress from the latest report", () => {
  it("advances at the reported rate while playing", () => {
    const anchor = anchorProgress(report(), 10_000);
    expect(progressAt(anchor, 10_000).positionSeconds).toBe(30);
    expect(progressAt(anchor, 22_500).positionSeconds).toBe(42.5);
    expect(progressAt(anchor, 22_500).fraction).toBeCloseTo(42.5 / 180, 9);
  });

  it("holds while paused", () => {
    const anchor = anchorProgress(report({ rate: 0 }), 10_000);
    expect(progressAt(anchor, 10_000).positionSeconds).toBe(30);
    expect(progressAt(anchor, 99_000).positionSeconds).toBe(30);
  });

  it("stops at the Song's end", () => {
    const anchor = anchorProgress(report({ positionSeconds: 170 }), 0);
    expect(progressAt(anchor, 9_000).positionSeconds).toBe(179);
    expect(progressAt(anchor, 60_000).positionSeconds).toBe(180);
    expect(progressAt(anchor, 60_000).fraction).toBe(1);
  });

  it("counts a report's age: one heard mid-Song is as far on as one heard when it was sent", () => {
    const fresh = anchorProgress(report(), 1_000);
    const late = anchorProgress(report({ ageMs: 4_000 }), 5_000);
    expect(progressAt(late, 5_000)).toEqual(progressAt(fresh, 5_000));
    expect(progressAt(late, 5_000).positionSeconds).toBe(34);
  });

  it("never goes back before the report, nor below 0", () => {
    const anchor = anchorProgress(report({ positionSeconds: 0.5 }), 10_000);
    expect(progressAt(anchor, 9_000).positionSeconds).toBe(0.5);
  });

  it("gives no fraction when the Song's length is unknown, and runs on", () => {
    const anchor = anchorProgress(report({ lengthSeconds: null }), 0);
    expect(progressAt(anchor, 1_000_000)).toEqual({
      positionSeconds: 1030,
      lengthSeconds: null,
      fraction: null,
    });
  });
});
