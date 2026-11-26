// The main thread's side of the pitch-detection worklet: the one place any
// route (the Phone at `/`, the Stage at `/stage`) makes a pitch node, so every
// route loads the same built worklet file and the same WASM file, both build
// assets served by OpenStar itself (never a CDN).
//
// A node takes one mono input and posts a `PitchWorkletReading` for every
// Pitch reading. Mapping `endFrame` onto the page's clock (the lower envelope
// of arrival time − frame time, v1 spec #50) is the caller's job.

import processorUrl from "./pitchProcessor.ts?worker&url";
import wasmUrl from "../../../wasm/openstar_detector.wasm?url";
import {
  PITCH_PROCESSOR_NAME,
  type PitchProcessorOptions,
  type PitchWorkletMessage,
  type PitchWorkletReading,
} from "./pitchMessages";

export type { PitchWorkletReading } from "./pitchMessages";

let detectorBytes: Promise<ArrayBuffer> | null = null;
const loadedContexts = new WeakMap<BaseAudioContext, Promise<void>>();

/** The detector module's bytes, fetched once per page (again after a failure). */
function detector(): Promise<ArrayBuffer> {
  detectorBytes ??= fetch(wasmUrl)
    .then((response) => {
      if (!response.ok)
        throw new Error(
          `the pitch detector did not load (${String(response.status)})`,
        );
      return response.arrayBuffer();
    })
    .catch((error: unknown) => {
      detectorBytes = null;
      throw error;
    });
  return detectorBytes;
}

/** Adds the worklet module to `context`, once per context. */
function addWorklet(context: BaseAudioContext): Promise<void> {
  let loaded = loadedContexts.get(context);
  if (!loaded) {
    loaded = context.audioWorklet
      .addModule(processorUrl)
      .catch((error: unknown) => {
        loadedContexts.delete(context);
        throw error;
      });
    loadedContexts.set(context, loaded);
  }
  return loaded;
}

/**
 * A pitch node on `context`: connect one mono source to it (a channel of a
 * `ChannelSplitter`, say); `onReading` gets every reading, voiced or not.
 * Disconnect it and close its port to stop.
 */
export async function createPitchNode(
  context: BaseAudioContext,
  onReading: (reading: PitchWorkletReading) => void,
): Promise<AudioWorkletNode> {
  const [wasm] = await Promise.all([detector(), addWorklet(context)]);
  const processorOptions: PitchProcessorOptions = { wasm };
  const node = new AudioWorkletNode(context, PITCH_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
    processorOptions,
  });
  node.port.onmessage = (event: MessageEvent<PitchWorkletMessage>) => {
    onReading(event.data);
  };
  return node;
}
