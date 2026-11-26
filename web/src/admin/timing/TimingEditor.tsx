// The desktop Timing editor (v1 spec #57), in the Admin area's Songs section:
// the overview strip of the whole Song, the detail view (waveform, heard pitch
// as dots, the Notes as pills filling green by their match share, the
// playhead) and the side panel with the Song's "notes on the singing".
//
// Opening it asks for the Pitch track (a cached track is there at once;
// otherwise the job's progress shows until it is ready) and applies nothing:
// the edit model starts with no edits. Needs no PIN. Gestures (#219), playback
// (#220), Auto-fit (#221) and saving (#188) attach here.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { Label, Meter } from "react-aria-components";

import { songQuery } from "../../api/queries";
import { createMatcher, fitNotesOf } from "../../fit/fit";
import { loadPitchTrack, type PitchTrackLoad } from "../../fit/loadPitchTrack";
import type { SongDetail } from "../../generated/SongDetail";
import type { SongId } from "../../generated/SongId";
import { userMessageText } from "../../i18n/serverText";
import { t } from "../../i18n/t";
import { liveStore } from "../../live/useLive";
import type { LiveStore } from "../../live/liveStore";
import { readToken } from "../../theme/tokens";
import {
  currentTiming,
  noteTimes,
  openTimingModel,
} from "../../timing/timingModel";
import { clockText, DETAIL, detailFrame } from "./detailFrame";
import { createEditorPainter } from "./editorPainter";
import {
  openView,
  scrollView,
  timeAtX,
  zoomView,
  type EditorView,
} from "./editorView";
import { overviewFrame, overviewTimeAt } from "./overviewFrame";

export interface TimingEditorProps {
  song: SongId;
  /** Where job updates come from (the browser's live store by default). */
  store?: Pick<LiveStore, "onJobChanged">;
}

export function TimingEditor({ song, store }: TimingEditorProps) {
  const detail = useQuery(songQuery(song));
  const pitchTrack = usePitchTrack(song, store);
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          to="/admin/songs"
          className="rounded-full bg-white px-4 py-1.5 text-lg font-semibold text-ink shadow-ledge-sm outline-none focus-visible:outline-6 focus-visible:outline-yellow"
        >
          {t("timing.view.back")}
        </Link>
        <h2 className="min-w-0 grow truncate text-3xl font-bold">
          {detail.data
            ? t("timing.view.title", {
                artist: detail.data.song.headers.artist,
                title: detail.data.song.headers.title,
              })
            : t("timing.view.titleLoading")}
        </h2>
        <PitchTrackStatus load={pitchTrack} />
      </div>
      {detail.data ? (
        <Editor detail={detail.data} load={pitchTrack} />
      ) : (
        <p role={detail.isError ? "alert" : undefined} className="py-4 text-lg">
          {t(detail.isError ? "timing.view.loadFailed" : "timing.view.loading")}
        </p>
      )}
    </section>
  );
}

/** Loads the Song's Pitch track once per Song, following its job. */
function usePitchTrack(
  song: SongId,
  store: Pick<LiveStore, "onJobChanged"> | undefined,
): PitchTrackLoad {
  const [load, setLoad] = useState<PitchTrackLoad>({
    state: "listening",
    percent: null,
  });
  const jobs = store ?? liveStore();
  useEffect(() => {
    // One Song per mount (the page keys the editor by Song).
    const controller = new AbortController();
    loadPitchTrack(
      song,
      {
        onJobChanged: (listener) => jobs.onJobChanged(listener),
        signal: controller.signal,
      },
      setLoad,
    );
    return () => {
      controller.abort();
    };
  }, [song, jobs]);
  return load;
}

function PitchTrackStatus({ load }: { load: PitchTrackLoad }) {
  if (load.state === "listening")
    return (
      <span
        role="status"
        className="rounded-full bg-ink px-4 py-1.5 text-lg font-semibold text-white"
      >
        {load.percent === null
          ? t("timing.view.listening")
          : t("timing.view.listeningPercent", {
              percent: Math.round(load.percent),
            })}
      </span>
    );
  if (load.state === "failed")
    return (
      <span
        role="alert"
        className="rounded-full bg-warn-bg px-4 py-1.5 text-lg font-semibold text-warn-fg"
      >
        {userMessageText(load.reason)}
      </span>
    );
  return null;
}

