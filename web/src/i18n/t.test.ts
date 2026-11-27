import { describe, expect, it } from "vitest";

import { createPartsTranslator, createTranslator, t, tParts } from "./t";

describe("t", () => {
  it("returns an entry without parameters as it stands", () => {
    expect(t("join.enterCode")).toBe("Enter the Join code");
  });

  it("puts each parameter in by name", () => {
    expect(t("join.code", { code: "0427" })).toBe("Join code 0427");
    expect(t("server.version", { version: "1.2.0", schemaVersion: 3 })).toBe(
      "Server 1.2.0, schema 3",
    );
  });

  it("formats a number parameter for the catalogue's language", () => {
    const tr = createTranslator({ length: "{n, number} letters" }, "en");
    expect(tr("length", { n: 12000 })).toBe("12,000 letters");
    const de = createTranslator({ length: "{n, number} Buchstaben" }, "de");
    expect(de("length", { n: 12000 })).toBe("12.000 Buchstaben");
  });

  it("fills in a name used twice", () => {
    const tr = createTranslator({ echo: "{name}, {name}!" }, "en");
    expect(tr("echo", { name: "Mia" })).toBe("Mia, Mia!");
  });
});

describe("plurals", () => {
  const songs = createTranslator(
    {
      songCount: {
        one: "{count, number} Song in the Queue",
        other: "{count, number} Songs in the Queue",
      },
    },
    "en",
  );

  it("picks the form Intl.PluralRules names for 0, 1 and 2", () => {
    expect(songs("songCount", { count: 0 })).toBe("0 Songs in the Queue");
    expect(songs("songCount", { count: 1 })).toBe("1 Song in the Queue");
    expect(songs("songCount", { count: 2 })).toBe("2 Songs in the Queue");
  });

  it("uses the plural rules of the catalogue's language", () => {
    // Welsh has its own forms for zero and two; a catalogue may give every
    // form its language needs.
    const cy = createTranslator(
      {
        songCount: {
          zero: "zero {count, number}",
          one: "one {count, number}",
          two: "two {count, number}",
          other: "other {count, number}",
        },
      },
      "cy",
    );
    expect(cy("songCount", { count: 0 })).toBe("zero 0");
    expect(cy("songCount", { count: 1 })).toBe("one 1");
    expect(cy("songCount", { count: 2 })).toBe("two 2");
    expect(cy("songCount", { count: 7 })).toBe("other 7");
  });

  it("falls back to `other` when the language's form is missing", () => {
    const tr = createTranslator(
      { songCount: { other: "{count, number} Songs" } },
      "en",
    );
    expect(tr("songCount", { count: 1 })).toBe("1 Songs");
  });
});

describe("tParts", () => {
  it("splits a text into plain runs and the parameters put in", () => {
    expect(tParts("join.code", { code: "0427" })).toEqual([
      { text: "Join code " },
      { text: "0427", param: "code" },
    ]);
  });

  it("joins back to what t gives, numbers formatted for the language", () => {
    const de = createPartsTranslator(
      { moved: "{who} schob {n, number} Songs nach {where}" },
      "de",
    );
    expect(de("moved", { who: "Bo", n: 1200, where: "oben" })).toEqual([
      { text: "Bo", param: "who" },
      { text: " schob " },
      { text: "1.200", param: "n" },
      { text: " Songs nach " },
      { text: "oben", param: "where" },
    ]);
  });
});
