import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PitchWorkletReading } from "./pitchMessages";

interface FakeNode {
  context: unknown;
  name: string;
  options: AudioWorkletNodeOptions;
  port: { onmessage: ((event: MessageEvent) => void) | null };
}

let nodes: FakeNode[];
let fetches: string[];

beforeEach(() => {
  vi.resetModules();
  nodes = [];
  fetches = [];
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      readonly port: FakeNode["port"] = { onmessage: null };
      constructor(
        readonly context: unknown,
        readonly name: string,
        readonly options: AudioWorkletNodeOptions,
      ) {
        nodes.push(this);
      }
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      fetches.push(url);
      return Promise.resolve(new Response(new Uint8Array([0, 97, 115, 109])));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeContext() {
  const addModule = vi.fn<(url: string) => Promise<void>>(() =>
    Promise.resolve(),
  );
  return {
    context: { audioWorklet: { addModule } } as unknown as BaseAudioContext,
    addModule,
  };
}

describe("createPitchNode", () => {
  it("adds the one shared worklet file to each context once and fetches the detector once per page", async () => {
    const { createPitchNode } = await import("./pitchWorklet");
    const a = fakeContext();
    const b = fakeContext();
    await Promise.all([
      createPitchNode(a.context, () => {}),
      createPitchNode(a.context, () => {}),
      createPitchNode(b.context, () => {}),
    ]);

    expect(a.addModule).toHaveBeenCalledTimes(1);
    expect(b.addModule).toHaveBeenCalledTimes(1);
    expect(a.addModule.mock.calls[0]?.[0]).toMatch(/pitchProcessor/);
    expect(b.addModule.mock.calls[0]?.[0]).toBe(a.addModule.mock.calls[0]?.[0]);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toMatch(/openstar_detector.*\.wasm/);
    // Same origin: a path, never a host.
    expect(fetches[0]).not.toMatch(/^[a-z]+:\/\//);
  });

  it("makes a mono node with no outputs that carries the detector's bytes", async () => {
    const { createPitchNode } = await import("./pitchWorklet");
    const { context } = fakeContext();
    await createPitchNode(context, () => {});

    expect(nodes[0]?.name).toBe("openstar-pitch");
    expect(nodes[0]?.options).toMatchObject({
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
    });
    const wasm = (nodes[0]?.options.processorOptions as { wasm: ArrayBuffer })
      .wasm;
    expect([...new Uint8Array(wasm)]).toEqual([0, 97, 115, 109]);
  });

  it("hands every reading the worklet posts to the listener", async () => {
    const { createPitchNode } = await import("./pitchWorklet");
    const { context } = fakeContext();
    const heard: PitchWorkletReading[] = [];
    await createPitchNode(context, (reading) => heard.push(reading));
    const reading: PitchWorkletReading = {
      type: "reading",
      pitch: null,
      clarity: 0.1,
      loudness: -120,
      endFrame: 2048,
      sampleRate: 48_000,
    };
    nodes[0]?.port.onmessage?.(new MessageEvent("message", { data: reading }));
    expect(heard).toEqual([reading]);
  });

  it("fetches the detector again after a failed fetch", async () => {
    const { createPitchNode } = await import("./pitchWorklet");
    const { context } = fakeContext();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(createPitchNode(context, () => {})).rejects.toThrow();
    await createPitchNode(context, () => {});
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});
