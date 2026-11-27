import { describe, expect, it, vi } from "vitest";

import {
  asAudioContext,
  fakeAudioContext,
  pathFrom,
  type FakeAudioContext,
  type FakeNode,
} from "./fakeAudioContext";
import {
  createSongPreviewer,
  PREVIEW,
  previewStartSeconds,
  songPreview,
  type PreviewSong,
} from "./songPreview";
import { createStageAudio } from "../stage/playback/stageAudio";
import { createStagePreview } from "../stage/playback/stagePreview";

describe("where a preview starts", () => {
  it("starts at #PREVIEWSTART", () => {
    expect(previewStartSeconds({ previewStartSeconds: 42.5 }, 180)).toBe(42.5);
  });

  it("starts a third of the way in when the file has no #PREVIEWSTART", () => {
    expect(previewStartSeconds({ previewStartSeconds: null }, 180)).toBe(60);
  });

  it("starts at the beginning when neither the preview point nor the length is known", () => {
    expect(previewStartSeconds({ previewStartSeconds: null }, null)).toBe(0);
  });

  it("ignores a preview point before the beginning or past the end", () => {
    expect(previewStartSeconds({ previewStartSeconds: -3 }, 180)).toBe(60);
    expect(previewStartSeconds({ previewStartSeconds: 200 }, 180)).toBe(60);
  });
});

/** A gain parameter that records what is scheduled on it. */
interface RecordedParam {
  value: number;
  events: string[];
  cancelScheduledValues(time: number): void;
  setValueAtTime(value: number, time: number): void;
  linearRampToValueAtTime(value: number, time: number): void;
}

function recordedParam(): RecordedParam {
  const param: RecordedParam = {
    value: 1,
    events: [],
    cancelScheduledValues(time) {
      param.events.push(`cancel@${String(time)}`);
    },
    setValueAtTime(value, time) {
      param.value = value;
      param.events.push(`set ${String(value)}@${String(time)}`);
    },
    linearRampToValueAtTime(value, time) {
      param.value = value;
      param.events.push(`ramp ${String(value)}@${String(time)}`);
    },
  };
  return param;
}

/** A media element the test drives by hand. */
class FakeElement extends EventTarget {
  src = "";
  currentTime = 0;
  readyState = 0;
  paused = true;
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  load() {
    this.readyState = 0;
  }
  /** The browser reports an event. */
  fire(type: string) {
    if (type === "loadedmetadata") this.readyState = 1;
    this.dispatchEvent(new Event(type));
  }
}

/** A fake context whose gains from now on record their scheduling. */
function recordingGains(context: FakeAudioContext): RecordedParam[] {
  const params: RecordedParam[] = [];
  const makeGain = context.createGain.bind(context);
  context.createGain = () => {
    const made = makeGain();
    const param = recordedParam();
    params.push(param);
    (made as { gain: unknown }).gain = param;
    return made;
  };
  return params;
}

function setUp(level?: () => number) {
  const context = fakeAudioContext();
  const output = context.createGain();
  const params = recordingGains(context);
  const elements: FakeElement[] = [];
  let timers: { at: number; run: () => void }[] = [];
  let now = 0;
  const previewer = createSongPreviewer({
    context: asAudioContext(context),
    output: output as unknown as AudioNode,
    ...(level ? { level } : {}),
    createElement: () => {
      const made = new FakeElement();
      elements.push(made);
      return made as unknown as HTMLMediaElement;
    },
    setTimer: (run, ms) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timers = timers.filter((t) => t !== timer);
    },
  });
  return {
    context,
    output,
    previewer,
    elements,
    params,
    /** Lets `ms` pass on the timers and the audio clock. */
    advance: (ms: number) => {
      now += ms;
      context.currentTime = now / 1000;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      for (const t of due) t.run();
    },
  };
}

