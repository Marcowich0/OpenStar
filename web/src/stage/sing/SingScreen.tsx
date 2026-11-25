// The sing screen's layers and its one render loop. Layers, bottom to top, as
// in the prototype: the video (or backdrop), the frosted lane panels, the
// lanes canvas, the DOM lane headers and lyric bar, the effects canvas, then
// toasts and overlays. Both canvases cover the screen at device pixels; the
// DOM layers sit in the same 1920 × 1080 reference frame, scaled the same way.
//
// #211 adds the Bubble Pop panels and lane headers; the lyric bar and the
// effects come from #55's other sing screen tickets.

import { useEffect, useRef, useState, type ReactNode } from "react";

import type { SongClock } from "../../clock/songClock";
import { readToken, tokenVar } from "../../theme/tokens";
import { t } from "../../i18n/t";
import { Avatar } from "../../ui/Avatar";
import { Score } from "../../ui/Score";
import type { DrawList, SingLane, SingState } from "./frame";
import { laneHeaderSizes } from "./laneHeader";
import { laneLayout, type LaneRect } from "./laneLayout";
import { createPainter, referenceTransform } from "./painter";
import { createRenderLoop } from "./renderLoop";

export interface SingScreenProps {
  /** What to sing: the Song's Voices and one lane per Player. */
  state: SingState;
  /** The Song clock; the render loop is the only reader of `songTime()`. */
  clock: Pick<SongClock, "songTime">;
  /** The Stage's A/V offset in seconds (#53); drawing runs this much behind. */
  avOffset: () => number;
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

/** Sizes a canvas's backing store to the viewport in device pixels. */
function fitCanvas(canvas: HTMLCanvasElement | null, view: Viewport) {
  if (!canvas) return;
  canvas.width = Math.round(view.width * view.ratio);
  canvas.height = Math.round(view.height * view.ratio);
}

const FULL_SCREEN = "pointer-events-none absolute inset-0 h-full w-full";

/** The frosted panel's ledge and soft shadow (#55). */
const PANEL_SHADOW = `0 10px 0 ${tokenVar("--color-lane-ledge")}, 0 20px 40px ${tokenVar("--color-lane-shadow")}`;

export function SingScreen({
  state,
  clock,
  avOffset,
  backdrop,
  children,
}: SingScreenProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLCanvasElement>(null);
  const effectsRef = useRef<HTMLCanvasElement>(null);
  const [viewport, setViewport] = useState(currentViewport);

  // The loop reads the latest props each frame without restarting.
  const latest = useRef({ state, clock, avOffset, viewport });
  useEffect(() => {
    latest.current = { state, clock, avOffset, viewport };
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
    fitCanvas(lanesRef.current, viewport);
    fitCanvas(effectsRef.current, viewport);
  }, [viewport]);

  useEffect(() => {
    const ctx = lanesRef.current?.getContext("2d");
    if (!ctx) return;
    const painter = createPainter(ctx, (ref) => readToken(ref));
    let transform = referenceTransform(1, 1, 1);
    let transformFor: Viewport | null = null;
    let painted = false;
    const loop = createRenderLoop({
      clock: () => latest.current.clock,
      avOffset: () => latest.current.avOffset(),
      state: () => latest.current.state,
      paint: (list: DrawList) => {
        const view = latest.current.viewport;
        if (view !== transformFor) {
          transform = referenceTransform(view.width, view.height, view.ratio);
          transformFor = view;
        }
        painter.paint(list, transform);
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
  }, []);

  const frame = referenceTransform(viewport.width, viewport.height, 1);
  const referenceStyle = {
    width: 1920,
    height: 1080,
    transform: `translate(${String(frame.x)}px, ${String(frame.y)}px) scale(${String(frame.scale)})`,
    transformOrigin: "0 0",
  };
  const lanes = laneLayout(state.lanes.length);

  return (
    <div
      ref={rootRef}
      data-sing-screen
      className="fixed inset-0 overflow-hidden bg-ink font-sans"
    >
      <div data-layer="backdrop" className="absolute inset-0">
        {backdrop}
      </div>
      <div
        data-layer="panels"
        className="pointer-events-none absolute top-0 left-0"
        style={referenceStyle}
      >
        {lanes.map((lane, i) => (
          <div
            key={i}
            data-lane-panel
            className="absolute overflow-hidden bg-white/66 backdrop-blur-lg backdrop-saturate-130"
            style={{
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
                backgroundColor: tokenVar(
                  state.lanes[i]?.colour ?? "--color-white",
                ),
              }}
            />
          </div>
        ))}
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
            rect={lane}
            lane={state.lanes[i]}
            duet={state.voices.length > 1}
          />
        ))}
        <div data-lyric-bar className="absolute right-0 bottom-[34px] left-0" />
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

/**
 * A lane's header, left of its Notes area (#55, "Lane header"): the avatar,
 * the name (with "guest" for a Guest and the Voice in a duet) and the
 * running Score.
 */
function LaneHeader({
  rect,
  lane,
  duet,
}: {
  rect: LaneRect;
  lane: SingLane | undefined;
  duet: boolean;
}) {
  const player = lane?.player;
  const sizes = laneHeaderSizes(rect.height);
  // The two-column headers (210 px) are tighter, so a 5-digit Score fits.
  const narrow = rect.notesX - rect.x < 240;
  return (
    <div
      data-lane-header
      className={`absolute flex items-center text-ink ${narrow ? "gap-2 pr-1.5 pl-3" : "gap-3.5 pr-3 pl-[18px]"}`}
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
