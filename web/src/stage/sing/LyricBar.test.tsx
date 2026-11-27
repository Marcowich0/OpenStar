// The lyric bar's look (#215): the frosted bar, the current and next Line,
// golden and italic text, the lift while a Note is sung and the pop-in. The
// fill itself (fraction and colour) is #133's and tested in SingScreen.test.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Line } from "../../generated/Line";
import type { Note } from "../../generated/Note";
import type { NoteKind } from "../../generated/NoteKind";
import type { LyricEntry, SingVoice } from "./frame";
import { createLyricDriver, LyricBar } from "./LyricBar";
import { DEFAULT_SING_LOOK, type SingLook } from "./singLook";

function note(text: string, kind: NoteKind = "normal"): Note {
  return { kind, start: 0, length: 1, pitch: 0, text, line: 1 };
}

function voice(...lines: Note[][]): SingVoice {
  const parsed: Line[] = lines.map((notes) => ({ notes, end: null }));
  return { lines: parsed } as unknown as SingVoice;
}

const SONG = voice(
  [note("Hel"), note("lo ", "golden"), note("you ", "rap")],
  [note("next "), note("one", "freestyle")],
  [note("last", "goldenRap")],
);

function entry(voiceIndex: number, line: number, note = -1): LyricEntry {
  return {
    type: "lyric",
    voice: voiceIndex,
    line,
    note,
    fraction: 0,
    singing: false,
    colour: "cherry",
  };
}

function mount(
  voices: SingVoice[],
  entries: LyricEntry[],
  look?: Partial<SingLook>,
) {
  const driver = createLyricDriver();
  const utils = render(
    <LyricBar
      voices={voices}
      driver={driver}
      {...(look ? { look: { ...DEFAULT_SING_LOOK, ...look } } : {})}
    />,
  );
  act(() => {
    driver.apply(entries);
  });
  const bar = utils.container.querySelector<HTMLElement>("[data-lyric-bar]");
  const current = () => [
    ...utils.container.querySelectorAll<HTMLElement>("[data-lyric-line]"),
  ];
  const next = () =>
    utils.container.querySelector<HTMLElement>("[data-lyric-next]");
  return { ...utils, driver, bar, current, next };
}

