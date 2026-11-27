// The UI sound engine (#261): named sounds synthesized on the Stage's
// AudioContext, into the gain chain's input, at the UI sounds level and
// ducked by 6 dB while a Song plays. No audio is compared: the tests read
// which sources start and where they lead.

import { describe, expect, it, vi } from "vitest";

import { asAudioContext } from "../../playback/fakeAudioContext";
import {
  fakeSynthContext,
  reaches,
  startedSources,
  type FakeSynthContext,
} from "./fakeSynthContext";
import {
  MENU_SOUNDS,
  UI_SOUNDS_LEVEL,
  createUiSounds,
  type UiSoundName,
} from "./uiSounds";

function setUp(level = () => 60) {
  const context = fakeSynthContext();
  const output = context.createGain();
  output.connect(context.destination);
  const makeContext = vi.fn(() => asAudioContext(context));
  const sounds = createUiSounds({
    context: makeContext,
    output: () => output as unknown as AudioNode,
    level,
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

  it("plays at the UI sounds level, 60 % by default, on the OpenStar volume's curve", () => {
    expect(UI_SOUNDS_LEVEL).toBe(60);
    const { context, output, sounds } = setUp();
    sounds.gesture();
    sounds.focus();
    expect(uiGain(context, output).gain.value).toBeCloseTo(0.36, 6);
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
