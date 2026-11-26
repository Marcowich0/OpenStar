// The main thread's side of the pitch-detection worklet: the one place any
// route (the Phone at `/`, the Stage at `/stage`) makes a pitch node, so every
// route loads the same built worklet file and the same WASM file, both build
// assets served by OpenStar itself (never a CDN).
//
// A node takes one mono input and posts a `PitchWorkletReading` for every
// Pitch reading. Mapping `endFrame` onto the page's clock (the lower envelope
// of arrival time − frame time, v1 spec #50) is the caller's job, with a
// sender session from `../clock/senderSession` (the same WASM file).

import processorUrl from "./pitchProcessor.ts?worker&url";
import wasmUrl from "../../../wasm/openstar_detector.wasm?url";
import {
  PITCH_PROCESSOR_NAME,
  type PitchNodeCommand,
  type PitchProcessorOptions,
  type PitchWorkletLevel,
  type PitchWorkletMessage,
  type PitchWorkletReading,
} from "./pitchMessages";

export type { PitchWorkletLevel, PitchWorkletReading } from "./pitchMessages";

export interface PitchNodeOptions {
  /** Whether the detector runs from the start (default `true`). */
  detect?: boolean;
  /** Gets the loudness the node posts while its detector is off. */
  onLevel?: (level: PitchWorkletLevel) => void;
}

let detectorBytes: Promise<ArrayBuffer> | null = null;
const loadedContexts = new WeakMap<BaseAudioContext, Promise<void>>();

/**
 * The detector module's bytes, fetched once per page (again after a failure).
 * The capture clock (`../clock/senderSession`) compiles the same bytes.
 */
export function detectorWasm(): Promise<ArrayBuffer> {
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
 * With `detect: false` it starts metering only (`onLevel`) until
 * `setDetecting` switches its detector on. Disconnect it and close its port
 * to stop.
 */
export async function createPitchNode(
  context: BaseAudioContext,
  onReading: (reading: PitchWorkletReading) => void,
  { detect = true, onLevel }: PitchNodeOptions = {},
): Promise<AudioWorkletNode> {
  const [wasm] = await Promise.all([detectorWasm(), addWorklet(context)]);
  const processorOptions: PitchProcessorOptions = { wasm, detect };
  const node = new AudioWorkletNode(context, PITCH_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
    processorOptions,
  });
  node.port.onmessage = (event: MessageEvent<PitchWorkletMessage>) => {
    const message = event.data;
    if (message.type === "reading") onReading(message);
    else onLevel?.(message);
  };
  return node;
}

/**
 * Runs a pitch node's detector or stops it; its level keeps coming either
 * way. One switched on starts afresh, with an empty window.
 */
export function setDetecting(node: AudioWorkletNode, on: boolean): void {
  const command: PitchNodeCommand = { type: "detect", on };
  node.port.postMessage(command);
}
