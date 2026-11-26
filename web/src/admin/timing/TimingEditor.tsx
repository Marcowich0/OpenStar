// The desktop Timing editor (v1 spec #57), in the Admin area's Songs section:
// the overview strip of the whole Song, the detail view (waveform, heard pitch
// as dots, the Notes as pills filling green by their match share, the
// playhead) and the side panel with the Song's "notes on the singing".
//
// Opening it asks for the Pitch track (a cached track is there at once;
// otherwise the job's progress shows until it is ready) and applies nothing:
// the edit model starts with no edits. Needs no PIN. The side panel types
// `#GAP` and `#BPM`, lists the edits with undo and redo, previews the save and
// saves (`TimingPanel.tsx`), and runs Auto-fit (`AutoFitPanel.tsx`): Fit to
// the singing, offset only and the Lines still off.
//
// Checking by ear (#220): the Song plays through the Stage's clock module and
// playback adapter, one media element through the page's one AudioContext
// (`editorAudio/editorPlayback.ts`), with clicks on the Note starts and an
// optional hum, three speeds and Loop a Line. The view draws at
// `songTime() − A/V offset`, with the offset kept for this browser and its
// default output; Check A/V sync sets it here. Keys: Space or P play and
// pause, F follows the playhead again, 1/2/3 set the speed, L loops.
//
// Fine-tuning by hand (#221, the prototype's variant A): drag empty space to
// move the whole Song, double-click a Line to pin it and drag far from it to
// stretch the tempo, click (Shift-click) Lines to select them, drag them to
// shift and their ◀▶ handle to stretch, Alt-drag a Note or its right end.
// While dragging, the view, the values and the share show the edit live with
// a hint (`dragGestures.ts`); releasing commits it as one edit. Keys: `,`/`.`
// nudge the Song or the selection, `[`/`]` change the tempo around the
// playhead, Esc clears the selection.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Dialog as AriaDialog,
  Heading,
  Modal,
  ModalOverlay,
} from "react-aria-components";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import { songQuery } from "../../api/queries";
import { useAvOffset, type BrowserAvOffset } from "../../avOffset/useAvOffset";
import {
  AvSyncPanel,
  useAvSyncValue,
  useClickTrack,
} from "../../avSync/AvSyncPanel";
import {
  createEditorPlayback,
  SPEEDS,
  type EditorPlayback,
  type EditorPlaybackState,
} from "../../editorAudio/editorPlayback";
import { loopRange } from "../../editorAudio/loop";
import { noteSounds } from "../../editorAudio/noteScheduler";
import { createMatcher, fitNotesOf, type LineSuggestion } from "../../fit/fit";
import { loadPitchTrack, type PitchTrackLoad } from "../../fit/loadPitchTrack";
import type { SongDetail } from "../../generated/SongDetail";
import type { SongId } from "../../generated/SongId";
import { userMessageText } from "../../i18n/serverText";
import { t } from "../../i18n/t";
import { liveStore } from "../../live/useLive";
import type { LiveStore } from "../../live/liveStore";
import { useSongPlaying } from "../../live/playingSong";
import { stageBrowserId } from "../../mics/localMics";
import { playbackPlan } from "../../playback/playbackPlan";
import {
  createStageOutputWatcher,
  NO_DEVICES,
} from "../../stage/output/stageOutput";
import { stageAudio } from "../../stage/playback/stageAudio";
import { readToken } from "../../theme/tokens";
import { autoFit } from "../../timing/fitEdits";
import { nudgeLines, shiftLines } from "../../timing/lineEdits";
import {
  clearSelection,
  extendSelection,
  selectLine,
  type LineSelection,
} from "../../timing/selection";
import {
  nudgeSong,
  tempoAroundPlayhead,
  typeBpm,
  typeGap,
  typeVideoGap,
  type LineIndex,
} from "../../timing/songEdits";
import {
  applyOperations,
  backToTheFile,
  commit,
  currentTiming,
  editList,
  noteTimes,
  openTimingModel,
  operationsOf,
  redo,
  undo,
  type TimingEdit,
  type TimingModel,
} from "../../timing/timingModel";
import {
  clockText,
  detailFrame,
  hitDetail,
  type DetailHit,
} from "./detailFrame";
import { dragTo, type Drag, type DragResult } from "./dragGestures";
import { createEditorPainter } from "./editorPainter";
import {
  openView,
  scrollView,
  timeAtX,
  zoomView,
  type EditorView,
} from "./editorView";
import { overviewFrame, overviewTimeAt } from "./overviewFrame";
import { AutoFitPanel, type FitOutcome } from "./AutoFitPanel";
import { EditList, SaveSection, ShareMeter, TypedValue } from "./TimingPanel";
import { PlaybackPanel } from "./PlaybackPanel";