describe("the lyric bar's look", () => {
  it("is a frosted surface bar (white in Bubble Pop) centred 34 px above the bottom", () => {
    const { bar } = mount([SONG], [entry(0, 0)]);
    expect(bar?.style.bottom).toBe("34px");
    expect(bar?.style.left).toBe("50%");
    expect(bar?.style.background).toBe(
      "color-mix(in srgb, var(--color-surface) 86%, transparent)",
    );
    expect(bar?.style.getPropertyValue("backdrop-filter")).toBe("blur(14px)");
    expect(bar?.style.borderRadius).toBe("52px");
    expect(bar?.style.padding).toBe("10px 60px 16px");
    expect(bar?.style.boxShadow).toBe("var(--shadow-ledge-lyric)");
  });

  it("is hidden while no Voice has a Line to show", () => {
    const { bar } = mount([voice()], [entry(0, -1)]);
    expect(bar?.hidden).toBe(true);
  });

  it("shows the current Line at 78 px bold and the next one at 36 px in mute", () => {
    const { current, next } = mount([SONG], [entry(0, 0)]);
    const [line] = current();
    expect(line?.textContent).toBe("Hello you ");
    expect(line?.style.fontSize).toBe("78px");
    expect(line?.style.fontWeight).toBe("700");
    expect(next()?.textContent).toBe("next one");
    expect(next()?.style.fontSize).toBe("36px");
    expect(next()?.style.fontWeight).toBe("600");
    expect(next()?.style.color).toBe("var(--color-mute)");
  });

  it("sizes its text by Lyric size: s, l, and xl at 1.5 × m", () => {
    for (const [lyricSize, line, next] of [
      ["s", "62.4px", "28.8px"],
      ["l", "97.5px", "45px"],
      ["xl", "117px", "54px"],
    ] as const) {
      const {
        current,
        next: nextLine,
        unmount,
      } = mount([SONG], [entry(0, 0)], { lyricSize });
      expect(current()[0]?.style.fontSize, lyricSize).toBe(line);
      expect(nextLine()?.style.fontSize, lyricSize).toBe(next);
      unmount();
    }
  });

  it("sizes a duet's Lines by Lyric size too", () => {
    const other = voice([note("Oth"), note("er")]);
    const { current } = mount([SONG, other], [entry(0, 0), entry(1, 0)], {
      lyricSize: "xl",
    });
    expect(current().map((l) => l.style.fontSize)).toEqual(["90px", "90px"]);
  });

  it("shows no next Line when Show next Line is off", () => {
    const { current, next } = mount([SONG], [entry(0, 0)], {
      showNextLine: false,
    });
    expect(current()[0]?.textContent).toBe("Hello you ");
    expect(next()).toBeNull();
  });

  it("shows no next Line after the last one", () => {
    const { current, next } = mount([SONG], [entry(0, 2)]);
    expect(current()[0]?.textContent).toBe("last");
    expect(next()).toBeNull();
  });

  it("shows both Voices' current Lines at 60 px in a duet, with no next Line", () => {
    const other = voice([note("Oth"), note("er")], [note("more")]);
    const { current, next } = mount([SONG, other], [entry(0, 0), entry(1, 0)]);
    expect(current().map((l) => l.textContent)).toEqual([
      "Hello you ",
      "Other",
    ]);
    expect(current().map((l) => l.style.fontSize)).toEqual(["60px", "60px"]);
    expect(next()).toBeNull();
  });

  it("keeps the Note spans as the current Line's only children, in order", () => {
    const { current } = mount([SONG], [entry(0, 0)]);
    const children = [...(current()[0]?.children ?? [])];
    expect(children.map((c) => c.textContent)).toEqual(["Hel", "lo ", "you "]);
    expect(children.every((c) => c.hasAttribute("data-lyric-note"))).toBe(true);
  });

  it("writes unsung text in ink, and a golden Note's in golden text", () => {
    const { current } = mount([SONG], [entry(0, 0)]);
    const unsung = [...(current()[0]?.children ?? [])].map((c) =>
      (c as HTMLElement).style.getPropertyValue("--lyric-unsung"),
    );
    expect(unsung).toEqual([
      "var(--color-ink)",
      "var(--color-golden-text)",
      "var(--color-ink)",
    ]);
    const last = mount([SONG], [entry(0, 2)]);
    expect(
      (last.current()[0]?.children[0] as HTMLElement).style.getPropertyValue(
        "--lyric-unsung",
      ),
    ).toBe("var(--color-golden-text)");
  });

  it("sets Rap and Freestyle Notes' text in italics", () => {
    const { current, next } = mount([SONG], [entry(0, 0)]);
    const styles = [...(current()[0]?.children ?? [])].map(
      (c) => (c as HTMLElement).style.fontStyle,
    );
    expect(styles).toEqual(["", "", "italic"]);
    const nextStyles = [...(next()?.children ?? [])].map(
      (c) => (c as HTMLElement).style.fontStyle,
    );
    expect(nextStyles).toEqual(["", "italic"]);
  });

  it("lifts the Note being sung by 6 px", () => {
    const { current } = mount([SONG], [{ ...entry(0, 0, 1), singing: true }]);
    const sung = current()[0]?.children[1] as HTMLElement;
    expect(sung.dataset.singing).toBe("true");
    // The lift is CSS on `[data-singing]`; the screenshots show it.
    expect(sung.className).toContain("data-singing:-translate-y-[6px]");
    expect(sung.className).toContain("inline-block");
  });

  it("pops a new Line in", () => {
    const { current, next, driver } = mount([SONG], [entry(0, 0)]);
    const first = current()[0];
    expect(first?.className).toContain("animate-line-in");
    expect(next()?.className).toContain("animate-line-in");
    act(() => {
      driver.apply([entry(0, 1)]);
    });
    // A new element, so the animation runs again.
    expect(current()[0]).not.toBe(first);
    expect(current()[0]?.className).toContain("animate-line-in");
  });
});
