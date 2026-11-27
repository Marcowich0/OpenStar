// The sing screen's layers and its one render loop. Layers, bottom to top, as
// in the prototype: the video (or backdrop), the background canvas (the blobs
// of a Song without a video or background image, #263), the frosted lane
// panels, the lanes canvas, the DOM lane headers and lyric bar, the effects
// canvas, then toasts and overlays. The lanes and effects canvases cover the
// screen at device pixels; the background canvas holds a quarter of the CSS
// pixels, stretched over the screen, which smooths its soft blobs for free.
// The DOM layers sit in the same 1920 × 1080 reference frame, scaled the
// same way.
//
// #211 adds the Bubble Pop panels and lane headers, #133 the lyric text and
// its fill, #134 the effects canvas and its particles; the lyric bar's look
// and which events burst come from #55's other sing screen tickets.
//
// Nothing here re-renders per frame: the render loop paints the canvas and
// writes the lyric fill straight to the DOM. The lane panels re-render only
// when the Line-up changes, the lyric text only when a Line does.

import { memo, useEffect, useRef, useState, type ReactNode } from "react";

import type { SongClock } from "../../clock/songClock";
import { shownTheme, THEMES } from "../../theme/themes";
import { readToken, tokenVar } from "../../theme/tokens";
import { useShownTheme } from "../../theme/useShownTheme";
import { t } from "../../i18n/t";
import { Avatar } from "../../ui/Avatar";
import { Icon } from "../../ui/Icon";
import { Score } from "../../ui/Score";
import { createImageCache } from "./coverImages";
import type { DrawList, SingLane, SingState } from "./frame";
import { laneHeaderSizes } from "./laneHeader";
import { createLaneLostWriter, type LaneLostWriter } from "./laneLost";
import {
  createLineRatingWriter,
  type LineRatingWriter,
} from "./lineRatingWriter";
import type { LaneRect } from "./laneLayout";
import { createLyricDriver, LyricBar } from "./LyricBar";
import {
  coverTransform,
  createPainter,
  referenceTransform,
  type ReferenceTransform,
} from "./painter";
import { createRenderLoop } from "./renderLoop";
import {
  DEFAULT_SING_LOOK,
  laneFill,
  sameLook,
  singLayout,
  surfaceFillStyle,
  type SingLook,
} from "./singLook";

export interface SingScreenProps {
  /** What to sing: the Song's Voices and one lane per Player. */
  state: SingState;
  /** The Song clock; the render loop is the only reader of `songTime()`. */
  clock: Pick<SongClock, "songTime">;
  /** The Stage's A/V offset in seconds (#53); drawing runs this much behind. */
  avOffset: () => number;
  /**
   * The real time in ms that moves the effects; the animation frame's
   * timestamp by default. A constant freezes them (the screenshot page).
   */
  frameTime?: () => number;
  /** The bottom layer: the music video, or the backdrop without one. */
  backdrop?: ReactNode;
  /** The top layer: toasts and overlays. */
  children?: ReactNode;
}

interface Viewport {
  width: number;
  height: number;
  ratio: number;
}

function currentViewport(): Viewport {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    ratio: window.devicePixelRatio || 1,
  };
}

/** Sizes a canvas's backing store to the viewport, `ratio` pixels per CSS pixel. */
function fitCanvas(
  canvas: HTMLCanvasElement | null,
  view: Viewport,
  ratio = view.ratio,
) {
  if (!canvas) return;
  canvas.width = Math.round(view.width * ratio);
  canvas.height = Math.round(view.height * ratio);
}

/**
 * The background canvas's pixels per CSS pixel, whatever the device's: the
 * blobs are soft gradients, so a quarter of the pixels look the same once
 * the browser stretches them, and cost a sixteenth to paint.
 */
const BACKGROUND_SCALE = 1 / 4;

const FULL_SCREEN = "pointer-events-none absolute inset-0 h-full w-full";