function song(id: number, overrides: Partial<PreviewSong> = {}): PreviewSong {
  return {
    id,
    url: `/api/songs/${String(id)}/media/audio`,
    startSeconds: 30,
    loudnessLufs: null,
    ...overrides,
  };
}

describe("playing a preview", () => {
  it("plays on its own media element from the preview point", () => {
    const { previewer, elements } = setUp();
    previewer.play(song(1, { startSeconds: 42.5 }));
    expect(elements).toHaveLength(1);
    const element = elements[0] as FakeElement;
    expect(element.src).toBe("/api/songs/1/media/audio");
    expect(element.paused).toBe(false);
    element.fire("loadedmetadata");
    expect(element.currentTime).toBe(42.5);
  });

  it("routes its own element through a preview gain into the output after the Song gain", () => {
    const { context, output, previewer, elements } = setUp();
    previewer.play(song(1, { loudnessLufs: -12 }));
    const source = context.nodes.find((n) => n.kind === "media");
    expect(source?.element).toBe(elements[0]);
    const path = pathFrom(source as FakeNode);
    expect(path.at(-1)).toBe(output);
    // −18 − (−12) = −6 dB: the preview plays at the Song's loudness target too.
    const loudness = path[1]?.gain.value ?? 0;
    expect(20 * Math.log10(loudness)).toBeCloseTo(-6, 6);
  });

  it("fades in once the element is playing", () => {
    const { previewer, elements, params, advance } = setUp();
    previewer.play(song(1));
    advance(200);
    const fade = params[1] as RecordedParam;
    expect(fade.value).toBe(0);
    (elements[0] as FakeElement).fire("playing");
    expect(fade.events.slice(-2)).toEqual([
      "set 0@0.2",
      `ramp 1@${String(0.2 + PREVIEW.fadeInSeconds)}`,
    ]);
  });
});

describe("the preview volume", () => {
  it("fades in to the level read at each start (the Stage options' preview volume)", () => {
    let level = 0.25;
    const { previewer, elements, params, advance } = setUp(() => level);
    previewer.play(song(1));
    (elements[0] as FakeElement).fire("playing");
    const fade = params[1] as RecordedParam;
    expect(fade.events.at(-1)).toBe(
      `ramp 0.25@${String(PREVIEW.fadeInSeconds)}`,
    );
    level = 0.81;
    previewer.play(song(2));
    advance(PREVIEW.fadeOutSeconds * 1000);
    (elements[0] as FakeElement).fire("playing");
    expect(fade.events.at(-1)).toMatch(/^ramp 0\.81@/);
  });
});

describe("changing the selection", () => {
  it("fades the preview out and stops it before the next one starts", () => {
    const { previewer, elements, params, advance } = setUp();
    previewer.play(song(1));
    const element = elements[0] as FakeElement;
    element.fire("loadedmetadata");
    element.fire("playing");
    advance(2000);
    const fade = params[1] as RecordedParam;

    previewer.play(song(2, { startSeconds: 50 }));
    expect(fade.events.slice(-1)).toEqual([
      `ramp 0@${String(2 + PREVIEW.fadeOutSeconds)}`,
    ]);
    // Still the first Song while it fades out.
    expect(element.src).toBe("/api/songs/1/media/audio");
    expect(element.paused).toBe(false);

    advance(PREVIEW.fadeOutSeconds * 1000);
    expect(element.src).toBe("/api/songs/2/media/audio");
    expect(previewer.current).toBe(2);
    element.fire("loadedmetadata");
    expect(element.currentTime).toBe(50);
  });

  it("plays only one preview at a time, on one element", () => {
    const { previewer, elements, advance } = setUp();
    previewer.play(song(1));
    (elements[0] as FakeElement).fire("playing");
    previewer.play(song(2));
    previewer.play(song(3));
    expect(previewer.current).toBe(3);
    advance(PREVIEW.fadeOutSeconds * 1000);
    expect(elements).toHaveLength(1);
    expect((elements[0] as FakeElement).src).toBe("/api/songs/3/media/audio");
  });

  it("ignores selecting the Song already previewing", () => {
    const { previewer, elements, params } = setUp();
    previewer.play(song(1));
    (elements[0] as FakeElement).fire("playing");
    const fade = params[1] as RecordedParam;
    const scheduled = fade.events.length;
    previewer.play(song(1));
    expect(fade.events).toHaveLength(scheduled);
  });

  it("does not seek or fade a Song it has already left", () => {
    const { previewer, elements, params, advance } = setUp();
    previewer.play(song(1, { startSeconds: 10 }));
    const element = elements[0] as FakeElement;
    previewer.play(song(2, { startSeconds: 20 }));
    // The first never got going, so the second starts without a fade-out.
    expect(element.src).toBe("/api/songs/2/media/audio");
    element.fire("loadedmetadata");
    expect(element.currentTime).toBe(20);
    advance(10);
    expect((params[1] as RecordedParam).value).toBe(0);
  });
});