export interface TimingEditorProps {
  song: SongId;
  /**
   * Where job updates and the Song playing now come from (the browser's
   * live store by default).
   */
  store?: Pick<LiveStore, "onJobChanged" | "subscribe" | "getSnapshot">;
}

export function TimingEditor({ song, store }: TimingEditorProps) {
  const detail = useQuery(songQuery(song));
  const pitchTrack = usePitchTrack(song, store);
  const playing = useSongPlaying(song, store);
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
        <Editor detail={detail.data} load={pitchTrack} playing={playing} />
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
/** Go on a Line still off seeks this many seconds before the Line. */
const GO_LEAD_SECONDS = 1.5;
const DETAIL_HEIGHT = 380;
/** Following, the page turns once the playhead passes this share of the view… */
const FOLLOW_RIGHT = 0.85;
/** …and puts it this share in from the left. */
const FOLLOW_LEFT = 0.15;
const OVERVIEW_HEIGHT = 64;
/** A drag starts once the pointer moved this many px (a click stays a click). */
const DRAG_THRESHOLD_PX = 3;

/** A drag in progress: what it started on, the model then, and its result. */
interface DragState {
  drag: Drag;
  base: TimingModel;
  x: number;
  pixelsPerSecond: number;
  moved: boolean;
  result: DragResult | null;
}

const inSelection = (s: LineSelection, at: LineIndex) =>
  s.voice === at.voice && at.line >= s.first && at.line <= s.last;

function Editor({
  detail,
  load,
  playing,
}: {
  detail: SongDetail;
  load: PitchTrackLoad;
  /** The Song plays on the Stage now: no fit and no save (#225). */
  playing: boolean;
}) {
  // Opening applies nothing: the model starts as the file is.
  const [model, setModel] = useState(() => openTimingModel(detail.song));
  // While dragging, everything shown is the model with the drag's edit.
  const [dragPreview, setDragPreview] = useState<DragResult | null>(null);
  const shown = useMemo(
    () => (dragPreview?.edit ? commit(model, dragPreview.edit, 0) : model),
    [model, dragPreview],
  );
  const timing = useMemo(() => currentTiming(shown), [shown]);
  // When the editor opened the Song, sent with every save (#225).
  const [openedAtMs] = useState(detail.loadedAtMs);
  const fileTiming = useMemo(
    () => currentTiming(openTimingModel(model.song)),
    [model.song],
  );
  const operations = useMemo(() => operationsOf(model), [model]);
  const apply = (gesture: (m: TimingModel) => TimingEdit | null) => {
    setModel((m) => {
      const edit = gesture(m);
      return edit ? commit(m, edit, performance.now()) : m;
    });
  };
  useUndoKeys(setModel);
  const queryClient = useQueryClient();
  const [view, setView] = useState<EditorView>(openView);
  // The view keeps the playhead in sight until the wheel moves it; F again.
  const [following, setFollowing] = useState(true);
  const { playback, playState, element, setElement, setFollowVideo, plan } =
    useEditorPlayback(detail);
  const avOffset = useEditorAvOffset();
  const [clicks, setClicks] = useState(true);
  const [hum, setHum] = useState(false);
  const [checkingAvSync, setCheckingAvSync] = useState(false);
  useEffect(() => {
    playback?.setSounds(noteSounds(timing.song, timing.grid, { clicks, hum }));
  }, [playback, timing, clicks, hum]);
  useEffect(() => {
    playback?.setVideoGap(timing.videoGapSeconds ?? 0);
  }, [playback, timing.videoGapSeconds]);
  /** Where the view draws the playhead: Song time minus the A/V offset. */
  const offsetSeconds = avOffset.seconds;
  const drawnTime = useCallback(
    () => (playback ? playback.clock.songTime() : 0) - offsetSeconds(),
    [playback, offsetSeconds],
  );
  // The Line selection (Go selects a Line too) and the pinned Line.
  const [selection, setSelection] = useState<LineSelection | null>(null);
  const [pin, setPin] = useState<LineIndex | null>(null);
  const [fitOutcome, setFitOutcome] = useState<FitOutcome | null>(null);

  const track = load.state === "ready" ? load.track : null;
  const matcher = useMemo(() => (track ? createMatcher(track) : null), [track]);
  const songShare = useMemo(
    () =>
      matcher ? matcher.share(fitNotesOf(timing.song), timing.grid) : null,
    [matcher, timing],
  );
  const fileShare = useMemo(
    () =>
      matcher
        ? matcher.share(fitNotesOf(fileTiming.song), fileTiming.grid)
        : null,
    [matcher, fileTiming],
  );
  const duration = useMemo(
    () => songDuration(detail, timing, track?.pitch.length),
    [detail, timing, track],
  );

  const runFit = ({ tempo }: { tempo: boolean }) => {
    if (!matcher) return;
    const fit = autoFit(model, matcher, { tempo });
    if (fit.kind === "fitted") apply(() => fit.edit);
    setFitOutcome({
      description:
        fit.kind === "fitted" ? fit.description : { kind: "alreadyBest" },
      suggestions: fit.suggestions,
    });
  };
  /** Moves the playhead to drawn time `at` (the Song time heard there). */
  const seekTo = (at: number) => {
    playback?.seek(clampTime(at, duration) + avOffset.seconds());
    paintNow.current();
  };
  const play = () => {
    avOffset.start();
    void playback?.play();
  };
  const togglePlay = () => {
    avOffset.start();
    void playback?.togglePlay();
  };
  const toggleLoop = () => {
    if (!playback) return;
    if (playback.state().loop) {
      playback.setLoop(null);
      return;
    }
    playback.setLoop(
      loopRange(timing.song, timing.grid, selection, drawnTime()),
    );
    play();
  };
  const follow = () => {
    setFollowing(true);
    setView((v) => followedView(v, drawnTime(), detailWidth, true));
  };
  usePlaybackKeys({
    togglePlay,
    follow,
    speed: (rate) => playback?.setRate(rate),
    loop: toggleLoop,
  });
  useGestureKeys({
    nudge: (direction, shift) => {
      apply((m) =>
        selection
          ? nudgeLines(m, selection, { direction, shift })
          : nudgeSong(m, { direction, shift }),
      );
    },
    tempo: (direction, shift) => {
      const playheadSeconds = drawnTime();
      apply((m) =>
        tempoAroundPlayhead(m, { direction, shift, playheadSeconds }),
      );
    },
    clear: () => {
      setSelection(clearSelection());
    },
  });
  const openAvSync = () => {
    playback?.pause();
    avOffset.start();
    setCheckingAvSync(true);
  };

  const goToLine = (s: LineSuggestion) => {
    const first = timing.song.voices[s.voice]?.lines[s.line]?.notes[0];
    if (!first) return;
    const at = clampTime(
      noteTimes(timing.grid, first).start - GO_LEAD_SECONDS,
      duration,
    );
    seekTo(at);
    setView((v) => ({ ...v, start: at - SEEK_LEAD_SECONDS }));
    setSelection(selectLine(s));
  };
  const applySuggestion = (s: LineSuggestion) => {
    apply((m) => shiftLines(m, selectLine(s), s.beats));
    setFitOutcome((o) =>
      o
        ? {
            ...o,
            suggestions: o.suggestions.filter(
              (other) => other.voice !== s.voice || other.line !== s.line,
            ),
          }
        : o,
    );
  };

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
      setFollowing(false);
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

  // Dragging on the ruler seeks; below it, the drag gestures.
  const seeking = useRef(false);
  const dragging = useRef<DragState | null>(null);
  const pointerAt = (event: { clientX: number; clientY: number }) => {
    const rect = detailRef.current?.getBoundingClientRect();
    return {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    };
  };
  const hitAt = (x: number, y: number): DetailHit =>
    hitDetail(
      {
        song: timing.song,
        grid: timing.grid,
        track: null,
        matcher: null,
        playhead: 0,
        view,
        width: detailWidth,
        height: DETAIL_HEIGHT,
        selection,
        pin,
      },
      x,
      y,
    );
  const onDetailDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const { x, y } = pointerAt(event);
    const hit = hitAt(x, y);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (hit.kind === "ruler") {
      seeking.current = true;
      seekTo(timeAtX(view, x));
      return;
    }
    let drag: Drag;
    if (hit.kind === "handle" && selection) {
      drag = { kind: "stretch", selection };
    } else if (hit.kind === "note" && event.altKey) {
      const note = { voice: hit.voice, line: hit.line, note: hit.note };
      drag = { kind: hit.edge ? "noteEnd" : "note", note };
    } else if (hit.kind === "note" || hit.kind === "line") {
      const at = { voice: hit.voice, line: hit.line };
      const next = event.shiftKey
        ? extendSelection(selection, at)
        : selection && inSelection(selection, at)
          ? selection
          : selectLine(at);
      setSelection(next);
      drag = { kind: "lines", selection: next };
    } else {
      setSelection(clearSelection());
      drag = { kind: "song", grabSeconds: timeAtX(view, x), pin };
    }
    dragging.current = {
      drag,
      base: model,
      x,
      pixelsPerSecond: view.pixelsPerSecond,
      moved: false,
      result: null,
    };
  };
  const onDetailMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const { x, y } = pointerAt(event);
    if (seeking.current) {
      seekTo(timeAtX(view, x));
      return;
    }
    const d = dragging.current;
    if (!d) {
      event.currentTarget.style.cursor = cursorFor(hitAt(x, y), event.altKey);
      return;
    }
    const dx = x - d.x;
    if (!d.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    if (!d.moved) setFollowing(false);
    d.moved = true;
    d.result = dragTo(d.base, d.drag, dx / d.pixelsPerSecond);
    setDragPreview(d.result);
  };
  /** Releasing commits the drag's edit; a cancelled pointer drops it. */
  const endDrag = (commitIt: boolean) => {
    seeking.current = false;
    const edit = dragging.current?.result?.edit;
    dragging.current = null;
    setDragPreview(null);
    if (edit && commitIt) apply(() => edit);
  };
  const onDetailDoubleClick = (event: { clientX: number; clientY: number }) => {
    const { x, y } = pointerAt(event);
    const hit = hitAt(x, y);
    if (hit.kind !== "note" && hit.kind !== "line") return;
    const at = { voice: hit.voice, line: hit.line };
    setPin((p) => (p?.voice === at.voice && p.line === at.line ? null : at));
    setSelection(clearSelection());
  };

  const onOverviewDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const at = overviewTimeAt(event.clientX - rect.left, rect.width, duration);
    seekTo(at);
    setView((v) => ({ ...v, start: at - SEEK_LEAD_SECONDS }));
  };

  // Paint both canvases whenever what they show changes, and on every
  // animation frame where the drawn playhead moved (`paintNow`).
  const playheadText = useRef<HTMLParagraphElement>(null);
  const paint = (playhead: number) => {
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
          selection,
          pin,
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
    // Read by Vitest and Playwright; set here, as it changes every frame.
    if (detailCanvas) detailCanvas.dataset.playhead = String(round6(playhead));
    if (playheadText.current)
      playheadText.current.textContent = t("timing.view.playhead", {
        time: clockText(playhead),
      });
  };
  const lastPainted = useRef<number | null>(null);
  const paintNow = useRef(() => {});
  paintNow.current = () => {
    const at = drawnTime();
    lastPainted.current = at;
    paint(at);
  };
  useEffect(() => {
    paintNow.current();
  }, [
    timing,
    track,
    matcher,
    view,
    duration,
    detailWidth,
    overviewWidth,
    drawnTime,
    avOffset.ms,
    selection,
    pin,
  ]);
  // While it plays: repaint as the playhead moves, keeping it in sight.
  const followState = useRef({ following, playing: playState.playing });
  followState.current = { following, playing: playState.playing };
  useEffect(() => {
    let handle = requestAnimationFrame(function onFrame() {
      const at = drawnTime();
      if (at !== lastPainted.current) paintNow.current();
      const { following: keep, playing } = followState.current;
      if (keep && playing)
        setView((v) => followedView(v, at, detailWidth, false));
      handle = requestAnimationFrame(onFrame);
    });
    return () => {
      cancelAnimationFrame(handle);
    };
  }, [drawnTime, detailWidth]);

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
        <div className="relative">
          <canvas
            ref={detailRef}
            role="img"
            aria-label={t("timing.view.detail")}
            data-pitch-track={
              load.state === "listening" ? "pending" : load.state
            }
            data-view-start={String(round6(view.start))}
            data-pixels-per-second={String(round6(view.pixelsPerSecond))}
            data-playing={String(playState.playing)}
            data-rate={String(playState.rate)}
            data-following={String(following)}
            data-loop={
              playState.loop
                ? `${String(round6(playState.loop.start))}-${String(round6(playState.loop.end))}`
                : undefined
            }
            data-selection={
              selection
                ? `${String(selection.voice)}:${String(selection.first)}-${String(selection.last)}`
                : undefined
            }
            data-pin={
              pin ? `${String(pin.voice)}:${String(pin.line)}` : undefined
            }
            onPointerDown={onDetailDown}
            onPointerMove={onDetailMove}
            onPointerUp={() => {
              endDrag(true);
            }}
            onPointerCancel={() => {
              endDrag(false);
            }}
            onDoubleClick={onDetailDoubleClick}
            className={`${canvasClass} cursor-grab`}
            style={{ height: DETAIL_HEIGHT }}
          />
          {dragPreview?.hint && (
            <p className="pointer-events-none absolute top-8 left-1/2 -translate-x-1/2 rounded-full bg-ink px-4 py-1 text-base font-semibold whitespace-nowrap text-white tabular-nums">
              {dragPreview.hint}
            </p>
          )}
        </div>
        <p className="text-sm text-ink-2">
          {t("timing.view.help")}
          {pin && (
            <strong className="ml-2 text-purple">
              {t("timing.drag.pinned", { line: pin.line + 1 })}
            </strong>
          )}
        </p>
        <p className="text-sm text-ink-2">{t("timing.drag.help")}</p>
        <p className="text-sm text-ink-2">{t("timing.drag.keys")}</p>
        <SongMedia
          plan={plan}
          setElement={setElement}
          setFollowVideo={setFollowVideo}
        />
      </div>
      <aside className="flex w-full shrink-0 flex-col gap-5 rounded-[22px] bg-white p-5 shadow-ledge lg:w-96">
        <PlaybackPanel
          ready={element !== null}
          state={playState}
          clicks={clicks}
          hum={hum}
          onTogglePlay={togglePlay}
          onSpeed={(rate) => playback?.setRate(rate)}
          onClicks={setClicks}
          onHum={setHum}
          onLoop={toggleLoop}
          onCheckAvSync={openAvSync}
        />
        <p ref={playheadText} className="text-lg tabular-nums" />
        <div className="grid grid-cols-2 gap-3">
          <TypedValue
            label={t("timing.panel.gap")}
            value={timing.gapMs}
            fileValue={fileTiming.gapMs}
            onCommit={(gapMs) => {
              apply((m) => typeGap(m, gapMs));
            }}
          />
          <TypedValue
            label={t("timing.panel.bpm")}
            value={timing.bpm}
            fileValue={fileTiming.bpm}
            onCommit={(bpm) => {
              apply((m) => typeBpm(m, bpm));
            }}
          />
          {detail.media.video?.kind === "file" && (
            // Only where the audio and video are separate files.
            <TypedValue
              label={t("timing.panel.videoGap")}
              value={timing.videoGapSeconds ?? 0}
              fileValue={fileTiming.videoGapSeconds ?? 0}
              onCommit={(seconds) => {
                apply((m) => typeVideoGap(m, seconds));
              }}
            />
          )}
        </div>
        <ShareMeter
          share={songShare}
          fileShare={fileShare}
          pending={load.state !== "ready"}
        />
        <AutoFitPanel
          ready={matcher !== null}
          playing={playing}
          outcome={fitOutcome}
          song={timing.song}
          onFit={runFit}
          onGo={goToLine}
          onApply={applySuggestion}
        />
        <EditList
          entries={editList(model)}
          canUndo={model.applied.length > 0}
          canRedo={model.undone.length > 0}
          onUndo={() => {
            setModel(undo);
          }}
          onRedo={() => {
            setModel(redo);
          }}
          onBackToTheFile={() => {
            setModel(backToTheFile);
          }}
        />
        <SaveSection
          song={detail.id}
          operations={operations}
          playing={playing}
          openedAtMs={openedAtMs}
          onSaved={() => {
            // The saved file is the new base, and the undo history starts
            // again. Timing operations change lines in place, so the saved
            // file parses to the loaded Song with the operations applied;
            // the `library` notice refreshes the Song's detail as well.
            setModel((m) =>
              openTimingModel(applyOperations(m.song, operationsOf(m))),
            );
            void queryClient.invalidateQueries(songQuery(detail.id));
          }}
        />
      </aside>
      {checkingAvSync && (
        <EditorAvSync
          offset={avOffset}
          onDone={() => {
            setCheckingAvSync(false);
          }}
        />
      )}
    </div>
  );
}

