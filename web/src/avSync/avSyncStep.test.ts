import { describe, expect, it } from "vitest";

import { avOffsetText, nextAvOffset } from "./avSyncStep";

describe("one Check A/V sync press", () => {
  it("moves the offset 10 ms down or up", () => {
    expect(nextAvOffset(0, "up")).toBe(10);
    expect(nextAvOffset(120, "down")).toBe(110);
    expect(nextAvOffset(0, "down")).toBe(-10);
  });

  it("stays within −300..+500 ms", () => {
    expect(nextAvOffset(500, "up")).toBe(500);
    expect(nextAvOffset(-300, "down")).toBe(-300);
    expect(nextAvOffset(490, "up")).toBe(500);
  });

  it("resets to 0", () => {
    expect(nextAvOffset(370, "reset")).toBe(0);
    expect(nextAvOffset(-120, "reset")).toBe(0);
  });
});

describe("the value as it shows, large", () => {
  it("carries its sign", () => {
    expect(avOffsetText(120)).toBe("+120 ms");
    expect(avOffsetText(-40)).toBe("−40 ms");
    expect(avOffsetText(0)).toBe("0 ms");
  });
});
