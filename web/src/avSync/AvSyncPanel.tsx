// Check A/V sync's screen (v1 spec #53, ticket #163), for any browser: the
// bouncing ball drawn by the sing screen's painter, the value large with its
// sign, −/+, Reset to 0 and Done. The Stage hosts it as its Setup overlay
// (`StageAvSync.tsx`); the Timing editor (#57) can host it for its own
// browser, AudioContext and output: give it its own `useAvSyncValue` over
// `useAvOffset(browser, output)` and `useClickTrack` over its own chain.

import { useCallback, useEffect, useRef, useState } from "react";

import type { BrowserAvOffset } from "../avOffset/useAvOffset";
import type { AvSyncStep } from "../generated/AvSyncStep";
import { t } from "../i18n/t";
import type { GainChain } from "../playback/gainChain";
import { createPainter } from "../stage/sing/painter";
import { readToken } from "../theme/tokens";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { AV_SYNC_FRAME, avSyncFrame } from "./avSyncFrame";
import { avOffsetText, nextAvOffset } from "./avSyncStep";
import { startClickTrack } from "./clickTrack";

/**
 * The value shown and one press. A press moves on from the last press at
 * once, before its save returns, so quick presses add up; each is saved at
 * once (`offset.save`).
 */
export function useAvSyncValue(offset: Pick<BrowserAvOffset, "ms" | "save">): {
  ms: number;
  step: (step: AvSyncStep) => void;
} {
  const [pending, setPending] = useState<number | null>(null);
  const ms = pending ?? offset.ms;
  const latest = useRef({ ms, save: offset.save });
  useEffect(() => {
    latest.current = { ms, save: offset.save };
  });
  const step = useCallback((press: AvSyncStep) => {
    const next = nextAvOffset(latest.current.ms, press);
    latest.current.ms = next;
    setPending(next);
    void latest.current.save(next).finally(() => {
      setPending((shown) => (shown === next ? null : shown));
    });
  }, []);
  return { ms, step };
}

/** Where the page's audio comes from: its gain chain, and how to start it. */
export interface ClickAudio {
  chain(): GainChain;
  resume(): Promise<void>;
}

/** Clicks once a second while mounted; returns the landing times' getter. */
export function useClickTrack(audio: ClickAudio): () => readonly number[] {
  const landings = useRef<() => readonly number[]>(() => []);
  useEffect(() => {
    audio.resume().catch(() => {
      // Still suspended (no gesture yet): the clicks start once it runs.
    });
    const track = startClickTrack(audio.chain());
    landings.current = () => track.landings();
    return () => {
      track.stop();
      landings.current = () => [];
    };
  }, [audio]);
  return useCallback(() => landings.current(), []);
}

/** The pattern's canvas, redrawn on every animation frame. */
function Pattern({
  landings,
  ms,
}: {
  landings: () => readonly number[];
  ms: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offset = useRef(ms);
  useEffect(() => {
    offset.current = ms;
  }, [ms]);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const painter = createPainter(ctx, (ref) => readToken(ref));
    let handle = 0;
    function draw() {
      if (!canvas) return;
      const ratio = window.devicePixelRatio || 1;
      const width = Math.round(canvas.clientWidth * ratio);
      const height = Math.round(canvas.clientHeight * ratio);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const scale = width / AV_SYNC_FRAME.width;
      painter.paint(
        avSyncFrame(landings(), performance.now(), offset.current),
        {
          scale,
          x: 0,
          y: 0,
        },
      );
      handle = requestAnimationFrame(draw);
    }
    handle = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(handle);
    };
  }, [landings]);
  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={t("avSync.pattern")}
      className="block w-full"
      style={{
        aspectRatio: `${String(AV_SYNC_FRAME.width)} / ${String(AV_SYNC_FRAME.height)}`,
      }}
    />
  );
}

const STEP_BUTTON =
  "flex size-28 shrink-0 cursor-pointer items-center justify-center rounded-full bg-ink text-white shadow-ledge-ink outline-none focus-visible:outline-6 focus-visible:outline-yellow";

export interface AvSyncPanelProps {
  ms: number;
  landings: () => readonly number[];
  onStep: (step: AvSyncStep) => void;
  onDone: () => void;
  /** What to press, for where it is hosted. */
  hint: string;
}

export function AvSyncPanel({
  ms,
  landings,
  onStep,
  onDone,
  hint,
}: AvSyncPanelProps) {
  return (
    <div className="flex flex-col gap-6" data-testid="av-sync">
      <Pattern landings={landings} ms={ms} />
      <div className="flex items-center justify-center gap-10">
        <button
          type="button"
          aria-label={t("avSync.down")}
          onClick={() => {
            onStep("down");
          }}
          className={STEP_BUTTON}
        >
          <Icon name="minus" className="size-12" />
        </button>
        <p
          aria-label={t("avSync.value")}
          aria-live="polite"
          data-testid="av-sync-value"
          className="min-w-80 text-center text-7xl font-bold tabular-nums"
        >
          {avOffsetText(ms)}
        </p>
        <button
          type="button"
          aria-label={t("avSync.up")}
          onClick={() => {
            onStep("up");
          }}
          className={STEP_BUTTON}
        >
          <Icon name="plus" className="size-12" />
        </button>
      </div>
      <p className="text-center text-2xl text-ink-2">{hint}</p>
      <div className="flex justify-center gap-6">
        <Button
          fill="white"
          onPress={() => {
            onStep("reset");
          }}
        >
          {t("avSync.reset")}
        </Button>
        <Button fill="green" onPress={onDone}>
          {t("avSync.done")}
        </Button>
      </div>
    </div>
  );
}