/** Seconds of the Song shown left of a time the overview strip seeks to. */
const SEEK_LEAD_SECONDS = 3;
const DETAIL_HEIGHT = 380;
const OVERVIEW_HEIGHT = 64;

function Editor({
  detail,
  load,
}: {
  detail: SongDetail;
  load: PitchTrackLoad;
}) {
  // Opening applies nothing: the model starts as the file is.
  const [model] = useState(() => openTimingModel(detail.song));
  const timing = useMemo(() => currentTiming(model), [model]);
  const [view, setView] = useState<EditorView>(openView);
  const [playhead, setPlayhead] = useState(0);

  const track = load.state === "ready" ? load.track : null;
  const matcher = useMemo(() => (track ? createMatcher(track) : null), [track]);
  const songShare = useMemo(
    () =>
      matcher ? matcher.share(fitNotesOf(timing.song), timing.grid) : null,
    [matcher, timing],
  );
  const duration = useMemo(
    () => songDuration(detail, timing, track?.pitch.length),
    [detail, timing, track],
  );

  const detailRef = useRef<HTMLCanvasElement>(null);
  const overviewRef = useRef<HTMLCanvasElement>(null);
  const detailWidth = useWidth(detailRef);
  const overviewWidth = useWidth(overviewRef);

  // The wheel needs a listener that is not passive, to keep the page still.
  useEffect(() => {
    const canvas = detailRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const x = event.clientX - canvas.getBoundingClientRect().left;
      setView((v) =>
        event.ctrlKey || event.metaKey
          ? zoomView(v, x, event.deltaY)
          : scrollView(v, event),
      );
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
    };
  }, []);

  // Dragging on the ruler seeks.
  const seeking = useRef(false);
  const pointerX = (event: ReactPointerEvent<HTMLCanvasElement>) =>
    event.clientX - event.currentTarget.getBoundingClientRect().left;
  const onDetailDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const y = event.clientY - event.currentTarget.getBoundingClientRect().top;
    if (y >= DETAIL.ruler) return;
    seeking.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    setPlayhead(clampTime(timeAtX(view, pointerX(event)), duration));
  };
  const onDetailMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!seeking.current) return;
    setPlayhead(clampTime(timeAtX(view, pointerX(event)), duration));
  };
  const onDetailUp = () => {
    seeking.current = false;
  };

  const onOverviewDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const at = overviewTimeAt(event.clientX - rect.left, rect.width, duration);
    setPlayhead(at);
    setView((v) => ({ ...v, start: at - SEEK_LEAD_SECONDS }));
  };

  // Paint both canvases whenever what they show changes.
  useEffect(() => {
    const ratio = window.devicePixelRatio || 1;
    const read = (ref: Parameters<typeof readToken>[0]) => readToken(ref);
    const detailCanvas = detailRef.current;
    const detailCtx = detailCanvas?.getContext("2d");
    if (detailCanvas && detailCtx && detailWidth > 0) {
      sizeCanvas(detailCanvas, detailWidth, DETAIL_HEIGHT, ratio);
      createEditorPainter(detailCtx, read).paintDetail(
        detailFrame({
          song: timing.song,
          grid: timing.grid,
          track,
          matcher,
          playhead,
          view,
          width: detailWidth,
          height: DETAIL_HEIGHT,
        }),
        { width: detailWidth, height: DETAIL_HEIGHT, pixelRatio: ratio },
      );
    }
    const overviewCanvas = overviewRef.current;
    const overviewCtx = overviewCanvas?.getContext("2d");
    if (overviewCanvas && overviewCtx && overviewWidth > 0) {
      sizeCanvas(overviewCanvas, overviewWidth, OVERVIEW_HEIGHT, ratio);
      createEditorPainter(overviewCtx, read).paintOverview(
        overviewFrame({
          song: timing.song,
          grid: timing.grid,
          track,
          matcher,
          duration,
          playhead,
          view,
          detailWidth,
          width: overviewWidth,
          height: OVERVIEW_HEIGHT,
        }),
        { width: overviewWidth, height: OVERVIEW_HEIGHT, pixelRatio: ratio },
      );
    }
  }, [
    timing,
    track,
    matcher,
    playhead,
    view,
    duration,
    detailWidth,
    overviewWidth,
  ]);

  const canvasClass =
    "block w-full touch-none rounded-[18px] bg-white ring-3 ring-ink";
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <div className="flex min-w-0 grow flex-col gap-2">
        <canvas
          ref={overviewRef}
          role="img"
          aria-label={t("timing.view.overview")}
          onPointerDown={onOverviewDown}
          className={`${canvasClass} cursor-pointer`}
          style={{ height: OVERVIEW_HEIGHT }}
        />
        <canvas
          ref={detailRef}
          role="img"
          aria-label={t("timing.view.detail")}
          data-pitch-track={load.state === "listening" ? "pending" : load.state}
          data-view-start={String(round6(view.start))}
          data-pixels-per-second={String(round6(view.pixelsPerSecond))}
          data-playhead={String(round6(playhead))}
          onPointerDown={onDetailDown}
          onPointerMove={onDetailMove}
          onPointerUp={onDetailUp}
          onPointerCancel={onDetailUp}
          className={canvasClass}
          style={{ height: DETAIL_HEIGHT }}
        />
        <p className="text-sm text-ink-2">{t("timing.view.help")}</p>
      </div>
      <SidePanel
        share={songShare}
        pending={load.state !== "ready"}
        playhead={playhead}
      />
    </div>
  );
}

