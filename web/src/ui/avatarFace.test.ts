import { describe, expect, it } from "vitest";

import { avatarFace, initialOf } from "./avatarFace";

describe("avatarFace", () => {
  it.each([12, 24, 31, 31.9])(
    "shows the initial on a disc drawn %s px wide (under 32 px)",
    (size) => {
      expect(avatarFace(size)).toBe("initial");
    },
  );

  it.each([32, 46, 70, 150])(
    "shows the icon on a disc drawn %s px wide (32 px and above)",
    (size) => {
      expect(avatarFace(size)).toBe("icon");
    },
  );
});

describe("initialOf", () => {
  it.each([
    ["mia", "M"],
    ["  bo ", "B"],
    ["Ørjan", "Ø"],
    ["élodie", "É"],
    ["", ""],
  ])("takes the first letter of %j, upper-cased", (name, initial) => {
    expect(initialOf(name)).toBe(initial);
  });

  it("keeps a whole grapheme together", () => {
    expect(initialOf("👩🏽‍🎤 Ana")).toBe("👩🏽‍🎤");
  });
});
