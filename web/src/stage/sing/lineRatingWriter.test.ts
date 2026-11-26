import { describe, expect, it } from "vitest";

import type { DrawList } from "./frame";
import type { LineRatingEntry } from "./lineRating";
import { createLineRatingWriter } from "./lineRatingWriter";

function entry(overrides: Partial<LineRatingEntry> = {}): LineRatingEntry {
  return {
    type: "lineRating",
    lane: 0,
    word: "sing.lineRating.perfect",
    x: 320,
    y: 900,
    size: 40,
    colour: "cherry",
    scale: 1.2,
    alpha: 0.75,
    rise: 6,
    ...overrides,
  };
}

function elements(writer: ReturnType<typeof createLineRatingWriter>) {
  const a = document.createElement("span");
  const b = document.createElement("span");
  a.hidden = b.hidden = true;
  writer.word(0)(a);
  writer.word(1)(b);
  return [a, b] as const;
}

describe("the Line rating writer", () => {
  it("shows the word through t(), placed, scaled and faded as the entry says", () => {
    const writer = createLineRatingWriter();
    const [a, b] = elements(writer);
    writer.apply([entry()] satisfies DrawList);
    expect(a.hidden).toBe(false);
    expect(a.textContent).toBe("Perfect!");
    expect(a.style.left).toBe("320px");
    expect(a.style.top).toBe("894px");
    expect(a.style.fontSize).toBe("40px");
    expect(a.style.transform).toContain("scale(1.2)");
    expect(a.style.opacity).toBe("0.75");
    expect(a.style.color).toBe("var(--color-party-cherry)");
    expect(b.hidden).toBe(true);
  });

  it("hides the word once its lane has no entry", () => {
    const writer = createLineRatingWriter();
    const [a] = elements(writer);
    writer.apply([entry({ word: "sing.lineRating.ok" })]);
    expect(a.textContent).toBe("OK");
    writer.apply([]);
    expect(a.hidden).toBe(true);
  });

  it("changes the text only when the word does", () => {
    const writer = createLineRatingWriter();
    const [a] = elements(writer);
    writer.apply([entry()]);
    const text = a.firstChild;
    writer.apply([entry({ scale: 1 })]);
    expect(a.firstChild).toBe(text);
    writer.apply([entry({ word: "sing.lineRating.good" })]);
    expect(a.textContent).toBe("Good");
  });
});
