import { describe, expect, it } from "vitest";

import { colourName } from "./colourNames";
import { PALETTE_KEYS } from "./paletteKeys";

describe("colourName", () => {
  it("gives each Party colour its fixed display name", () => {
    expect(colourName("cherry")).toBe("Cherry");
    expect(colourName("bubblegum")).toBe("Bubblegum");
    expect(colourName("tangerine")).toBe("Tangerine");
  });

  it("names all twelve colours, each differently", () => {
    const names = PALETTE_KEYS.map(colourName);
    expect(names).toEqual([
      "Cherry",
      "Sky",
      "Navy",
      "Cocoa",
      "Teal",
      "Lime",
      "Berry",
      "Mint",
      "Bubblegum",
      "Forest",
      "Grape",
      "Tangerine",
    ]);
  });
});
