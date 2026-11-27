// The Stage's UI sounds (spec #242, "Sound engine"): every sound is
// synthesized with Web Audio (oscillators, envelopes and filtered noise), so
// there are no audio files and nothing to license. They play on the Stage's
// one AudioContext into its gain chain's input (`stageAudio.ts`), so they
// take the Stage output and the OpenStar volume like the Song does, at the
// UI sounds level, and 6 dB lower while a Song plays.
//
// One named function per sound (`sounds.focus()`, `sounds.select()`, …),
// made from the recipe table below: a new sound is one more entry in it.
// Nothing plays before the first user gesture, because browsers start an
// AudioContext only from one; a sound asked for before it is dropped, not
// held back, so it never plays late.
//
// Stage only: a Phone may be a Mic, and any sound it made would reach its
// own pitch detection. Nothing outside `src/stage/` imports this module.

import { dbToGain, volumeGain } from "../../playback/gain";
import { stageOptions } from "../../stageOptions/stageOptions";

/**
 * The UI sounds level (0–100 %) until Options › Sound has it (#270, "UI
 * sounds" in Audio mix). That ticket replaces this reader with the option.
 */
export const UI_SOUNDS_LEVEL = 60;
export function uiSoundsLevel(): number {
  return UI_SOUNDS_LEVEL;
}

/**
 * Whether Effects are off, read for each sound. Until #268 makes Effects
 * off, calm or full, "off" is the Stage options' `effects: false`; that
 * ticket replaces this reader with its "off".
 */
export function effectsOff(): boolean {
  return !stageOptions().current().effects;
}

/** How much lower UI sounds play while a Song plays, dB. */
export const DUCK_DB = -6;

/** One layer of a sound, `at` seconds after it starts. */
export type Voice =
  | {
      /** An oscillator, its pitch sliding from `hz` to `toHz`. */
      wave: OscillatorType;
      hz: number;
      toHz?: number;
      at?: number;
      attack?: number;
      decay: number;
      /** Peak gain of the envelope, before the level. */
      peak: number;
    }
  | {
      /** White noise through one filter at `hz`. */
      noise: BiquadFilterType;
      hz: number;
      at?: number;
      attack?: number;
      decay: number;
      peak: number;
    };

/** Default attack, s: short enough to be crisp, long enough not to click. */
const ATTACK = 0.004;

/** The menu sounds (#261). */
const MENU = {
  /** The focus ring moves: a soft high tick. */
  focus: [{ wave: "triangle", hz: 1500, toHz: 1200, decay: 0.045, peak: 0.22 }],
  /** Enter or a click picks something: a bubbly pop. */
  select: [
    { wave: "sine", hz: 480, toHz: 1100, decay: 0.09, peak: 0.5 },
    { noise: "bandpass", hz: 2600, decay: 0.025, peak: 0.12 },
  ],
  /** Esc, or an overlay closes: the pop falling. */
  back: [{ wave: "sine", hz: 900, toHz: 380, decay: 0.11, peak: 0.42 }],
  /** A refused action, or a greyed button shaking: a low double bonk. */
  refuse: [
    { wave: "square", hz: 196, toHz: 175, decay: 0.07, peak: 0.12 },
    { wave: "square", hz: 147, toHz: 131, at: 0.09, decay: 0.12, peak: 0.12 },
  ],
  /** Hold-to-confirm, while held. */
  holdTick: [{ wave: "sine", hz: 880, decay: 0.03, peak: 0.2 }],
  /** Hold-to-confirm done: three notes up. */
  holdDone: [
    { wave: "triangle", hz: 660, decay: 0.08, peak: 0.32 },
    { wave: "triangle", hz: 880, at: 0.055, decay: 0.08, peak: 0.32 },
    { wave: "triangle", hz: 1320, at: 0.11, decay: 0.16, peak: 0.32 },
  ],
  /** A toast drops in: a two-note chime. */
  toast: [
    { wave: "sine", hz: 1047, decay: 0.16, peak: 0.26 },
    { wave: "sine", hz: 1319, at: 0.075, decay: 0.22, peak: 0.26 },
  ],
} as const satisfies Record<string, readonly Voice[]>;

