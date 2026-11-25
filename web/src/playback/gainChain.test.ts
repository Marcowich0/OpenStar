import { describe, expect, it } from "vitest";

import {
  asAudioContext,
  fakeAudioContext,
  pathFrom,
  type FakeNode,
} from "./fakeAudioContext";
import { createGainChain } from "./gainChain";

function setUp(volume?: number) {
  const context = fakeAudioContext();
  const chain = createGainChain(
    asAudioContext(context),
    volume === undefined ? {} : { volume },
  );
  const media = {};
  chain.connectMedia(media as HTMLMediaElement);
  const source = context.nodes.find((n) => n.kind === "media") as FakeNode;
  const path = pathFrom(source);
  return { context, chain, media, source, path };
}

describe("the Stage's gain chain", () => {
  it("runs media element → Song gain → OpenStar volume → output", () => {
    const { context, path, media } = setUp();
    expect(path.map((n) => n.kind)).toEqual([
      "media",
      "gain",
      "gain",
      "destination",
    ]);
    expect(path[0]?.element).toBe(media);
    expect(path.at(-1)).toBe(context.destination);
  });

  it("sets the Song gain from the Song's loudness", () => {
    const { chain, path } = setUp();
    const songGain = path[1] as FakeNode;
    expect(songGain.gain.value).toBe(1);
    chain.setSongLoudness(-24);
    expect(songGain.gain.value).toBeCloseTo(1.9953, 4); // +6 dB
    chain.setSongLoudness(-10);
    expect(songGain.gain.value).toBeCloseTo(0.3981, 4); // −8 dB
    chain.setSongLoudness(null);
    expect(songGain.gain.value).toBe(1);
  });

  it("applies the OpenStar volume as (v/100)², starting at 80", () => {
    const { chain, path } = setUp();
    const volume = path[2] as FakeNode;
    expect(volume.gain.value).toBeCloseTo(0.64, 9);
    expect(chain.volume).toBe(80);
    chain.setVolume(0);
    expect(volume.gain.value).toBe(0);
    expect(chain.volume).toBe(0);
  });

  it("can start at another volume", () => {
    const { path } = setUp(50);
    expect(path[2]?.gain.value).toBeCloseTo(0.25, 9);
  });

  it("offers one input after the Song gain, through the OpenStar volume", () => {
    const { context, chain, path } = setUp();
    const tone = context.createGain();
    tone.connect(chain.input as unknown as FakeNode);
    const tonePath = pathFrom(tone);
    // The tone skips the Song gain but shares the volume and the output.
    expect(tonePath).not.toContain(path[1]);
    expect(tonePath.slice(-2)).toEqual(path.slice(-2));
  });

  it("connects one element once, however often it is asked", () => {
    const context = fakeAudioContext();
    const chain = createGainChain(asAudioContext(context));
    const media = {} as HTMLMediaElement;
    const disconnect = chain.connectMedia(media);
    disconnect();
    expect(() => chain.connectMedia(media)).not.toThrow();
    const sources = context.nodes.filter((n) => n.kind === "media");
    expect(sources).toHaveLength(1);
    expect(pathFrom(sources[0] as FakeNode).at(-1)).toBe(context.destination);
  });

  it("disconnects an element from the chain", () => {
    const { chain, source, media } = setUp();
    expect(source.outputs).toHaveLength(1);
    chain.connectMedia(media as HTMLMediaElement)();
    expect(source.outputs).toHaveLength(0);
  });
});
