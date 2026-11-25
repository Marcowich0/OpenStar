import { describe, expect, it } from "vitest";

import { formatWait } from "./formatWait";

describe("formatWait", () => {
  it("writes the wait as m:ss", () => {
    expect(formatWait(42)).toBe("0:42");
    expect(formatWait(60)).toBe("1:00");
    expect(formatWait(62)).toBe("1:02");
    expect(formatWait(15 * 60)).toBe("15:00");
  });

  it("rounds a part second up and never goes below zero", () => {
    expect(formatWait(41.2)).toBe("0:42");
    expect(formatWait(0)).toBe("0:00");
    expect(formatWait(-3)).toBe("0:00");
  });
});
