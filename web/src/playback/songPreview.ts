/**
 * Song-browser previews (#53, "Drawing against the clock"; #162): a short
 * preview of the selected Song from its preview point, so people can
 * recognise it.
 */

import type { SongDetail } from "../generated/SongDetail";
import type { SongHeaders } from "../generated/SongHeaders";
import type { SongId } from "../generated/SongId";
import { dbToGain, songGainDb } from "./gain";

/**
 * Where a preview starts, seconds of audio: `#PREVIEWSTART`, or a third of
 * the Song's length when the file has none (or names a point outside the
 * Song). With neither known, the beginning.
 */
export function previewStartSeconds(
  headers: Pick<SongHeaders, "previewStartSeconds">,
  lengthSeconds: number | null,
): number {
  const point = headers.previewStartSeconds;
  const length =
    lengthSeconds !== null &&
    Number.isFinite(lengthSeconds) &&
    lengthSeconds > 0
      ? lengthSeconds
      : null;
  if (
    point !== null &&
    Number.isFinite(point) &&
    point >= 0 &&
    (length === null || point < length)
  ) {
    return point;
  }
  return length === null ? 0 : length / 3;
}

/** How a preview fades, seconds. */
export const PREVIEW = {
  fadeInSeconds: 1,
  fadeOutSeconds: 0.4,
} as const;

/** What a preview plays. */
export interface PreviewSong {
  id: SongId;
  /** The Song's audio (or its one file serving as audio and video). */
  url: string;
  /** Where the preview starts, seconds of audio (`previewStartSeconds`). */
  startSeconds: number;
  /** The Song's measured loudness (`null`: unmeasured, unity gain). */
  loudnessLufs: number | null;
}

/**
 * The preview of a Song, or `null` when it has nothing the Stage can play
 * yet (its audio is still being converted).
 */
export function songPreview(
  detail: Pick<
    SongDetail,
    "id" | "lengthSeconds" | "media" | "loudnessLufs"
  > & {
    song: { headers: Pick<SongHeaders, "previewStartSeconds"> };
  },
): PreviewSong | null {
  if (!detail.media.audio.native) return null;
  return {
    id: detail.id,
    url: detail.media.audio.url,
    startSeconds: previewStartSeconds(
      detail.song.headers,
      detail.lengthSeconds,
    ),
    loudnessLufs: detail.loudnessLufs,
  };
}

export interface SongPreviewer {
  /**
   * Previews `song`, or stops when `null`. A preview already playing fades
   * out and stops before the next one starts, so only one ever plays.
   * Previewing the Song already previewing changes nothing.
   */
  play(song: PreviewSong | null): void;
  /**
   * Fades the preview out and stops it. Calibrate mics (#170) and Check
   * A/V sync (#163) call this while they run.
   */
  stop(): void;
  /** The Song previewing or about to, `null` when none. */
  readonly current: SongId | null;
  /** Stops at once, without a fade, and lets go of the audio graph. */
  dispose(): void;
}

export interface SongPreviewerOptions {
  context: AudioContext;
  /**
   * Where the preview's sound goes: the Stage chain's `input`, after the
   * Song gain and before the OpenStar volume.
   */
  output: AudioNode;
  /** Makes the preview's own media element, never the Song's. */
  createElement?: () => HTMLMediaElement;
  /**
   * The gain a preview fades in to, read at each start (1 by default): the
   * Stage options' preview volume.
   */
  level?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/**
 * The song browser's preview player. It has its own media element and its
 * own gains (the Song's loudness, then the fade) into the Stage chain, so the
 * room's OpenStar volume applies. It never feeds the Song clock or the
 * scorer: nothing here reads or reports the element's position.
 */
export function createSongPreviewer({
  context,
  output,
  createElement = () => document.createElement("audio"),
  level = () => 1,
  setTimer = (run, ms) => setTimeout(run, ms),
  clearTimer = (timer) => {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
}: SongPreviewerOptions): SongPreviewer {
  // Made on first use, so a browser that never previews makes no element.
  let graph: {
    element: HTMLMediaElement;
    loudness: GainNode;
    fade: GainNode;
    source: MediaElementAudioSourceNode;
  } | null = null;
  /** The Song on the element, playing or fading out. */
  let playing: PreviewSong | null = null;
  /** The Song to start once the fade-out ends. */
  let next: PreviewSong | null = null;
  let fadingOut: unknown = null;
  /** Whether the element has started playing the current Song (and fading in). */
  let audible = false;
  /** Bumped on every start, so a stale `playing` event does nothing. */
  let generation = 0;

  function get() {
    if (graph === null) {
      const element = createElement();
      element.preload = "auto";
      const source = context.createMediaElementSource(element);
      const loudness = context.createGain();
      const fade = context.createGain();
      fade.gain.value = 0;
      source.connect(loudness);
      loudness.connect(fade);
      fade.connect(output);
      graph = { element, loudness, fade, source };
    }
    return graph;
  }

  function rampTo(param: AudioParam, value: number, seconds: number) {
    const now = context.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + seconds);
  }

  function start(song: PreviewSong) {
    const { element, loudness, fade } = get();
    generation += 1;
    const mine = generation;
    playing = song;
    loudness.gain.value = dbToGain(songGainDb(song.loudnessLufs));
    fade.gain.cancelScheduledValues(context.currentTime);
    fade.gain.value = 0;
    element.src = song.url;
    const seek = () => {
      if (mine === generation) element.currentTime = song.startSeconds;
    };
    if (element.readyState >= 1) seek();
    else element.addEventListener("loadedmetadata", seek, { once: true });
    element.addEventListener(
      "playing",
      () => {
        if (mine !== generation) return;
        audible = true;
        const now = context.currentTime;
        fade.gain.cancelScheduledValues(now);
        fade.gain.setValueAtTime(0, now);
        fade.gain.linearRampToValueAtTime(level(), now + PREVIEW.fadeInSeconds);
      },
      { once: true },
    );
    if (context.state === "suspended") void context.resume().catch(ignore);
    void element.play().catch(ignore);
  }

  /** Silences and lets go of the element's file at once. */
  function halt() {
    generation += 1;
    playing = null;
    audible = false;
    if (graph === null) return;
    graph.fade.gain.cancelScheduledValues(context.currentTime);
    graph.fade.gain.value = 0;
    graph.element.pause();
    graph.element.removeAttribute("src");
    graph.element.load();
  }

  function fadeOutThen(then: PreviewSong | null) {
    next = then;
    if (fadingOut !== null) return;
    if (!audible || graph === null) {
      // Nothing heard yet: no fade-out to wait for.
      next = null;
      halt();
      if (then !== null) start(then);
      return;
    }
    rampTo(graph.fade.gain, 0, PREVIEW.fadeOutSeconds);
    fadingOut = setTimer(() => {
      fadingOut = null;
      const after = next;
      next = null;
      halt();
      if (after !== null) start(after);
    }, PREVIEW.fadeOutSeconds * 1000);
  }

  return {
    play(song) {
      const target = fadingOut !== null ? next : playing;
      if (song?.id === target?.id && song?.url === target?.url) return;
      fadeOutThen(song);
    },
    stop() {
      fadeOutThen(null);
    },
    get current() {
      return (fadingOut !== null ? next : playing)?.id ?? null;
    },
    dispose() {
      if (fadingOut !== null) clearTimer(fadingOut);
      fadingOut = null;
      next = null;
      halt();
      if (graph !== null) {
        graph.source.disconnect();
        graph.fade.disconnect();
      }
    },
  };
}

function ignore() {
  // A preview that cannot play (no user gesture yet, a load error) is silent.
}
