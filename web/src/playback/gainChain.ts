/**
 * The chain every sound on the Stage takes to the output (#53): media element
 * → Song gain → OpenStar volume → output. Calibration tones, the Check A/V
 * sync click and the Timing editor's clicks and hums connect to `input`,
 * after the Song gain, so they pass through the OpenStar volume like a Song.
 */

import { dbToGain, OPENSTAR_VOLUME, songGainDb, volumeGain } from "./gain";

export interface GainChain {
  readonly context: AudioContext;
  /**
   * The input after the Song gain and before the OpenStar volume, for
   * Calibration tones, the Check A/V sync click and the Timing editor's sounds.
   */
  readonly input: AudioNode;
  /** The OpenStar volume now applied (0–100). */
  readonly volume: number;
  /**
   * Routes `element`'s sound through the Song gain. Once connected, the
   * element's sound reaches the output only through this chain. Returns the
   * disconnect.
   */
  connectMedia(element: HTMLMediaElement): () => void;
  /** Sets the Song gain from the Song's measured loudness (`null`: unmeasured). */
  setSongLoudness(lufs: number | null): void;
  /** Sets the OpenStar volume (0–100); it applies at once. */
  setVolume(volume: number): void;
}

/**
 * A browser gives an element at most one source node, ever, so the node is
 * kept per element and reconnected on the next `connectMedia`.
 */
const sourcesByContext = new WeakMap<
  AudioContext,
  WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>
>();

export function createGainChain(
  context: AudioContext,
  { volume: startVolume = OPENSTAR_VOLUME.default }: { volume?: number } = {},
): GainChain {
  const songGain = context.createGain();
  const input = context.createGain();
  const volumeNode = context.createGain();
  songGain.connect(volumeNode);
  input.connect(volumeNode);
  volumeNode.connect(context.destination);

  let sources = sourcesByContext.get(context);
  if (sources === undefined) {
    sources = new WeakMap();
    sourcesByContext.set(context, sources);
  }
  const contextSources = sources;

  let volume = startVolume;
  volumeNode.gain.value = volumeGain(volume);

  return {
    context,
    input,
    get volume() {
      return volume;
    },
    connectMedia(element) {
      let source = contextSources.get(element);
      if (source === undefined) {
        source = context.createMediaElementSource(element);
        contextSources.set(element, source);
      }
      source.disconnect();
      source.connect(songGain);
      const connected = source;
      return () => {
        connected.disconnect();
      };
    },
    setSongLoudness(lufs) {
      songGain.gain.value = dbToGain(songGainDb(lufs));
    },
    setVolume(next) {
      volume = next;
      volumeNode.gain.value = volumeGain(next);
    },
  };
}
