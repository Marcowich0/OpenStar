// The `?perf` frame-time overlay (#227): the current, mean and worst frame
// time over the last second against the display's frame budget, in a corner
// of the sing screen. Its own animation frame loop records every frame's
// timestamp (the same timestamp the sing screen's render loop gets) and
// writes the text straight to the DOM a few times a second, so the overlay
// itself adds no React render per frame.

import { useEffect, useRef } from "react";

import { t } from "../../i18n/t";
import { FrameMeter, type FrameStats } from "./frameStats";

/** How often the text changes, ms of frame time. */
const UPDATE_MS = 250;
/** A frame this many budgets long is a missed frame. */
const MISSED = 1.5;

export interface FrameTimeOverlayProps {
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

const ms = (value: number) => value.toFixed(1);

function lines(stats: FrameStats): string[] {
  return [
    t("stage.perf.current", { ms: ms(stats.currentMs) }),
    t("stage.perf.mean", { ms: ms(stats.meanMs) }),
    t("stage.perf.worst", { ms: ms(stats.worstMs) }),
    t("stage.perf.budget", {
      ms: ms(stats.budgetMs),
      hz: Math.round(stats.refreshHz).toString(),
    }),
  ];
}

export function FrameTimeOverlay({
  requestFrame = (callback) => window.requestAnimationFrame(callback),
  cancelFrame = (handle) => {
    window.cancelAnimationFrame(handle);
  },
}: FrameTimeOverlayProps) {
  const root = useRef<HTMLDivElement>(null);
  const loop = useRef({ requestFrame, cancelFrame });

  useEffect(() => {
    const { requestFrame, cancelFrame } = loop.current;
    const meter = new FrameMeter();
    let writtenAt: number | null = null;
    let handle: number | null = null;
    const write = (timestamp: number) => {
      const stats = meter.stats();
      const element = root.current;
      if (!stats || !element) return;
      writtenAt = timestamp;
      const texts = lines(stats);
      element.querySelectorAll("[data-perf-line]").forEach((line, i) => {
        line.textContent = texts[i] ?? "";
      });
      element.dataset["overBudget"] = String(
        stats.worstMs >= MISSED * stats.budgetMs,
      );
      element.dataset["measured"] = "true";
    };
    const onFrame = (timestamp: number) => {
      meter.frame(timestamp);
      if (writtenAt === null || timestamp - writtenAt >= UPDATE_MS) {
        write(timestamp);
      }
      handle = requestFrame(onFrame);
    };
    handle = requestFrame(onFrame);
    return () => {
      if (handle !== null) cancelFrame(handle);
    };
  }, []);

  return (
    <div
      ref={root}
      data-perf-overlay
      data-over-budget="false"
      className="group pointer-events-none absolute top-6 right-6 z-toast rounded-card bg-ink-fill/80 px-6 py-4 font-mono text-2xl text-white data-[over-budget=true]:text-red"
    >
      <p className="group-data-[measured]:hidden">
        {t("stage.perf.measuring")}
      </p>
      {[0, 1, 2, 3].map((i) => (
        <p key={i} data-perf-line />
      ))}
    </div>
  );
}