/** The editor's playback over its media element(s), made once they mount. */
function useEditorPlayback(detail: SongDetail) {
  const plan = useMemo(() => playbackPlan(detail), [detail]);
  const [element, setElement] = useState<HTMLMediaElement | null>(null);
  const [followVideo, setFollowVideo] = useState<HTMLVideoElement | null>(null);
  const [playState, setPlayState] = useState<EditorPlaybackState>({
    playing: false,
    rate: 1,
    loop: null,
  });
  const needsVideo = plan.follow !== null;
  // Made once the elements mount, like the Stage's playback check; the
  // effect lets go of each one made.
  const playback = useMemo<EditorPlayback | null>(
    () =>
      element && (!needsVideo || followVideo)
        ? createEditorPlayback({
            plan,
            element,
            video: followVideo,
            audio: stageAudio(),
            onChange: setPlayState,
          })
        : null,
    [plan, element, followVideo, needsVideo],
  );
  useEffect(
    () => () => {
      playback?.dispose();
    },
    [playback],
  );
  return { playback, playState, element, setElement, setFollowVideo, plan };
}

/**
 * This browser's A/V offset at its default output, keyed like the Stage's.
 * The output is read from the first Play or Check A/V sync on, since reading
 * its label may ask for the microphone; until then the offset is 0.
 */