function SidePanel({
  share,
  pending,
  playhead,
}: {
  share: number | null;
  pending: boolean;
  playhead: number;
}) {
  const percent = share === null ? null : Math.round(share * 100);
  return (
    <aside className="flex w-full shrink-0 flex-col gap-4 rounded-[22px] bg-white p-5 shadow-ledge lg:w-80">
      {pending || percent === null ? (
        <div className="flex flex-col gap-2">
          <span className="text-lg font-semibold">
            {t("timing.view.share")}
          </span>
          <span className="text-ink-2">
            {t(pending ? "timing.view.sharePending" : "timing.view.shareNone")}
          </span>
        </div>
      ) : (
        <Meter value={percent} className="flex flex-col gap-2">
          <Label className="text-lg font-semibold">
            {t("timing.view.share")}
          </Label>
          <div className="flex items-center gap-3">
            <div className="h-3.5 grow overflow-hidden rounded-full bg-passed ring-2 ring-ink">
              <div
                className="h-full rounded-full bg-green transition-[width]"
                style={{ width: `${String(percent)}%` }}
              />
            </div>
            <span className="min-w-14 text-right text-2xl font-bold tabular-nums">
              {t("timing.view.sharePercent", { percent })}
            </span>
          </div>
        </Meter>
      )}
      <p className="text-sm text-ink-2">{t("timing.view.shareWhat")}</p>
      <p className="text-lg tabular-nums">
        {t("timing.view.playhead", { time: clockText(playhead) })}
      </p>
    </aside>
  );
}

/** The Song's length: the index's, else the track's, else its last Note plus 5 s. */
function songDuration(
  detail: SongDetail,
  timing: ReturnType<typeof currentTiming>,
  frames: number | undefined,
): number {
  if (detail.lengthSeconds !== null && detail.lengthSeconds > 0)
    return detail.lengthSeconds;
  if (frames !== undefined && frames > 0) return frames * 0.01;
  let end = 0;
  for (const v of timing.song.voices)
    for (const l of v.lines)
      for (const n of l.notes)
        end = Math.max(end, noteTimes(timing.grid, n).end);
  return end + 5;
}

function clampTime(t: number, duration: number): number {
  return Math.max(0, Math.min(duration, t));
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function sizeCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  ratio: number,
) {
  const w = Math.round(width * ratio);
  const h = Math.round(height * ratio);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

/** The element's width in CSS pixels, kept current (0 where nothing measures it). */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setWidth(element.clientWidth);
    });
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return width;
}
