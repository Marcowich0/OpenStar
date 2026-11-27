import { describe, expect, it } from "vitest";

import { nextFocus, type FocusCandidate } from "./focusMove";

// A fixed layout in reference-frame pixels (x, y, width, height):
//
//   a [0,0]     b [300,0]    c [600,0]
//   d [0,300]                e [600,250]
//               f [300,600]
const rect = (x: number, y: number, width = 100, height = 100) => ({
  x,
  y,
  width,
  height,
});

const LAYOUT: FocusCandidate<string>[] = [
  { id: "a", rect: rect(0, 0) },
  { id: "b", rect: rect(300, 0) },
  { id: "c", rect: rect(600, 0) },
  { id: "d", rect: rect(0, 300) },
  { id: "e", rect: rect(600, 250) },
  { id: "f", rect: rect(300, 600) },
];

const from = (id: string) => {
  const found = LAYOUT.find((candidate) => candidate.id === id);
  if (!found) throw new Error(id);
  return found.rect;
};

describe("nextFocus", () => {
  it("moves to the nearest element along the arrow", () => {
    expect(nextFocus(from("a"), LAYOUT, "right")).toBe("b");
    expect(nextFocus(from("b"), LAYOUT, "right")).toBe("c");
    expect(nextFocus(from("c"), LAYOUT, "left")).toBe("b");
    expect(nextFocus(from("a"), LAYOUT, "down")).toBe("d");
    expect(nextFocus(from("d"), LAYOUT, "up")).toBe("a");
  });

  it("weighs the sideways distance 2.2 times the distance along the arrow", () => {
    // From d (centre 50,350) to the right: e is 600 along and 50 sideways
    // (600 + 110 = 710); b and f are 300 along and 300 sideways (300 + 660).
    expect(nextFocus(from("d"), LAYOUT, "right")).toBe("e");
    // From b (centre 350,50) down: d is 300 down and 300 sideways (960),
    // e 250 down and 300 sideways (910), f 600 down and straight (600).
    expect(nextFocus(from("b"), LAYOUT, "down")).toBe("f");
    // From f (centre 350,650) up: b is 600 straight up (600), e is 350 up
    // and 300 sideways (1010), d 300 up and 300 sideways (960).
    expect(nextFocus(from("f"), LAYOUT, "up")).toBe("b");
  });

  it("stays put when nothing lies in the arrow's direction", () => {
    expect(nextFocus(from("a"), LAYOUT, "left")).toBeNull();
    expect(nextFocus(from("a"), LAYOUT, "up")).toBeNull();
    expect(nextFocus(from("f"), LAYOUT, "down")).toBeNull();
  });

  it("ignores elements level with the current one on the arrow's axis", () => {
    // b and a share a row: neither is "down" of the other.
    const row = [
      { id: "a", rect: rect(0, 0) },
      { id: "b", rect: rect(300, 2) },
    ];
    expect(nextFocus(rect(0, 0), row, "down")).toBeNull();
  });
});
