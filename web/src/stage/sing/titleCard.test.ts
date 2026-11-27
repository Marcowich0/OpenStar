import { describe, expect, it } from "vitest";

import type { Note } from "../../generated/Note";
import { isPaletteKey, TOKEN_NAMES } from "../../theme/tokens";
import { frame, singVoices, type DrawEntry, type SingState } from "./frame";
import { laneLayout } from "./laneLayout";
import type {
  PauseHintEntry,
  TimeLeftEntry,
  TitleCardEntry,
} from "./titleCard";

// One Beat lasts 0.5 s; Beat 0 falls at 1 s. The last Note ends at Beat 62:
// Song time 32 s.
const grid = { gapSeconds: 1, beatsPerMinute: 120 };
const notes: Note[] = [
  { kind: "normal", start: 4, length: 2, pitch: 0, text: "la ", line: 1 },
  { kind: "normal", start: 60, length: 2, pitch: 4, text: "la ", line: 2 },
];

const song = {
  title: "Made-up Song",
  artist: "Nobody Real",
  cover: "/api/songs/1/cover",
  tileColour: "navy",
} as const;

const base: SingState = {
  grid,
  voices: singVoices({ voices: [{ lines: [{ notes, end: null }] }] }),
  lanes: [{ colour: "cherry", voice: 0 }],
  lengthSeconds: 161,
  song,
};
const layout = laneLayout(1);

function card(list: readonly DrawEntry[]): TitleCardEntry | undefined {
  return list.find((e): e is TitleCardEntry => e.type === "titleCard");
}
function hint(list: readonly DrawEntry[]): PauseHintEntry | undefined {
  return list.find((e): e is PauseHintEntry => e.type === "pauseHint");
}
function timeLeft(list: readonly DrawEntry[]): TimeLeftEntry | undefined {
  return list.find((e): e is TimeLeftEntry => e.type === "timeLeft");
}

describe("the title card", () => {
  it("shows the cover, title and artist in the top-left from 0 to 4 s", () => {
    for (const t of [-0.2, 0, 1, 3.99, 4]) {
      const entry = card(frame(base, t, layout));
      expect(entry, `at ${String(t)} s`).toMatchObject({
        x: 80,
        y: 52,
        height: 104,
        cover: { url: "/api/songs/1/cover", tile: "navy" },
        title: { text: "Made-up Song" },
        artist: { text: "Nobody Real" },
      });
    }
  });

  it("then slides out to the left, and is gone after", () => {
    const sliding = card(frame(base, 4.2, layout));
    expect(sliding?.x).toBeLessThan(80);
    expect(sliding?.x).toBeGreaterThan(-(sliding?.maxWidth ?? 0));
    // Each part slides with the pill.
    expect(sliding?.cover.x).toBe((sliding?.x ?? 0) + 12);
    for (const t of [4.4, 5, 30, 160]) {
      expect(card(frame(base, t, layout)), `at ${String(t)} s`).toBeUndefined();
    }
  });

  it("is moved only by Song time: a Restart shows it again", () => {
    expect(card(frame(base, 90, layout))).toBeUndefined();
    expect(card(frame(base, 0.5, layout))).toBeDefined();
  });

  it("is left out without the Song's title", () => {
    expect(card(frame({ ...base, song: null }, 1, layout))).toBeUndefined();
  });

  it("falls back to the tile colour without a cover", () => {
    const entry = card(
      frame({ ...base, song: { ...song, cover: null } }, 1, layout),
    );
    expect(entry?.cover).toMatchObject({ url: null, tile: "navy" });
  });

  it("cuts a very long title or artist short with an ellipsis", () => {
    const long = "A".repeat(80);
    const entry = card(
      frame(
        { ...base, song: { ...song, title: long, artist: long } },
        1,
        layout,
      ),
    );
    expect(entry?.title.text).toBe(`${"A".repeat(39)}…`);
    expect(entry?.artist.text).toBe(`${"A".repeat(39)}…`);
  });
});

