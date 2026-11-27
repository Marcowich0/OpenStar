// The lyric bar's text and its fill. React lays out each Voice's current
// Line as DOM text and re-renders it only when that Line changes; the render
// loop hands every frame's draw list to `LyricDriver.apply`, which writes the
// current Note's fill fraction to the `--lyric-fill` CSS custom property on
// its text, bypassing React. The bar's look is #215's: a frosted bar with
// the current Line large and the next one small below it (both Voices'
// current Lines in a duet), golden and italic Notes, the 6 px lift of the
// Note being sung and the pop-in of a new Line.

import { memo, useSyncExternalStore, type CSSProperties } from "react";

import { tokenVar } from "../../theme/tokens";
import type { Note } from "../../generated/Note";
import type { NoteKind } from "../../generated/NoteKind";
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

/** The bar (#55), in the 1920 × 1080 reference frame. */
const BAR_STYLE: CSSProperties = {
  position: "absolute",
  left: "50%",
  bottom: "34px",
  translate: "-50% 0",
  background: "color-mix(in srgb, var(--color-white) 86%, transparent)",
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
  borderRadius: "52px",
  padding: "10px 60px 16px",
  boxShadow: "var(--shadow-ledge-lyric)",
  lineHeight: 1.1,
  textAlign: "center",
};

const CURRENT_STYLE: CSSProperties = { fontSize: "78px", fontWeight: 700 };
const DUET_STYLE: CSSProperties = { fontSize: "60px", fontWeight: 700 };
/** The next Line's text; the pause menu legend (#258) shows it too. */
export const NEXT_LINE_STYLE: CSSProperties = {
  fontSize: "36px",
  fontWeight: 600,
  color: "var(--color-mute)",
};

const GOLDEN: ReadonlySet<NoteKind> = new Set(["golden", "goldenRap"]);
const ITALIC: ReadonlySet<NoteKind> = new Set([
  "rap",
  "goldenRap",
  "freestyle",
]);

/**
 * The fill: the Voice's fill colour up to `--lyric-fill` of the text's width,
 * the unsung colour after it, clipped to the glyphs. The inline padding,
 * taken back by the margin, lets the background reach an italic or bold
 * glyph's overhang, which `background-clip: text` would otherwise cut off.
 */
const SYLLABLE_STYLE = {
  backgroundImage:
    "linear-gradient(90deg, var(--lyric-fill-colour) calc(var(--lyric-fill, 0) * 100%), var(--lyric-unsung) 0)",
  backgroundClip: "text",
  WebkitBackgroundClip: "text",
  color: "transparent",
  paddingInline: "0.1em",
  marginInline: "-0.1em",
} as const;

/** One style per Note look, so a Line change allocates no styles. */
const NOTE_STYLES = new Map<string, CSSProperties>();
/**
 * A Note's text in the current Line, filled to `--lyric-fill` in
 * `--lyric-fill-colour` (set on an ancestor); the pause menu legend (#258)
 * draws its lyric samples with it.
 */
export function lyricNoteStyle(kind: NoteKind): CSSProperties {
  const golden = GOLDEN.has(kind);
  const italic = ITALIC.has(kind);
  const key = `${String(golden)}:${String(italic)}`;
  let style = NOTE_STYLES.get(key);
  if (!style) {
    style = {
      ...SYLLABLE_STYLE,
      "--lyric-unsung": golden
        ? "var(--color-golden-text)"
        : "var(--color-ink)",
      fontStyle: italic ? "italic" : undefined,
    } as CSSProperties;
    NOTE_STYLES.set(key, style);
  }
  return style;
}

const ITALIC_STYLE: CSSProperties = { fontStyle: "italic" };

/** A Note's text lifts while it is sung (`data-singing`). */
export const LYRIC_NOTE_CLASS =
  "inline-block transition-[translate] duration-200 data-singing:-translate-y-[6px]";

/** The next Line: plain text in mute, Rap and Freestyle Notes in italics. */
function NextLine({ notes }: { notes: readonly Note[] }) {
  return (
    <div data-lyric-next className="animate-line-in" style={NEXT_LINE_STYLE}>
      {notes.map((note, i) => (
        <span key={i} style={ITALIC.has(note.kind) ? ITALIC_STYLE : undefined}>
          {note.text}
        </span>
      ))}
    </div>
  );
}

export const LyricBar = memo(function LyricBar({
  voices,
  driver,
}: {
  voices: readonly SingVoice[];
  driver: LyricDriver;
}) {
  const lines = useSyncExternalStore(driver.subscribe, driver.lines);
  const duet = voices.length > 1;
  const shown = voices.some((voice, v) => voice.lines[lines[v] ?? -1]);
  const single = voices[0];
  const next = duet ? undefined : single?.lines[(lines[0] ?? -1) + 1];
  return (
    <div
      data-lyric-bar
      hidden={!shown}
      className="whitespace-pre text-ink"
      style={BAR_STYLE}
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
            className="animate-line-in"
            style={duet ? DUET_STYLE : CURRENT_STYLE}
          >
            {line?.notes.map((note, i) => (
              <span
                key={i}
                data-lyric-note
                className={LYRIC_NOTE_CLASS}
                style={lyricNoteStyle(note.kind)}
              >
                {note.text}
              </span>
            ))}
          </div>
        );
      })}
      {next && <NextLine key={(lines[0] ?? -1) + 1} notes={next.notes} />}
    </div>
  );
});
