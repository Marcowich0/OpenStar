// The legend's samples (#258) come from the sing screen's own frame builder
// and pitch line, so each one looks exactly like the Note or line it explains.

import { describe, expect, it } from "vitest";

import type { DrawList, PillEntry, PitchLineEntry } from "./frame";
import {
  LEGEND_SAMPLE,
  legendNoteSamples,
  legendPitchSamples,
} from "./screenLegend";

const pills = (list: DrawList) =>
  list.filter((entry): entry is PillEntry => entry.type === "pill");
const lines = (list: DrawList) =>
  list.filter((entry): entry is PitchLineEntry => entry.type === "pitchLine");

function onePill(list: DrawList): PillEntry {
  const found = pills(list);
  expect(found).toHaveLength(1);
  const pill = found[0];
  if (!pill) throw new Error("no pill");
  return pill;
}

function inside(pill: PillEntry) {
  expect(pill.x).toBeGreaterThanOrEqual(0);
  expect(pill.y).toBeGreaterThanOrEqual(0);
  expect(pill.x + pill.width).toBeLessThanOrEqual(LEGEND_SAMPLE.width);
  expect(pill.y + pill.height).toBeLessThanOrEqual(LEGEND_SAMPLE.height);
}

describe("the legend's Note samples", () => {
  const samples = legendNoteSamples();

  it("are the five Note looks, in order", () => {
    expect(samples.map((s) => s.kind)).toEqual([
      "normal",
      "golden",
      "rap",
      "freestyle",
      "passed",
    ]);
  });

  it("draw nothing but their one pill, inside the sample", () => {
    for (const sample of samples) {
      expect(sample.list.every((entry) => entry.type === "pill")).toBe(true);
      inside(onePill(sample.list));
    }
  });

  it("look as the sing screen draws each kind", () => {
    const byKind = new Map(samples.map((s) => [s.kind, onePill(s.list)]));
    const normal = byKind.get("normal");
    expect(normal?.fill).toEqual({ type: "solid", colour: "--color-white" });
    expect(normal?.dash).toEqual([]);
    expect(normal?.star).toBeNull();

    const golden = byKind.get("golden");
    expect(golden?.fill).toEqual({
      type: "vertical",
      top: "--color-golden-top",
      bottom: "--color-golden-bottom",
    });
    expect(golden?.star).not.toBeNull();
    expect(golden?.shimmer).not.toBeNull();

    const rap = byKind.get("rap");
    expect(rap?.fill).toEqual({ type: "solid", colour: "--color-white" });
    expect(rap?.dash.length).toBeGreaterThan(0);

    expect(byKind.get("freestyle")?.fill).toBeNull();

    const passed = byKind.get("passed");
    expect(passed?.passed).toBe(true);
    expect(passed?.fill).toEqual({ type: "solid", colour: "--color-passed" });
  });
});

describe("the legend's pitch line samples", () => {
  const samples = legendPitchSamples();

  it("are a hit and a miss over a Normal Note", () => {
    expect(samples.map((s) => s.kind)).toEqual(["hit", "miss"]);
    for (const sample of samples) {
      const pill = onePill(sample.list);
      expect(pill.kind).toBe("normal");
      inside(pill);
      // The line is drawn over the Note.
      const last = sample.list.at(-1);
      expect(last?.type).toBe("pitchLine");
    }
  });

  it("draw the hit in the Party colour and the miss thin in ink", () => {
    const [hit, miss] = samples.map((s) => {
      const found = lines(s.list);
      expect(found).toHaveLength(1);
      return found[0];
    });
    expect(hit?.points.length).toBeGreaterThan(1);
    expect(hit?.points.every((p) => p.hit)).toBe(true);
    expect(hit?.hit.colour).toBe(LEGEND_SAMPLE.colour);
    expect(miss?.points.length).toBeGreaterThan(1);
    expect(miss?.points.every((p) => !p.hit)).toBe(true);
    expect(miss?.miss.colour).toBe("--color-ink");
    expect(miss?.miss.width).toBeLessThan(hit?.hit.width ?? 0);
  });

  it("keep the line inside the sample", () => {
    for (const sample of samples) {
      for (const p of lines(sample.list)[0]?.points ?? []) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(LEGEND_SAMPLE.width);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(LEGEND_SAMPLE.height);
      }
    }
  });
});