/** The game sounds (#262): the sing screen's big moments and the results. */
const GAME = {
  /** Each number of a countdown: a short round blip. */
  countdown: [
    { wave: "triangle", hz: 784, decay: 0.12, peak: 0.36 },
    { wave: "sine", hz: 1568, decay: 0.05, peak: 0.1 },
  ],
  /** The countdown is over and the Song plays: the blip an octave up, longer. */
  go: [
    { wave: "triangle", hz: 1568, toHz: 1661, decay: 0.32, peak: 0.36 },
    { wave: "sine", hz: 784, decay: 0.28, peak: 0.22 },
  ],
  /** A Perfect! Line: a quick sparkling run up with a shimmer. */
  linePerfect: [
    { wave: "triangle", hz: 1047, decay: 0.07, peak: 0.26 },
    { wave: "triangle", hz: 1319, at: 0.045, decay: 0.07, peak: 0.26 },
    { wave: "triangle", hz: 1568, at: 0.09, decay: 0.07, peak: 0.26 },
    { wave: "triangle", hz: 2093, at: 0.135, decay: 0.24, peak: 0.28 },
    { noise: "highpass", hz: 6000, at: 0.135, decay: 0.2, peak: 0.06 },
  ],
  /** A golden Note being hit: a soft high glint (rate-limited by its caller). */
  goldenHit: [{ wave: "sine", hz: 2637, toHz: 3136, decay: 0.06, peak: 0.1 }],
  /** The results bars rise: a slow sweep up, as long as a bar grows. */
  resultsRise: [
    {
      wave: "triangle",
      hz: 220,
      toHz: 880,
      attack: 0.25,
      decay: 0.85,
      peak: 0.16,
    },
    { noise: "bandpass", hz: 1800, attack: 0.3, decay: 0.8, peak: 0.04 },
  ],
  /** The bars land: a short fanfare, three notes up into a major chord. */
  fanfare: [
    { wave: "square", hz: 392, decay: 0.1, peak: 0.1 },
    { wave: "square", hz: 523, at: 0.11, decay: 0.1, peak: 0.1 },
    { wave: "square", hz: 659, at: 0.22, decay: 0.1, peak: 0.1 },
    { wave: "triangle", hz: 784, at: 0.33, decay: 0.7, peak: 0.3 },
    { wave: "triangle", hz: 1047, at: 0.33, decay: 0.7, peak: 0.24 },
    { wave: "triangle", hz: 1319, at: 0.33, decay: 0.7, peak: 0.2 },
  ],
  /** The "New high score!" sticker: a bright run to the top and a ring. */
  highScore: [
    { wave: "triangle", hz: 1319, decay: 0.06, peak: 0.26 },
    { wave: "triangle", hz: 1568, at: 0.05, decay: 0.06, peak: 0.26 },
    { wave: "triangle", hz: 2093, at: 0.1, decay: 0.06, peak: 0.26 },
    { wave: "sine", hz: 2637, at: 0.15, decay: 0.45, peak: 0.24 },
    { noise: "highpass", hz: 7000, at: 0.15, decay: 0.25, peak: 0.05 },
  ],
} as const satisfies Record<string, readonly Voice[]>;

/** Every sound's recipe, by name. */
const SOUNDS: Readonly<
  Record<keyof typeof MENU | keyof typeof GAME, readonly Voice[]>
> = { ...MENU, ...GAME };

export type UiSoundName = keyof typeof SOUNDS;

export const MENU_SOUNDS = Object.keys(MENU) as readonly (keyof typeof MENU)[];

export const GAME_SOUNDS = Object.keys(GAME) as readonly (keyof typeof GAME)[];

/** The sounds Effects off silences (spec #242). */
export const EFFECT_SOUNDS: readonly UiSoundName[] = [
  "linePerfect",
  "goldenHit",
];

/** Every named sound. */
export const UI_SOUND_NAMES = Object.keys(SOUNDS) as readonly UiSoundName[];

