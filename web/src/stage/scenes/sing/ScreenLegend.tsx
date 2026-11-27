// The pause menu's "How to read the screen" card (#258): what each Note kind,
// the pitch line's hit and miss, and the lyric styles look like. The Note and
// pitch line samples are draw lists from the sing screen's own frame builder,
// painted by its own painter (`stage/sing/screenLegend.ts`); the lyric samples
// use the lyric bar's own styles. It is a Stage layer above the pause menu, so
// Esc (or Back) returns to the menu, and the Song stays paused.

import {
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";

import { t } from "../../../i18n/t";
import { readToken, tokenVar } from "../../../theme/tokens";
import { Button } from "../../../ui/Button";
import { ReferenceBox, useReferenceScale } from "../../frame/ReferenceBox";
import { StageLayer } from "../../frame/stageFrameContext";
import {
  LYRIC_NOTE_CLASS,
  lyricNoteStyle,
  NEXT_LINE_STYLE,
} from "../../sing/LyricBar";
import type { DrawList } from "../../sing/frame";
import { createPainter } from "../../sing/painter";
import {
  LEGEND_SAMPLE,
  legendNoteSamples,
  legendPitchSamples,
  type LegendNoteKind,
} from "../../sing/screenLegend";

const NOTE_TEXT = {
  normal: {
    name: "stage.legend.note.normal",
    hint: "stage.legend.note.normalHint",
  },
  golden: {
    name: "stage.legend.note.golden",
    hint: "stage.legend.note.goldenHint",
  },
  rap: { name: "stage.legend.note.rap", hint: "stage.legend.note.rapHint" },
  freestyle: {
    name: "stage.legend.note.freestyle",
    hint: "stage.legend.note.freestyleHint",
  },
  passed: {
    name: "stage.legend.note.passed",
    hint: "stage.legend.note.passedHint",
  },
} as const satisfies Record<LegendNoteKind, { name: string; hint: string }>;

const PITCH_TEXT = {
  hit: { name: "stage.legend.pitch.hit", hint: "stage.legend.pitch.hitHint" },
  miss: {
    name: "stage.legend.pitch.miss",
    hint: "stage.legend.pitch.missHint",
  },
} as const;

// Drawn once: the samples never move.
const NOTE_SAMPLES = legendNoteSamples();
const PITCH_SAMPLES = legendPitchSamples();

/** One sample, painted once (and again when the reference scale changes). */
function SampleCanvas({ list, label }: { list: DrawList; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scale = useReferenceScale();
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const pixels = scale * (window.devicePixelRatio || 1);
    canvas.width = Math.round(LEGEND_SAMPLE.width * pixels);
    canvas.height = Math.round(LEGEND_SAMPLE.height * pixels);
    createPainter(ctx, (ref) => readToken(ref)).paint(list, {
      scale: pixels,
      x: 0,
      y: 0,
    });
  }, [list, scale]);
  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={label}
      className="block rounded-2xl bg-ink/5"
      style={{ width: LEGEND_SAMPLE.width, height: LEGEND_SAMPLE.height }}
    />
  );
}

function Sample({
  list,
  name,
  hint,
}: {
  list: DrawList;
  name: string;
  hint: string;
}) {
  return (
    <figure className="flex flex-col items-center gap-3">
      <SampleCanvas list={list} label={name} />
      <figcaption className="text-center">
        <span className="block text-2xl font-semibold">{name}</span>
        <span className="block text-xl text-ink-2">{hint}</span>
      </figcaption>
    </figure>
  );
}

/** The lyric samples' fill colour: the one Player's Party colour. */
const LYRICS_STYLE = {
  "--lyric-fill-colour": tokenVar(LEGEND_SAMPLE.colour),
  fontSize: "56px",
  fontWeight: 700,
  lineHeight: 1.1,
} as CSSProperties;

function lyric(fill: number, style: CSSProperties): CSSProperties {
  return { ...style, "--lyric-fill": String(fill) } as CSSProperties;
}

function Section({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`flex flex-col gap-4 ${className}`}>
      <h3 className="text-3xl font-bold">{title}</h3>
      {children}
    </section>
  );
}

export function ScreenLegend({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  return (
    <StageLayer
      onDismiss={onClose}
      role="dialog"
      aria-modal
      aria-labelledby={titleId}
      className="absolute inset-0 bg-ink-fill/55"
    >
      <ReferenceBox>
        <div className="flex h-full items-center justify-center">
          <div
            data-testid="screen-legend"
            className="flex w-[1480px] flex-col gap-8 rounded-card bg-surface px-14 pt-10 pb-12 text-ink shadow-ledge-lg"
          >
            <h2 id={titleId} className="text-center text-5xl font-bold">
              {t("stage.legend.title")}
            </h2>
            <Section title={t("stage.legend.notes")}>
              <div className="flex justify-between">
                {NOTE_SAMPLES.map(({ kind, list }) => (
                  <Sample
                    key={kind}
                    list={list}
                    name={t(NOTE_TEXT[kind].name)}
                    hint={t(NOTE_TEXT[kind].hint)}
                  />
                ))}
              </div>
            </Section>
            <div className="flex gap-16">
              <Section title={t("stage.legend.pitch")}>
                <div className="flex gap-8">
                  {PITCH_SAMPLES.map(({ kind, list }) => (
                    <Sample
                      key={kind}
                      list={list}
                      name={t(PITCH_TEXT[kind].name)}
                      hint={t(PITCH_TEXT[kind].hint)}
                    />
                  ))}
                </div>
              </Section>
              <Section
                title={t("stage.legend.lyrics")}
                className="min-w-0 flex-1"
              >
                <div style={LYRICS_STYLE} className="flex flex-col gap-4">
                  <p className="flex flex-wrap items-baseline gap-x-10 pt-2">
                    <span
                      className={LYRIC_NOTE_CLASS}
                      style={lyric(1, lyricNoteStyle("normal"))}
                    >
                      {t("stage.legend.lyric.sung")}
                    </span>
                    <span
                      data-singing="true"
                      className={LYRIC_NOTE_CLASS}
                      style={lyric(0.5, lyricNoteStyle("normal"))}
                    >
                      {t("stage.legend.lyric.current")}
                    </span>
                    <span
                      className={LYRIC_NOTE_CLASS}
                      style={lyric(0, lyricNoteStyle("golden"))}
                    >
                      {t("stage.legend.lyric.golden")}
                    </span>
                    <span
                      className={LYRIC_NOTE_CLASS}
                      style={lyric(0, lyricNoteStyle("freestyle"))}
                    >
                      {t("stage.legend.lyric.freestyle")}
                    </span>
                  </p>
                  <p style={NEXT_LINE_STYLE}>{t("stage.legend.lyric.next")}</p>
                </div>
              </Section>
            </div>
            <div data-stage-default className="flex justify-center">
              <Button onPress={onClose}>{t("stage.legend.back")}</Button>
            </div>
          </div>
        </div>
      </ReferenceBox>
    </StageLayer>
  );
}