describe("the pause hint", () => {
  it('shows "Space: pause" under the title card for the same 4 s', () => {
    const state: SingState = { ...base, pauseHint: "keyboard" };
    const list = frame(state, 1, layout);
    const entry = hint(list);
    const pill = card(list);
    expect(entry?.text.text).toBe("Space: pause");
    expect(entry?.x).toBe(80);
    expect(entry?.y).toBeGreaterThan((pill?.y ?? 0) + (pill?.height ?? 0));
    // It slides out with the card.
    expect(hint(frame(state, 4.2, layout))?.x).toBe(
      card(frame(state, 4.2, layout))?.x,
    );
    expect(hint(frame(state, 4.4, layout))).toBeUndefined();
  });

  it("names the pad's Start button after gamepad input", () => {
    const entry = hint(frame({ ...base, pauseHint: "gamepad" }, 1, layout));
    expect(entry?.text.text).toBe("Start: pause");
  });

  it("is left out when the Song is not the Party's first (no pause hint in the state)", () => {
    expect(hint(frame(base, 1, layout))).toBeUndefined();
    expect(
      hint(frame({ ...base, pauseHint: null }, 1, layout)),
    ).toBeUndefined();
  });
});

describe("the time left", () => {
  it("sits at the right end of the progress bar, which makes room for it", () => {
    const list = frame(base, 10, layout);
    const progress = list.find((e) => e.type === "progress");
    const label = timeLeft(list);
    expect(label?.text.x).toBe(1840);
    expect(label?.text.y).toBe(25);
    expect(progress && progress.x + progress.width).toBeLessThan(1840 - 80);
  });

  it("is m:ss, counting down from the Song's end for the whole Song", () => {
    const at = (t: number, s: SingState = base) =>
      timeLeft(frame(s, t, layout))?.text.text;
    expect(at(0)).toBe("2:41");
    expect(at(-1)).toBe("2:41");
    expect(at(0.4)).toBe("2:41");
    expect(at(1)).toBe("2:40");
    expect(at(100.5)).toBe("1:01");
    expect(at(155)).toBe("0:06");
    expect(at(161)).toBe("0:00");
    expect(at(170)).toBe("0:00");
    // Without the Song's length, the last Note's end (32 s).
    expect(at(0, { ...base, lengthSeconds: null })).toBe("0:32");
  });

  it("is left out when the Song has no length at all", () => {
    const empty: SingState = {
      grid: { ...grid, gapSeconds: 0 },
      voices: [],
      lanes: [],
      lengthSeconds: null,
    };
    expect(timeLeft(frame(empty, 0, layout))).toBeUndefined();
  });
});

describe("the top band", () => {
  it("holds every new entry above the highest lane of any layout", () => {
    const state: SingState = { ...base, pauseHint: "keyboard" };
    const top = Math.min(...laneLayout(8).map((lane) => lane.y));
    const list = frame(state, 1, layout);
    const pill = card(list);
    const tip = hint(list);
    const label = timeLeft(list);
    expect(pill && pill.y + pill.height + pill.ledgeDepth).toBeLessThan(
      tip?.y ?? 0,
    );
    expect(tip && tip.y + tip.height).toBeLessThan(top);
    expect((label?.text.y ?? 0) + (label?.text.size ?? 0)).toBeLessThan(top);
  });

  it("names colours only by palette key or token", () => {
    const list = frame({ ...base, pauseHint: "keyboard" }, 1, layout);
    const colours: unknown[] = [];
    const pill = card(list);
    const tip = hint(list);
    const label = timeLeft(list);
    if (pill) {
      colours.push(
        pill.fill,
        pill.ledge,
        pill.cover.tile,
        pill.cover.rim,
        pill.title.colour,
        pill.artist.colour,
      );
    }
    if (tip) colours.push(tip.fill, tip.text.colour);
    if (label) colours.push(label.text.colour, label.outline);
    expect(colours).toHaveLength(10);
    const known = new Set<unknown>(TOKEN_NAMES);
    for (const colour of colours) {
      expect(isPaletteKey(colour) || known.has(colour), String(colour)).toBe(
        true,
      );
    }
  });
});
