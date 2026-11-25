// The lyric bar's text and its fill. React lays out each Voice's current
// Line as DOM text and re-renders it only when that Line changes; the render
// loop hands every frame's draw list to `LyricDriver.apply`, which writes the
// current Note's fill fraction to the `--lyric-fill` CSS custom property on
// its text, bypassing React. The bar's look (sizes, the next Line, the lift
// and the pop-in) is #215's.

import { memo, useSyncExternalStore } from "react";

import { tokenVar } from "../../theme/tokens";
import type { DrawList, LyricColour, LyricEntry, SingVoice } from "./frame";

/** Between the render loop and the lyric text. */
export interface LyricDriver {
  /** Each Voice's current Line index; a new array only when one changes. */
  lines: () => readonly number[];
  subscribe: (listener: () => void) => () => void;
  /** The element holding Voice `voice`'s current Line, one child per Note. */
  attach: (voice: number, element: HTMLElement | null) => void;
  /** Writes a frame's lyric fill to the DOM. Called once per frame. */
  apply: (list: DrawList) => void;
}

const NONE = -2;

export function createLyricDriver(): LyricDriver {
  let lines: readonly number[] = [];
  const listeners = new Set<() => void>();
  const elements: (HTMLElement | null)[] = [];
  /** Each Voice's latest lyric entry, written when its Line's element mounts. */
  const latest: (LyricEntry | undefined)[] = [];
  // What was last written to each Voice's element, so a frame writes only
  // what changed: usually just the current Note's fraction.
  const writtenNote: number[] = [];
  const writtenFraction: number[] = [];
  const writtenSinging: number[] = [];
  const writtenColour: (LyricColour | null)[] = [];

  function setFill(el: HTMLElement, fraction: number) {
    el.style.setProperty("--lyric-fill", String(fraction));
  }

  function write(entry: LyricEntry) {
    const v = entry.voice;
    const line = elements[v];
    if (!line) return;
    if (writtenColour[v] !== entry.colour) {
      line.style.setProperty("--lyric-fill-colour", tokenVar(entry.colour));
      writtenColour[v] = entry.colour;
    }
    const notes = line.children;
    if (writtenNote[v] !== entry.note) {
      // A new current Note: the ones before it are sung, the rest not.
      for (let i = 0; i < notes.length; i++) {
        if (i !== entry.note) {
          setFill(notes[i] as HTMLElement, i < entry.note ? 1 : 0);
        }
      }
      writtenNote[v] = entry.note;
      writtenFraction[v] = NaN;
    }
    const current = notes[entry.note] as HTMLElement | undefined;
    if (current && writtenFraction[v] !== entry.fraction) {
      setFill(current, entry.fraction);
      writtenFraction[v] = entry.fraction;
    }
    const singing = entry.singing ? entry.note : NONE;
    if (writtenSinging[v] !== singing) {
      const was = notes[writtenSinging[v] ?? NONE] as HTMLElement | undefined;
      if (was) delete was.dataset.singing;
      if (current && entry.singing) current.dataset.singing = "true";
      writtenSinging[v] = singing;
    }
  }

  return {
    lines: () => lines,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attach(voice, element) {
      elements[voice] = element;
      writtenNote[voice] = NONE;
      writtenFraction[voice] = NaN;
      writtenSinging[voice] = NONE;
      writtenColour[voice] = null;
      const entry = latest[voice];
      if (entry && entry.line === lines[voice]) write(entry);
    },
    apply(list) {
      let changed: number[] | null = null;
      for (const entry of list) {
        if (entry.type !== "lyric") continue;
        latest[entry.voice] = entry;
        if (lines[entry.voice] === entry.line) {
          write(entry);
        } else {
          // React mounts the new Line's element, and `attach` writes it.
          changed ??= [...lines];
          changed[entry.voice] = entry.line;
        }
      }
      if (changed) {
        lines = changed;
        for (const listener of listeners) listener();
      }
    },
  };
}

/**
 * The fill: the Voice's fill colour up to `--lyric-fill` of the text's width,
 * ink after it, clipped to the glyphs.
 */
const SYLLABLE_STYLE = {
  backgroundImage:
    "linear-gradient(90deg, var(--lyric-fill-colour) calc(var(--lyric-fill, 0) * 100%), var(--color-ink) 0)",
  backgroundClip: "text",
  WebkitBackgroundClip: "text",
  color: "transparent",
} as const;

export const LyricBar = memo(function LyricBar({
  voices,
  driver,
}: {
  voices: readonly SingVoice[];
  driver: LyricDriver;
}) {
  const lines = useSyncExternalStore(driver.subscribe, driver.lines);
  const duet = voices.length > 1;
  return (
    <div
      data-lyric-bar
      className={`absolute right-0 bottom-[34px] left-0 flex flex-col items-center font-bold text-ink ${duet ? "text-[60px]" : "text-[78px]"}`}
    >
      {voices.map((voice, v) => {
        const index = lines[v] ?? -1;
        const line = voice.lines[index];
        return (
          <div
            key={`${String(v)}:${String(index)}`}
            ref={(el) => {
              driver.attach(v, el);
            }}
            data-lyric-line
            className="leading-tight whitespace-pre"
          >
            {line?.notes.map((note, i) => (
              <span key={i} data-lyric-note style={SYLLABLE_STYLE}>
                {note.text}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
});
