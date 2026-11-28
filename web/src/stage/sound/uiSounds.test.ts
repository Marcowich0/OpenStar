// The UI sound engine (#261): named sounds synthesized on the Stage's
// AudioContext, into the gain chain's input, at the UI sounds level and
// ducked by 6 dB while a Song plays. No audio is compared: the tests read
// which sources start and where they lead.

import { describe, expect, it, vi } from "vitest";

import { asAudioContext } from "../../playback/fakeAudioContext";
import {
  defaultStageOptions,
  stageOptions,
} from "../../stageOptions/stageOptions";
import {
  fakeSynthContext,
  reaches,
  startedSources,
  type FakeSynthContext,
} from "./fakeSynthContext";
import {
  EFFECT_SOUNDS,
  GAME_SOUNDS,
  MENU_SOUNDS,
  UI_SOUND_NAMES,
  createUiSounds,
  silentSounds,
  type UiSoundName,
} from "./uiSounds";

function setUp(level = () => 60, effectsOff = () => false) {
  const context = fakeSynthContext();
  const output = context.createGain();
  output.connect(context.destination);
  const makeContext = vi.fn(() => asAudioContext(context));
  const sounds = createUiSounds({
    context: makeContext,
    output: () => output as unknown as AudioNode,
    level,
    effectsOff,
  });
  return { context, output, makeContext, sounds };
}

/** The UI gain: the one node every UI sound passes before the output. */
function uiGain(context: FakeSynthContext, output: unknown) {
  const source = startedSources(context)[0];
  if (!source) throw new Error("nothing played");
  let at = source;
  while (at.outputs[0] !== output) {
    const next = at.outputs[0];
    if (!next) throw new Error("does not reach the output");
    at = next;
  }
  return at;
}

describe("the UI sound engine", () => {
  it("plays nothing, and makes no AudioContext, before the first user gesture", () => {
    const { context, makeContext, sounds } = setUp();
    sounds.select();
    expect(makeContext).not.toHaveBeenCalled();
    expect(startedSources(context)).toEqual([]);
  });

  it("starts the context on the first gesture and then plays into the output", () => {
    const { context, output, sounds } = setUp();
    sounds.gesture();
    expect(context.state).toBe("running");
    sounds.select();
    const started = startedSources(context);
    expect(started.length).toBeGreaterThan(0);
    for (const source of started) expect(reaches(source, output)).toBe(true);
  });

  it.each(MENU_SOUNDS)("has a named function %s that plays", (name) => {
    const { context, output, sounds } = setUp();
    sounds.gesture();
    sounds[name satisfies UiSoundName]();
    const started = startedSources(context);
    expect(started.length).toBeGreaterThan(0);
    for (const source of started) expect(reaches(source, output)).toBe(true);
  });

  it("names the seven menu sounds", () => {
    expect([...MENU_SOUNDS].sort()).toEqual(
      [
        "back",
        "focus",
        "holdDone",
        "holdTick",
        "refuse",
        "select",
        "toast",
      ].sort(),
    );
  });

  it("plays at the UI sounds level on the OpenStar volume's curve", () => {
    const { context, output, sounds } = setUp(() => 60);
    sounds.gesture();
    sounds.focus();
    expect(uiGain(context, output).gain.value).toBeCloseTo(0.36, 6);
  });

  it("by default plays at the Stage's UI sounds option, 60 % until it loads, read for each sound", () => {
    const context = fakeSynthContext();
    const output = context.createGain();
    output.connect(context.destination);
    const sounds = createUiSounds({
      context: () => asAudioContext(context),
      output: () => output as unknown as AudioNode,
      effectsOff: () => false,
    });
    sounds.gesture();
    try {
      sounds.focus();
      const gain = uiGain(context, output);
      expect(gain.gain.value).toBeCloseTo(0.36, 6);
      stageOptions().set({ ...defaultStageOptions(), uiSoundsPercent: 30 });
      sounds.focus();
      expect(gain.gain.value).toBeCloseTo(0.09, 6);
      // 0 is off: no UI sound and no game sound plays.
      stageOptions().set({ ...defaultStageOptions(), uiSoundsPercent: 0 });
      const before = startedSources(context).length;
      for (const name of UI_SOUND_NAMES) sounds[name]();
      expect(startedSources(context).length).toBe(before);
    } finally {
      stageOptions().set(null);
    }
  });

  it("plays nothing at a level of 0", () => {
    const { context, sounds } = setUp(() => 0);
    sounds.gesture();
    for (const name of MENU_SOUNDS) sounds[name]();
    expect(startedSources(context)).toEqual([]);
  });

  it("reads the level anew for each sound", () => {
    let level = 60;
    const { context, output, sounds } = setUp(() => level);
    sounds.gesture();
    sounds.focus();
    level = 100;
    sounds.focus();
    expect(uiGain(context, output).gain.value).toBeCloseTo(1, 6);
  });

  it("ducks by 6 dB while a Song plays, and comes back after", () => {
    const { context, output, sounds } = setUp();
    sounds.gesture();
    sounds.focus();
    const gain = uiGain(context, output);
    sounds.setDucked(true);
    expect(gain.gain.value).toBeCloseTo(0.36 * 0.501187, 5);
    sounds.focus();
    expect(gain.gain.value).toBeCloseTo(0.36 * 0.501187, 5);
    sounds.setDucked(false);
    expect(gain.gain.value).toBeCloseTo(0.36, 6);
  });

  it("is ducked from its first sound when the Song started before it", () => {
    const { context, output, sounds } = setUp();
    sounds.setDucked(true);
    sounds.gesture();
    sounds.focus();
    expect(uiGain(context, output).gain.value).toBeCloseTo(0.36 * 0.501187, 5);
  });

  it("lets go of each sound's nodes once it has ended", () => {
    const { context, sounds } = setUp();
    sounds.gesture();
    sounds.holdDone();
    sounds.select();
    context.playUntil(10);
    for (const source of context.bufferSources) source.onended?.();
    for (const source of startedSources(context)) {
      expect(source.outputs).toEqual([]);
    }
  });
});