/** The frosted panel's ledge and soft shadow (#55). */
const PANEL_SHADOW = `0 10px 0 ${tokenVar("--color-lane-ledge")}, 0 20px 40px ${tokenVar("--color-lane-shadow")}`;

export function SingScreen({
  state,
  clock,
  avOffset,
  frameTime,
  backdrop,
  children,
}: SingScreenProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const backgroundRef = useRef<HTMLCanvasElement>(null);
  const lanesRef = useRef<HTMLCanvasElement>(null);
  const effectsRef = useRef<HTMLCanvasElement>(null);
  const [viewport, setViewport] = useState(currentViewport);
  const [lyrics] = useState(createLyricDriver);
  const [lost] = useState(createLaneLostWriter);
  const [ratings] = useState(createLineRatingWriter);
  // The title card's cover (#264), loaded once per URL.
  const [images] = useState(() => createImageCache());

  // The loop reads the latest props each frame without restarting.
  const latest = useRef({ state, clock, avOffset, frameTime, viewport });
  useEffect(() => {
    latest.current = { state, clock, avOffset, frameTime, viewport };
  });

  useEffect(() => {
    const onResize = () => {
      setViewport(currentViewport());
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    fitCanvas(backgroundRef.current, viewport, BACKGROUND_SCALE);
    fitCanvas(lanesRef.current, viewport);
    fitCanvas(effectsRef.current, viewport);
  }, [viewport]);

  useEffect(() => {
    const ctx = lanesRef.current?.getContext("2d");
    if (!ctx) return;
    const painter = createPainter(
      ctx,
      (ref) => readToken(ref),
      "lanes",
      images.get,
    );
    const effectsCtx = effectsRef.current?.getContext("2d");
    const effects =
      effectsCtx &&
      createPainter(effectsCtx, (ref) => readToken(ref), "effects");
    const backgroundCtx = backgroundRef.current?.getContext("2d");
    const background =
      backgroundCtx &&
      createPainter(backgroundCtx, (ref) => readToken(ref), "background");
    let transform = referenceTransform(1, 1, 1);
    let backgroundTransform: ReferenceTransform = transform;
    let transformFor: Viewport | null = null;
    let painted = false;
    const loop = createRenderLoop({
      clock: () => latest.current.clock,
      avOffset: () => latest.current.avOffset(),
      state: () => latest.current.state,
      theme: () => THEMES[shownTheme()].sing,
      frameTime: (timestamp) => latest.current.frameTime?.() ?? timestamp,
      paint: (list: DrawList) => {
        const view = latest.current.viewport;
        if (view !== transformFor) {
          transform = referenceTransform(view.width, view.height, view.ratio);
          backgroundTransform = coverTransform(
            view.width,
            view.height,
            BACKGROUND_SCALE,
          );
          transformFor = view;
        }
        background?.paint(list, backgroundTransform);
        painter.paint(list, transform);
        effects?.paint(list, transform);
        lyrics.apply(list);
        lost.apply(list);
        ratings.apply(list);
        if (!painted && rootRef.current) {
          // For screenshots (#58): the first frame is on the canvas.
          rootRef.current.dataset.painted = "true";
          painted = true;
        }
      },
    });
    loop.start();
    return () => {
      loop.stop();
    };
  }, [lyrics, lost, ratings, images]);

  const frame = referenceTransform(viewport.width, viewport.height, 1);
  const referenceStyle = {
    width: 1920,
    height: 1080,
    transform: `translate(${String(frame.x)}px, ${String(frame.y)}px) scale(${String(frame.scale)})`,
    transformOrigin: "0 0",
  };
  const lanes = singLayout(state);

  return (
    <div
      ref={rootRef}
      data-sing-screen
      className="fixed inset-0 overflow-hidden bg-ink-fill font-sans"
    >
      <div data-layer="backdrop" className="absolute inset-0">
        {backdrop}
      </div>
      <canvas
        ref={backgroundRef}
        data-layer="background"
        aria-hidden
        className={FULL_SCREEN}
      />
      <div
        data-layer="panels"
        className="pointer-events-none absolute top-0 left-0"
        style={referenceStyle}
      >
        <LanePanels
          lanes={state.lanes}
          voices={state.voices}
          look={state.look}
        />
      </div>
      <canvas
        ref={lanesRef}
        data-layer="lanes"
        aria-hidden
        className={FULL_SCREEN}
      />
      <div
        data-layer="headers"
        className="pointer-events-none absolute top-0 left-0"
        style={referenceStyle}
      >
        {lanes.map((lane, i) => (
          <LaneHeader
            key={i}
            index={i}
            rect={lane}
            lane={state.lanes[i]}
            duet={state.voices.length > 1}
            lost={lost}
          />
        ))}
        {lanes.map((lane, i) => (
          <MicLostPill
            key={i}
            index={i}
            rect={lane}
            name={state.lanes[i]?.player?.name}
            lost={lost}
          />
        ))}
        {lanes.map((_, i) => (
          <LineRatingWord key={i} index={i} writer={ratings} />
        ))}
        <LyricBar voices={state.voices} driver={lyrics} look={state.look} />
      </div>
      <canvas
        ref={effectsRef}
        data-layer="effects"
        aria-hidden
        className={FULL_SCREEN}
      />
      <div data-layer="overlays" className="absolute inset-0">
        {children}
      </div>
    </div>
  );
}

interface LanePanelsProps {
  lanes: readonly SingLane[];
  /** The Song's Voices: a duet's lyric bar is taller. None: one Voice. */
  voices?: SingState["voices"];
  /** The lyric bar's size and the frosting; none: `DEFAULT_SING_LOOK`. */
  look?: SingLook | undefined;
}

/**
 * Panels change only with the Line-up (how many Players, in which colours),
 * the Voice count and the look.
 */
function sameLineUp(a: LanePanelsProps, b: LanePanelsProps): boolean {
  return (
    a.lanes.length === b.lanes.length &&
    a.lanes.every((lane, i) => lane.colour === b.lanes[i]?.colour) &&
    (a.voices?.length ?? 1) === (b.voices?.length ?? 1) &&
    sameLook(a.look ?? DEFAULT_SING_LOOK, b.look ?? DEFAULT_SING_LOOK)
  );
}

/**
 * The frosted lane panels (DOM, for the backdrop blur), one per lane, placed
 * by the same `singLayout` as the canvas, frosted by the same `laneFill` as
 * the draw list's lanes (solid in High contrast) and tinted in the Party
 * colour. They re-render only when the Line-up, the look or the shown theme
 * changes, not when a Score or a frame does.
 */
export const LanePanels = memo(function LanePanels({
  lanes,
  voices = [],
  look = DEFAULT_SING_LOOK,
}: LanePanelsProps) {
  const fill = surfaceFillStyle(
    laneFill(look, THEMES[useShownTheme()].sing),
    "oklab",
    "saturate(130%)",
  );
  return singLayout({ lanes, voices, look }).map((lane, i) => (
    <div
      key={i}
      data-lane-panel
      className="absolute overflow-hidden"
      style={{
        ...fill,
        left: `${String(lane.x)}px`,
        top: `${String(lane.y)}px`,
        width: `${String(lane.width)}px`,
        height: `${String(lane.height)}px`,
        borderRadius: Math.min(40, lane.height / 2),
        boxShadow: PANEL_SHADOW,
      }}
    >
      <div
        className="absolute inset-0 opacity-16"
        style={{
          backgroundColor: tokenVar(lanes[i]?.colour ?? "--color-white"),
        }}
      />
    </div>
  ));
}, sameLineUp);

/**
 * A lane's header, left of its Notes area (#55, "Lane header"): the avatar,
 * the name (with "guest" for a Guest and the Voice in a duet) and the
 * running Score.
 */
function LaneHeader({
  index,
  rect,
  lane,
  duet,
  lost,
}: {
  index: number;
  rect: LaneRect;
  lane: SingLane | undefined;
  duet: boolean;
  lost: LaneLostWriter;
}) {
  const player = lane?.player;
  const sizes = laneHeaderSizes(rect.height);
  // The two-column headers (210 px) are tighter, so a 5-digit Score fits.
  const narrow = rect.notesX - rect.x < 240;
  return (
    <div
      ref={lost.header(index)}
      data-lane-header
      className={`absolute flex items-center text-ink data-lost:opacity-55 ${narrow ? "gap-2 pr-1.5 pl-3" : "gap-3.5 pr-3 pl-[18px]"}`}
      style={{
        left: `${String(rect.x)}px`,
        top: `${String(rect.y)}px`,
        width: `${String(rect.notesX - rect.x)}px`,
        height: `${String(rect.height)}px`,
      }}
    >
      {lane && player && (
        <>
          <Avatar
            name={player.name}
            avatar={player.avatar}
            colour={lane.colour}
            size={sizes.avatar}
          />
          <div className="flex min-w-0 flex-col">
            <div className="truncate text-[26px] leading-tight font-semibold">
              <span>{player.name}</span>
              {player.guest && (
                <span className="text-[19px] font-medium text-ink-2">
                  {" "}
                  {t("sing.guest")}
                </span>
              )}
              {duet && (
                <span className="text-[19px] font-medium text-ink-2">
                  {" "}
                  {t("sing.voiceTag", { voice: lane.voice + 1 })}
                </span>
              )}
            </div>
            <span
              data-lane-score
              className="leading-none font-bold"
              style={{ fontSize: sizes.score }}
            >
              <Score value={player.score} />
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** The Line rating's 4 px white outline: an 8 px stroke under the fill. */
const RATING_STYLE = {
  WebkitTextStroke: `8px ${tokenVar("--color-white")}`,
  paintOrder: "stroke",
  // A soft ledge: the lane ledge colour, slightly blurred.
  textShadow: `0 5px 4px ${tokenVar("--color-lane-ledge")}`,
} as const;

/**
 * Lane `index`'s Line rating word (#55, "Line ratings"). Hidden until a Line
 * ends; the render loop places, scales and fades it (`lineRatingWriter.ts`).
 */
function LineRatingWord({
  index,
  writer,
}: {
  index: number;
  writer: LineRatingWriter;
}) {
  return (
    <span
      ref={writer.word(index)}
      data-line-rating
      hidden
      className="absolute leading-none font-bold whitespace-nowrap"
      style={RATING_STYLE}
    />
  );
}

/** The three pulsing dots, 0.2 s apart. */
const DOT_DELAYS = [0, 0.2, 0.4];

/**
 * The ink pill on a lane whose Mic is lost (#55): "Mia's mic lost" with a
 * crossed-out mic and three pulsing dots, centred 150 px right of the lane's
 * middle. Hidden until the render loop sees the lane lost (`laneLost.ts`).
 */
function MicLostPill({
  index,
  rect,
  name,
  lost,
}: {
  index: number;
  rect: LaneRect;
  name: string | undefined;
  lost: LaneLostWriter;
}) {
  if (name === undefined) return null;
  return (
    <div
      ref={lost.pill(index)}
      data-lane-lost
      hidden
      className="absolute flex -translate-1/2 items-center gap-3.5 rounded-full bg-ink-fill py-2.5 pr-7 pl-3.5 text-[28px] font-semibold whitespace-nowrap text-white shadow-ledge-mic-lost"
      style={{
        left: `${String(rect.x + rect.width / 2 + 150)}px`,
        top: `${String(rect.y + rect.height / 2)}px`,
      }}
    >
      <Icon name="mic-off" className="size-10" />
      <span>{t("sing.micLost", { name })}</span>
      <span className="flex">
        {DOT_DELAYS.map((delay) => (
          <span
            key={delay}
            data-dot
            className="ml-[5px] inline-block size-2 animate-mic-lost-dot rounded-full bg-white"
            style={{ animationDelay: `${String(delay)}s` }}
          />
        ))}
      </span>
    </div>
  );
}
