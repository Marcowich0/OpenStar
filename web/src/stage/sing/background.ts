/**
 * The sing screen's background layer (#263): what is behind the lanes. The
 * Song video when the Stage can play it and Song video is on; else the
 * Song's background image; else a slow animated gradient of large soft blobs
 * in the Line-up's Party colours, which the painter draws (`frame()`'s
 * `background` entry). The video and the image are DOM (`SingBackdrop`).
 */

import type { SongMedia } from "../../generated/SongMedia";
import type { StageOptions } from "../../stageOptions/stageOptions";
import type { PaletteKey, TokenName } from "../../theme/tokens";
import type { SingLane } from "./frame";

export type BackgroundKind = "video" | "image" | "blobs";

/** The background a Song's sing screen shows, chosen once at Start. */
export interface SingBackground {
  kind: BackgroundKind;
  /** The blobs do not move (Effects off, or reduced motion). */
  still: boolean;
}

/** The video's URL when the Stage can play it as it is; `null`: none to show. */
export function playableVideo(media: SongMedia): string | null {
  const video = media.video;
  if (video === null) return null;
  const file = video.kind === "inAudio" ? media.audio : video.file;
  return file.native ? file.url : null;
}

/**
 * The background for `media`: the video when it plays and `songVideo` is on,
 * else the background image, else the blobs. The cover is not used: without
 * a video or a background image the blobs show instead of the enlarged cover.
 */
export function backgroundKind(
  media: SongMedia,
  songVideo: boolean,
): BackgroundKind {
  if (songVideo && playableVideo(media) !== null) return "video";
  return media.background !== null ? "image" : "blobs";
}

/**
 * Effects set to **off**: the one place the sing screen asks. Today
 * `effects` is a switch; #268 makes it `"off" | "calm" | "full"` (a stored
 * `false` reads as `"off"`), and this becomes `options.effects === "off"`.
 */
export function effectsOff(options: Pick<StageOptions, "effects">): boolean {
  return !options.effects;
}

/**
 * The background a Song's sing screen shows, chosen at Start from its media
 * and the Stage options: still with Effects off or reduced motion.
 */
export function singBackground(
  media: SongMedia,
  options: Pick<StageOptions, "effects" | "songVideo">,
  reducedMotion: boolean,
): SingBackground {
  return {
    kind: backgroundKind(media, options.songVideo),
    still: effectsOff(options) || reducedMotion,
  };
}

/** A blob's colour: a Player's Party colour, or slate for a shared Voice. */
export type BlobColour = PaletteKey | "--color-slate";

/**
 * One soft blob: a radial gradient from `colour` at `alpha` in its centre
 * to clear at `radius`, in the reference frame.
 */
export interface BlobStyle {
  x: number;
  y: number;
  radius: number;
  colour: BlobColour;
  alpha: number;
}

/**
 * The background layer, first in the draw list. The video and the image
 * are DOM, so their entries carry nothing to paint; the blobs are painted
 * on `base`, which fills the whole screen.
 */
export type BackgroundEntry =
  | { type: "background"; kind: "video" | "image" }
  | {
      type: "background";
      kind: "blobs";
      base: TokenName;
      blobs: readonly BlobStyle[];
    };

const VIDEO: BackgroundEntry = { type: "background", kind: "video" };
const IMAGE: BackgroundEntry = { type: "background", kind: "image" };

/** At least this many blobs, so a 1-Player screen is still filled. */
const MIN_BLOBS = 3;
const BLOB_RADIUS = 520;
const BLOB_ALPHA = 0.7;
/** How far a blob drifts from its anchor, px. */
const DRIFT_X = 180;
const DRIFT_Y = 120;
/** Where the blobs sit, spread over the 1920 × 1080 frame, in blob order. */
const ANCHORS: readonly (readonly [number, number])[] = [
  [320, 260],
  [1620, 300],
  [960, 860],
  [1520, 920],
  [420, 900],
  [1000, 200],
  [1820, 680],
  [130, 580],
  [1300, 520],
  [640, 540],
];

/**
 * The blobs' colours: each lane's Party colour in lane order, then slate
 * once for each Voice that several Players share, then the Line-up's
 * colours again until there are at least `MIN_BLOBS`.
 */
function blobColours(lanes: readonly SingLane[]): BlobColour[] {
  const colours: BlobColour[] = lanes.map((lane) => lane.colour);
  const players = new Map<number, number>();
  for (const lane of lanes) {
    players.set(lane.voice, (players.get(lane.voice) ?? 0) + 1);
  }
  for (const count of players.values()) {
    if (count > 1) colours.push("--color-slate");
  }
  if (colours.length === 0) colours.push("--color-slate");
  for (let i = 0; colours.length < MIN_BLOBS; i++) {
    colours.push(colours[i] ?? "--color-slate");
  }
  return colours;
}

/**
 * Blob `i` at time `t`: it drifts round its anchor on slow, unequal
 * periods (20–40 s), so the gradient never visibly repeats.
 */
function blob(i: number, t: number, colour: BlobColour): BlobStyle {
  const anchor = ANCHORS[i % ANCHORS.length] ?? [960, 540];
  // A blob past the anchors' end sits beside the one it shares an anchor with.
  const lap = Math.floor(i / ANCHORS.length);
  const phase = i * 2.4;
  const tau = 2 * Math.PI;
  return {
    x:
      anchor[0] +
      lap * 260 +
      DRIFT_X * Math.sin((tau * t) / (23 + 6 * (i % 4)) + phase),
    y:
      anchor[1] -
      lap * 180 +
      DRIFT_Y * Math.cos((tau * t) / (29 + 5 * (i % 3)) + phase),
    radius: BLOB_RADIUS * (1 + 0.08 * Math.sin((tau * t) / 37 + phase)),
    colour,
    alpha: BLOB_ALPHA,
  };
}

/** The background entry of the frame at Song time `songTime`. */
export function backgroundEntry(
  background: SingBackground,
  lanes: readonly SingLane[],
  songTime: number,
): BackgroundEntry {
  if (background.kind === "video") return VIDEO;
  if (background.kind === "image") return IMAGE;
  const t = background.still ? 0 : songTime;
  return {
    type: "background",
    kind: "blobs",
    base: "--color-cream",
    blobs: blobColours(lanes).map((colour, i) => blob(i, t, colour)),
  };
}