describe("the game sounds (ticket 262)", () => {
  it("names the seven game sounds", () => {
    expect([...GAME_SOUNDS].sort()).toEqual(
      [
        "countdown",
        "fanfare",
        "go",
        "goldenHit",
        "highScore",
        "linePerfect",
        "resultsRise",
      ].sort(),
    );
  });

  it.each(GAME_SOUNDS)("has a named function %s that plays", (name) => {
    const { context, output, sounds } = setUp();
    sounds.gesture();
    sounds[name satisfies UiSoundName]();
    const started = startedSources(context);
    expect(started.length).toBeGreaterThan(0);
    for (const source of started) expect(reaches(source, output)).toBe(true);
  });

  it("never plays at a UI sounds level of 0", () => {
    const { context, sounds } = setUp(() => 0);
    sounds.gesture();
    for (const name of GAME_SOUNDS) sounds[name]();
    expect(startedSources(context)).toEqual([]);
  });

  it("silences Perfect! and golden Notes with Effects off, and only those", () => {
    expect([...EFFECT_SOUNDS].sort()).toEqual(["goldenHit", "linePerfect"]);
    const { context, sounds } = setUp(
      () => 60,
      () => true,
    );
    sounds.gesture();
    sounds.linePerfect();
    sounds.goldenHit();
    expect(startedSources(context)).toEqual([]);
    sounds.countdown();
    sounds.fanfare();
    expect(startedSources(context).length).toBeGreaterThan(0);
  });

  it("by default reads Effects from the Stage options, for each sound", () => {
    const context = fakeSynthContext();
    const output = context.createGain();
    output.connect(context.destination);
    const sounds = createUiSounds({
      context: () => asAudioContext(context),
      output: () => output as unknown as AudioNode,
      level: () => 60,
    });
    sounds.gesture();
    try {
      stageOptions().set({ ...defaultStageOptions(), effects: "off" });
      sounds.linePerfect();
      expect(startedSources(context)).toEqual([]);
      stageOptions().set(null);
      sounds.linePerfect();
      expect(startedSources(context).length).toBeGreaterThan(0);
    } finally {
      stageOptions().set(null);
    }
  });

  it("reads Effects anew for each sound", () => {
    let off = true;
    const { context, sounds } = setUp(
      () => 60,
      () => off,
    );
    sounds.gesture();
    sounds.linePerfect();
    off = false;
    sounds.linePerfect();
    expect(startedSources(context).length).toBeGreaterThan(0);
  });
});

describe("silentSounds", () => {
  it("has every named sound, and plays nothing", () => {
    const sounds = silentSounds();
    for (const name of UI_SOUND_NAMES) {
      expect(() => {
        sounds[name]();
      }).not.toThrow();
    }
    sounds.gesture();
    sounds.setDucked(true);
  });
});