function useEditorAvOffset(): BrowserAvOffset & { start: () => void } {
  const [browser] = useState(() => stageBrowserId(window.localStorage));
  const [watcher] = useState(() =>
    createStageOutputWatcher(
      "mediaDevices" in navigator ? navigator.mediaDevices : NO_DEVICES,
    ),
  );
  useEffect(
    () => () => {
      watcher.stop();
    },
    [watcher],
  );
  const output = useSyncExternalStore(watcher.subscribe, watcher.current);
  const offset = useAvOffset(browser, output);
  const start = useCallback(() => {
    watcher.start();
  }, [watcher]);
  return { ...offset, start };
}

/**
 * Space or P play and pause, F follows the playhead again, 1/2/3 set the
 * speed, L loops a Line. Inside a text field the keys stay the field's own.
 */
function usePlaybackKeys(actions: {
  togglePlay: () => void;
  follow: () => void;
  speed: (rate: number) => void;
  loop: () => void;
}) {
  const latest = useRef(actions);
  useEffect(() => {
    latest.current = actions;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
      )
        return;
      const key = event.key.toLowerCase();
      const act = latest.current;
      if (key === " " || key === "p") {
        // Space on a focused button presses that button instead.
        if (key === " " && target instanceof HTMLButtonElement) return;
        event.preventDefault();
        act.togglePlay();
      } else if (key === "f") act.follow();
      else if (key === "l") act.loop();
      else if (key === "1" || key === "2" || key === "3") {
        const rate = SPEEDS[Number(key) - 1];
        if (rate !== undefined) act.speed(rate);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}

/**
 * `,`/`.` nudge (with Shift, or as `<`/`>`, the big step), `[`/`]` change the
 * tempo around the playhead (Shift or `{`/`}`: the big step), Esc clears the
 * selection. Inside a text field the keys stay the field's own.
 */
function useGestureKeys(actions: {
  nudge: (direction: -1 | 1, shift: boolean) => void;
  tempo: (direction: -1 | 1, shift: boolean) => void;
  clear: () => void;
}) {
  const latest = useRef(actions);
  useEffect(() => {
    latest.current = actions;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
      )
        return;
      const act = latest.current;
      const big = event.shiftKey;
      switch (event.key) {
        case ",":
        case "<":
          act.nudge(-1, big || event.key === "<");
          break;
        case ".":
        case ">":
          act.nudge(1, big || event.key === ">");
          break;
        case "[":
        case "{":
          act.tempo(-1, big || event.key === "{");
          break;
        case "]":
        case "}":
          act.tempo(1, big || event.key === "}");
          break;
        case "Escape":
          act.clear();
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}

/** The detail view's cursor over what the pointer is on (Alt: the Note tools). */
function cursorFor(hit: DetailHit, alt: boolean): string {
  if (hit.kind === "ruler") return "pointer";
  if (hit.kind === "handle") return "ew-resize";
  if (hit.kind === "note" && alt) return hit.edge ? "ew-resize" : "move";
  return "grab";
}

/**
 * The view following the playhead at drawn time `at`: when it leaves the
 * visible span (or `always`), the view turns the page so it sits near the
 * left edge.
 */
function followedView(
  v: EditorView,
  at: number,
  width: number,
  always: boolean,
): EditorView {
  if (width <= 0) return v;
  const span = width / v.pixelsPerSecond;
  const inSight = at >= v.start && at <= v.start + span * FOLLOW_RIGHT;
  if (inSight && !always) return v;
  return { ...v, start: at - span * FOLLOW_LEFT };
}

/** The media elements: the audio (or the one video file), and a following video. */
function SongMedia({
  plan,
  setElement,
  setFollowVideo,
}: {
  plan: ReturnType<typeof playbackPlan>;
  setElement: (element: HTMLMediaElement | null) => void;
  setFollowVideo: (element: HTMLVideoElement | null) => void;
}) {
  const box = "w-80 max-w-full rounded-[18px] bg-ink ring-3 ring-ink";
  return (
    <div className="flex flex-wrap gap-3">
      {plan.element === "video" ? (
        <video
          ref={setElement}
          src={plan.url}
          preload="auto"
          playsInline
          className={box}
        >
          <track kind="captions" />
        </video>
      ) : (
        <audio ref={setElement} src={plan.url} preload="auto">
          <track kind="captions" />
        </audio>
      )}
      {plan.follow && (
        <video
          ref={setFollowVideo}
          src={plan.follow.url}
          preload="auto"
          muted
          playsInline
          className={box}
        />
      )}
    </div>
  );
}

/** Check A/V sync for this browser and output: the Stage's test pattern. */
function EditorAvSync({
  offset,
  onDone,
}: {
  offset: BrowserAvOffset;
  onDone: () => void;
}) {
  const { ms, step } = useAvSyncValue(offset);
  const landings = useClickTrack(stageAudio());
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onDone();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-veil p-6"
    >
      <Modal className="w-full max-w-5xl rounded-card bg-cream text-ink shadow-ledge-lg">
        <AriaDialog className="flex flex-col gap-6 p-8 font-sans outline-none">
          <Heading slot="title" className="text-3xl font-bold">
            {t("timing.play.avSync")}
          </Heading>
          <AvSyncPanel
            ms={ms}
            landings={landings}
            onStep={step}
            onDone={onDone}
            hint={t("timing.play.avSyncHint")}
          />
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

/**
 * Undo with Ctrl/Cmd+Z, redo with Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y. Inside a
 * text field the keys stay the field's own.
 */
function useUndoKeys(
  setModel: (update: (m: TimingModel) => TimingModel) => void,
) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.target instanceof HTMLInputElement) return;
      const key = event.key.toLowerCase();
      const step =
        key === "z"
          ? event.shiftKey
            ? redo
            : undo
          : key === "y"
            ? redo
            : null;
      if (!step) return;
      event.preventDefault();
      setModel(step);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [setModel]);
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