describe("stopping", () => {
  it("fades out, then pauses and lets go of the file", () => {
    const { previewer, elements, params, advance } = setUp();
    previewer.play(song(1));
    const element = elements[0] as FakeElement;
    element.fire("playing");
    advance(1500);
    previewer.stop();
    expect((params[1] as RecordedParam).events.slice(-1)).toEqual([
      `ramp 0@${String(1.5 + PREVIEW.fadeOutSeconds)}`,
    ]);
    expect(previewer.current).toBeNull();
    advance(PREVIEW.fadeOutSeconds * 1000);
    expect(element.paused).toBe(true);
    expect(element.src).toBe("");
  });

  it("stops at once on dispose", () => {
    const { previewer, elements, advance } = setUp();
    previewer.play(song(1));
    const element = elements[0] as FakeElement;
    element.fire("playing");
    previewer.play(song(2));
    previewer.dispose();
    expect(element.paused).toBe(true);
    advance(PREVIEW.fadeOutSeconds * 1000);
    expect(element.paused).toBe(true);
    expect(previewer.current).toBeNull();
  });
});

describe("a Song's preview", () => {
  const detail = {
    id: 7,
    lengthSeconds: 210,
    loudnessLufs: -14,
    media: {
      audio: { url: "/api/songs/7/media/audio", native: true },
      video: null,
      cover: null,
      background: null,
      tileColour: "cherry" as const,
    },
    song: { headers: { previewStartSeconds: null } },
  };

  it("previews its audio from the preview point at its loudness", () => {
    expect(songPreview(detail)).toEqual({
      id: 7,
      url: "/api/songs/7/media/audio",
      startSeconds: 70,
      loudnessLufs: -14,
    });
  });

  it("has no preview while its audio is still being converted", () => {
    expect(
      songPreview({
        ...detail,
        media: {
          ...detail.media,
          audio: { ...detail.media.audio, native: false },
        },
      }),
    ).toBeNull();
  });
});

describe("what a preview never touches", () => {
  const source = import.meta.glob<string>("./songPreview.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  })["./songPreview.ts"] as string;

  it("imports neither the Song clock nor the scorer", () => {
    expect(source).not.toMatch(/from "\.\.\/(clock|stage\/sing|scor)/);
    expect(source).not.toMatch(/songTime\s*\(/);
  });
});

describe("the Stage's preview player", () => {
  it("plays through the Stage chain, so the OpenStar volume applies", () => {
    // jsdom plays no media.
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "load").mockReturnValue();
    const context = fakeAudioContext();
    const audio = createStageAudio(() => asAudioContext(context));
    audio.chain();
    recordingGains(context);
    const previewer = createStagePreview(audio);
    previewer.play(song(1));
    const source = context.nodes.find((n) => n.kind === "media") as FakeNode;
    const path = pathFrom(source);
    expect(path).toContain(audio.chain().input);
    expect(path.at(-1)).toBe(context.destination);
    vi.restoreAllMocks();
  });
});