export interface UiSoundsOptions {
  /** The Stage's AudioContext; asked for at the first gesture, not before. */
  context: () => AudioContext;
  /** Where the sounds go: the gain chain's input. */
  output: () => AudioNode;
  /** The UI sounds level, 0–100 %, read for each sound. */
  level?: () => number;
  /** Whether Effects are off, read for each sound (`effectsOff` by default). */
  effectsOff?: () => boolean;
}

export type UiSounds = { readonly [Name in UiSoundName]: () => void } & {
  /**
   * A user gesture happened (a key or a press): from now on sounds play,
   * and the context is started if it is not running.
   */
  gesture(): void;
  /** Ducks every UI sound by `DUCK_DB` while a Song plays. */
  setDucked(ducked: boolean): void;
};

/** Seconds of white noise kept for the noise voices; longer than any one. */
const NOISE_SECONDS = 0.5;

interface Made {
  context: AudioContext;
  /** Level × duck, the one gain every sound passes before the output. */
  ui: GainNode;
  noise: AudioBuffer | null;
}

export function createUiSounds({
  context: makeContext,
  output,
  level = uiSoundsLevel,
  effectsOff: isEffectsOff = effectsOff,
}: UiSoundsOptions): UiSounds {
  let gestured = false;
  let ducked = false;
  let made: Made | null = null;

  function get(): Made {
    if (made === null) {
      const context = makeContext();
      const ui = context.createGain();
      ui.connect(output());
      made = { context, ui, noise: null };
    }
    return made;
  }

  function uiGain(): number {
    return volumeGain(level()) * (ducked ? dbToGain(DUCK_DB) : 1);
  }

  function noiseBuffer(audio: Made): AudioBuffer {
    if (audio.noise === null) {
      const { context } = audio;
      const length = Math.round(context.sampleRate * NOISE_SECONDS);
      const buffer = context.createBuffer(1, length, context.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) samples[i] = Math.random() * 2 - 1;
      audio.noise = buffer;
    }
    return audio.noise;
  }

  function playVoice(audio: Made, voice: Voice, start: number) {
    const { context } = audio;
    const attack = voice.attack ?? ATTACK;
    const begin = start + (voice.at ?? 0);
    const end = begin + attack + voice.decay;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, begin);
    envelope.gain.linearRampToValueAtTime(voice.peak, begin + attack);
    envelope.gain.linearRampToValueAtTime(0, end);
    envelope.connect(audio.ui);

    let source: AudioScheduledSourceNode;
    const nodes: AudioNode[] = [envelope];
    if ("wave" in voice) {
      const osc = context.createOscillator();
      osc.type = voice.wave;
      osc.frequency.setValueAtTime(voice.hz, begin);
      if (voice.toHz !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(voice.toHz, end);
      }
      osc.connect(envelope);
      source = osc;
    } else {
      const noise = context.createBufferSource();
      noise.buffer = noiseBuffer(audio);
      const filter = context.createBiquadFilter();
      filter.type = voice.noise;
      filter.frequency.value = voice.hz;
      noise.connect(filter);
      filter.connect(envelope);
      nodes.push(filter);
      source = noise;
    }
    nodes.push(source);
    source.onended = () => {
      for (const node of nodes) node.disconnect();
    };
    source.start(begin);
    source.stop(end + 0.01);
  }

  function play(name: UiSoundName) {
    if (!gestured || !(level() > 0)) return;
    if (EFFECT_SOUNDS.includes(name) && isEffectsOff()) return;
    const audio = get();
    audio.ui.gain.value = uiGain();
    const start = audio.context.currentTime;
    for (const voice of SOUNDS[name]) playVoice(audio, voice, start);
  }

  const named = Object.fromEntries(
    UI_SOUND_NAMES.map((name) => [
      name,
      () => {
        play(name);
      },
    ]),
  ) as { [Name in UiSoundName]: () => void };

  return {
    ...named,
    gesture() {
      gestured = true;
      const { context } = get();
      if (context.state !== "running") {
        context.resume().catch(() => {
          // Not allowed yet: the next gesture tries again.
        });
      }
    },
    setDucked(next) {
      ducked = next;
      if (made !== null) made.ui.gain.value = uiGain();
    },
  };
}
