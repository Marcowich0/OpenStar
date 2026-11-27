// UI sounds for tests: the real engine on a fake AudioContext, with every
// named sound it was asked to play recorded in order.

import { asAudioContext } from "../../playback/fakeAudioContext";
import { fakeSynthContext, type FakeSynthContext } from "./fakeSynthContext";
import { createUiSounds, type UiSoundName, type UiSounds } from "./uiSounds";

export interface RecordedSounds {
  sounds: UiSounds;
  context: FakeSynthContext;
  /** The named sounds asked for, in order. */
  played: UiSoundName[];
  /** Every `setDucked` call, in order. */
  ducked: boolean[];
  gestures: () => number;
}

export function recordedSounds(): RecordedSounds {
  const context = fakeSynthContext();
  const engine = createUiSounds({
    context: () => asAudioContext(context),
    output: () => context.destination as unknown as AudioNode,
  });
  const played: UiSoundName[] = [];
  const ducked: boolean[] = [];
  let gestures = 0;
  const sounds = Object.fromEntries(
    Object.entries(engine).map(([name, play]) => [
      name,
      (...args: unknown[]) => {
        if (name === "gesture") gestures++;
        else if (name === "setDucked") ducked.push(args[0] as boolean);
        else played.push(name as UiSoundName);
        (play as (...given: unknown[]) => void)(...args);
      },
    ]),
  ) as UiSounds;
  return { sounds, context, played, ducked, gestures: () => gestures };
}
