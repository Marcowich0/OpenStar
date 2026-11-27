import { act, render, screen, within } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Note } from "../../generated/Note";
import type { ParsedSong } from "../../generated/ParsedSong";
import { singVoices, type SingState } from "./frame";
import { confettiBurst, ParticlePool } from "./effects";
import { PitchBuffer } from "../../pitch/pitchBuffer";
import { laneLayout } from "./laneLayout";
import { lineEnded, LineRatings } from "./lineRating";
import { LanePanels, SingScreen } from "./SingScreen";

// The real lane layout, watched: the panels are placed by it.
vi.mock(import("./laneLayout"), async (original) => {
  const actual = await original();
  return { ...actual, laneLayout: vi.fn(actual.laneLayout) };
});

const notes: Note[] = [4, 8].map((start) => ({
  kind: "normal",
  start,
  length: 2,
  pitch: start,
  text: "la ",
  line: 1,
}));
const song = {
  headers: { gapSeconds: 1, beatsPerMinute: 120 },
  voices: [{ lines: [{ notes, end: null }] }],
} as unknown as ParsedSong;
const state: SingState = {
  grid: { gapSeconds: 1, beatsPerMinute: 120 },
  voices: singVoices(song),
  lanes: [
    {
      colour: "cherry",
      voice: 0,
      player: {
        name: "Mia",
        avatar: { kind: "builtIn", key: "star" },
        guest: false,
        score: 1234,
      },
    },
    {
      colour: "teal",
      voice: 0,
      player: {
        name: "Bo",
        avatar: { kind: "builtIn", key: "moon" },
        guest: true,
        score: 0,
      },
    },
  ],
};

const contexts = new Map<HTMLCanvasElement, string[]>();
let frames: FrameRequestCallback[] = [];
let cancelFrame: ReturnType<typeof vi.spyOn>;

function setWindow(width: number, height: number, ratio: number) {
  Object.assign(window, {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: ratio,
  });
}

beforeEach(() => {
  contexts.clear();
  frames = [];
  setWindow(1920, 1080, 2);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement) {
      const calls: string[] = [];
      contexts.set(this, calls);
      return new Proxy(
        {
          canvas: this,
          createLinearGradient: () => ({ addColorStop() {} }),
          createRadialGradient: () => ({ addColorStop() {} }),
        },
        {
          get: (obj, prop: string) =>
            prop in obj
              ? obj[prop as keyof typeof obj]
              : () => calls.push(prop),
          set: () => true,
        },
      ) as unknown as CanvasRenderingContext2D;
    },
  );
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  cancelFrame = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function runFrame(timestamp = 0) {
  const next = frames.shift();
  act(() => next?.(timestamp));
}

function layers(container: HTMLElement) {
  return [...container.querySelectorAll("[data-layer]")].map((el) =>
    el.getAttribute("data-layer"),
  );
}

describe("SingScreen", () => {
  it("stacks its layers bottom to top: backdrop, background, panels, lanes, headers and lyrics, effects, overlays", () => {
    const { container } = render(
      <SingScreen
        state={state}
        clock={{ songTime: () => 3 }}
        avOffset={() => 0}
      />,
    );
    expect(layers(container)).toEqual([
      "backdrop",
      "background",
      "panels",
      "lanes",
      "headers",
      "effects",
      "overlays",
    ]);
  });

  it("renders both canvases at devicePixelRatio and resizes them with the window", () => {
    const { container } = render(
      <SingScreen
        state={state}
        clock={{ songTime: () => 3 }}
        avOffset={() => 0}
      />,
    );
    const canvases = [
      ...container.querySelectorAll<HTMLCanvasElement>(
        'canvas[data-layer="lanes"], canvas[data-layer="effects"]',
      ),
    ];
    expect(canvases).toHaveLength(2);
    for (const canvas of canvases) {
      expect([canvas.width, canvas.height]).toEqual([3840, 2160]);
    }
    act(() => {
      setWindow(1280, 720, 1.5);
      window.dispatchEvent(new Event("resize"));
    });
    for (const canvas of canvases) {
      expect([canvas.width, canvas.height]).toEqual([1920, 1080]);
    }
  });

  it("renders the background canvas at a quarter of the CSS pixels: the browser smooths the soft blobs up", () => {
    const { container } = render(
      <SingScreen
        state={state}
        clock={{ songTime: () => 3 }}
        avOffset={() => 0}
      />,
    );
    const canvas = container.querySelector<HTMLCanvasElement>(
      'canvas[data-layer="background"]',
    );
    expect([canvas?.width, canvas?.height]).toEqual([480, 270]);
    act(() => {
      setWindow(1280, 720, 1.5);
      window.dispatchEvent(new Event("resize"));
    });
    expect([canvas?.width, canvas?.height]).toEqual([320, 180]);
  });

  it("paints the blobs on the background canvas, under the frosted panels, and nothing else there", () => {
    const { container } = render(
      <SingScreen
        state={{ ...state, background: { kind: "blobs", still: false } }}
        clock={{ songTime: () => 3 }}
        avOffset={() => 0}
      />,
    );
    runFrame();
    const canvas = (layer: string) => {
      const el = container.querySelector<HTMLCanvasElement>(
        `canvas[data-layer="${layer}"]`,
      );
      return (el && contexts.get(el)) ?? [];
    };
    // The base, then one rectangle per blob: Mia, Bo, and slate for the
    // Voice they share.
    expect(canvas("background").filter((c) => c === "fillRect")).toHaveLength(
      1 + 3,
    );
    expect(canvas("background")).not.toContain("roundRect");
    expect(canvas("lanes")).not.toContain("fillRect");
  });

  it("places one frosted panel per lane, from the lane layout", () => {
    const { container } = render(
      <SingScreen
        state={state}
        clock={{ songTime: () => 3 }}
        avOffset={() => 0}
      />,
    );
    const panels = container.querySelectorAll<HTMLElement>("[data-lane-panel]");
    expect(panels).toHaveLength(2);
    expect(panels[1]?.style).toMatchObject({
      left: "60px",
      top: "732px",
      width: "1800px",
      height: "140px",
    });
  });

  it("frosts each lane panel and tints it in the Party colour at 16 %, with the lane ledge and soft shadow", () => {
    const { container } = render(
      <SingScreen
        state={state}
        clock={{ songTime: () => 3 }}
        avOffset={() => 0}
      />,
    );
    const panel = container.querySelector<HTMLElement>("[data-lane-panel]");
    expect(panel?.className).toMatch(/\bbg-white\/66\b/);
    expect(panel?.className).toMatch(/\bbackdrop-blur-lg\b/);
    expect(panel?.className).toMatch(/\bbackdrop-saturate-130\b/);
    expect(panel?.style.borderRadius).toBe("40px");
    expect(panel?.style.boxShadow).toBe(
      "0 10px 0 var(--color-lane-ledge), 0 20px 40px var(--color-lane-shadow)",
    );
    const tint = panel?.firstElementChild as HTMLElement | null;
    expect(tint?.className).toMatch(/\bopacity-16\b/);
    expect(tint?.style.backgroundColor).toBe("var(--color-party-cherry)");
  });

  it('heads each lane with the avatar, the name, "guest" for a Guest, and the running Score', () => {
    const { container } = render(
      <SingScreen
        state={state}
        clock={{ songTime: () => 3 }}
        avOffset={() => 0}
      />,
    );
    const headers = [
      ...container.querySelectorAll<HTMLElement>("[data-lane-header]"),
    ];
    expect(headers).toHaveLength(2);
    const [mia, bo] = headers.map((h) => within(h));
    expect(mia?.getByRole("img", { name: "Mia" })).toBeInTheDocument();
    expect(mia?.getByText("Mia")).toBeInTheDocument();
    expect(mia?.queryByText("guest")).toBeNull();
    expect(mia?.getByText("1234")).toHaveClass("tabular-nums");
    expect(bo?.getByText("guest")).toBeInTheDocument();
    expect(bo?.getByText("0")).toBeInTheDocument();
    // Two lanes of 140 px: a 70 px avatar and the Score at 44 px.
    expect(mia?.getByRole("img", { name: "Mia" }).style.width).toBe("70px");
    expect(
      mia?.getByText("1234").closest<HTMLElement>("[data-lane-score]")?.style
        .fontSize,
    ).toBe("44px");
    // No Voice tag outside a duet.
    expect(screen.queryByText(/V1/)).toBeNull();
  });

  it("tags each Player's Voice in a duet", () => {
    const duet: SingState = {
      ...state,
      voices: singVoices({
        voices: [
          { lines: [{ notes, end: null }] },
          { lines: [{ notes, end: null }] },
        ],
      }),
      lanes: state.lanes.map((lane, i) => ({ ...lane, voice: i })),
    };
    const { container } = render(
      <SingScreen
        state={duet}
        clock={{ songTime: () => 3 }}
        avOffset={() => 0}
      />,
    );
    const headers = [
      ...container.querySelectorAll<HTMLElement>("[data-lane-header]"),
    ];
    expect(headers[0]).toHaveTextContent(/Mia\s*· V1/);
    expect(headers[1]).toHaveTextContent(/Bo\s*guest\s*· V2/);
  });

  it("paints the lanes canvas on each animation frame and marks the screen painted", () => {
    const { container } = render(
      <SingScreen
        state={state}
        clock={{ songTime: () => 3 }}
        avOffset={() => 0}
      />,
    );
    const root = container.querySelector<HTMLElement>("[data-sing-screen]");
    expect(root?.dataset.painted).toBeUndefined();
    runFrame();
    const lanesCanvas = container.querySelector<HTMLCanvasElement>(
      'canvas[data-layer="lanes"]',
    );
    const calls = lanesCanvas ? contexts.get(lanesCanvas) : undefined;
    // The progress bar's track and fill, each lane's rounded clip, and the
    // two Notes in each of the two lanes.
    expect(calls?.filter((c) => c === "roundRect")).toHaveLength(2 + 2 + 4);
    expect(root?.dataset.painted).toBe("true");
    expect(frames).toHaveLength(1); // the next frame is asked for
  });

  it("paints the particles on the effects canvas, moving them on real frame time", () => {
    const effects = new ParticlePool(64);
    confettiBurst(effects, 400, 500, "cherry");
    const { container } = render(
      <SingScreen
        state={{ ...state, effects }}
        clock={{ songTime: () => 3 }}
        avOffset={() => 0}
      />,
    );
    runFrame(1000);
    const canvas = (layer: string) => {
      const el = container.querySelector<HTMLCanvasElement>(
        `canvas[data-layer="${layer}"]`,
      );
      return (el && contexts.get(el)) ?? [];
    };
    const fills = canvas("effects").filter((c) => c === "fill").length;
    expect(fills).toBe(30);
    // The lanes canvas draws no particle: only its own two dots' worth of arcs.
    expect(canvas("lanes").filter((c) => c === "closePath")).toHaveLength(0);
    expect(canvas("effects").filter((c) => c === "clearRect")).toHaveLength(1);
    // A second later the burst has ended (it lives at most 1.3 s).
    for (let t = 1100; t <= 2400; t += 100) runFrame(t);
    expect(effects.live).toBe(0);
  });

  it("freezes the particles with a constant frame time", () => {
    const effects = new ParticlePool(64);
    confettiBurst(effects, 400, 500, "cherry");
    render(
      <SingScreen
        state={{ ...state, effects }}
        clock={{ songTime: () => 3 }}
        avOffset={() => 0}
        frameTime={() => 0}
      />,
    );
    for (let t = 1000; t <= 5000; t += 100) runFrame(t);
    expect(effects.live).toBe(30);
  });

  it("stops the loop when it unmounts", () => {
    const { unmount } = render(
      <SingScreen
        state={state}
        clock={{ songTime: () => 3 }}
        avOffset={() => 0}
      />,
    );
    unmount();
    expect(cancelFrame).toHaveBeenCalled();
  });
});

describe("the lyric bar", () => {
  // Two Lines: "Hel lo " on Beats 4–6 and 8–12, then "a gain" from Beat 16.
  // Beat b starts at Song time 1 + b / 2.
  const lyricSong = {
    voices: [
      {
        lines: [
          {
            notes: [
              { ...notes[0], start: 4, length: 2, text: "Hel" },
              { ...notes[0], start: 8, length: 4, text: "lo " },
            ],
            end: { beat: 16, line: 3 },
          },
          {
            notes: [
              { ...notes[0], start: 20, length: 2, text: "a" },
              { ...notes[0], start: 24, length: 2, text: "gain" },
            ],
            end: null,
          },
        ],
      },
    ],
  } as unknown as ParsedSong;
  const lyricState: SingState = {
    ...state,
    voices: singVoices(lyricSong),
    lanes: state.lanes.slice(0, 1),
  };

  function mount(s: SingState = lyricState, avOffset = 0) {
    let now = 1;
    let commits = 0;
    const utils = render(
      <Profiler
        id="sing"
        onRender={() => {
          commits++;
        }}
      >
        <SingScreen
          state={s}
          clock={{ songTime: () => now }}
          avOffset={() => avOffset}
        />
      </Profiler>,
    );
    const at = (beat: number) => {
      now = 1 + beat / 2;
      runFrame();
    };
    const syllables = () => [
      ...utils.container.querySelectorAll<HTMLElement>(
        "[data-lyric-bar] [data-lyric-note]",
      ),
    ];
    const fills = () =>
      syllables().map((el) => el.style.getPropertyValue("--lyric-fill"));
    return { ...utils, at, syllables, fills, commits: () => commits };
  }

  it("shows the current Line's Notes as text", () => {
    const { at, syllables } = mount();
    at(0);
    expect(syllables().map((el) => el.textContent)).toEqual(["Hel", "lo "]);
  });

  it("writes the fill fraction to a CSS custom property each frame without a React render", () => {
    const { at, fills, commits } = mount();
    at(0);
    const before = commits();
    at(4.5);
    expect(fills()).toEqual(["0.25", "0"]);
    at(5);
    expect(fills()).toEqual(["0.5", "0"]);
    at(9);
    expect(fills()).toEqual(["1", "0.25"]);
    at(14);
    expect(fills()).toEqual(["1", "1"]);
    expect(commits()).toBe(before);
  });

  it("fills at the shifted drawing time, not the Song time", () => {
    // An A/V offset of 0.5 s draws one Beat (0.5 s) behind the Song time.
    const { at, fills } = mount(lyricState, 0.5);
    at(5.5);
    expect(fills()).toEqual(["0.25", "0"]);
  });

  it("marks the Note being sung", () => {
    const { at, syllables } = mount();
    at(9);
    expect(syllables().map((el) => el.dataset.singing)).toEqual([
      undefined,
      "true",
    ]);
    at(13);
    expect(syllables().map((el) => el.dataset.singing)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("re-renders the text only when the current Line changes", () => {
    const { at, syllables, fills, commits } = mount();
    at(0);
    const before = commits();
    at(10);
    at(15.5);
    expect(commits()).toBe(before);
    at(16);
    expect(commits()).toBe(before + 1);
    expect(syllables().map((el) => el.textContent)).toEqual(["a", "gain"]);
    at(25);
    expect(fills()).toEqual(["1", "0.5"]);
    expect(commits()).toBe(before + 1);
  });

  it("fills in the Voice's fill colour", () => {
    const { at, container } = mount();
    at(9);
    const line = container.querySelector<HTMLElement>("[data-lyric-line]");
    expect(line?.style.getPropertyValue("--lyric-fill-colour")).toBe(
      "var(--color-party-cherry)",
    );
  });

  it("shows each Voice's current Line in a duet, each in its own fill colour", () => {
    const duet: SingState = {
      ...lyricState,
      voices: singVoices({
        voices: [lyricSong.voices[0], lyricSong.voices[0]].filter(
          (v) => v !== undefined,
        ),
      }),
      lanes: [
        { colour: "cherry", voice: 0 },
        { colour: "teal", voice: 1 },
        { colour: "sky", voice: 1 },
      ],
    };
    const { at, container } = mount(duet);
    at(9);
    const lines = [
      ...container.querySelectorAll<HTMLElement>("[data-lyric-line]"),
    ];
    expect(
      lines.map((l) => l.style.getPropertyValue("--lyric-fill-colour")),
    ).toEqual(["var(--color-party-cherry)", "var(--color-slate)"]);
  });
});

describe("the lane panels", () => {
  // A render of the panels lays them out once; nothing else here does.
  function renders(lanes: SingState["lanes"][]) {
    const layouts = vi.mocked(laneLayout);
    layouts.mockClear();
    const [first, ...rest] = lanes;
    const { rerender } = render(<LanePanels lanes={first ?? []} />);
    for (const l of rest) rerender(<LanePanels lanes={l} />);
    return { count: layouts.mock.calls.length };
  }

  it("re-render only when the Line-up changes, not when a Score does", () => {
    const scored = state.lanes.map((lane) =>
      lane.player
        ? { ...lane, player: { ...lane.player, score: lane.player.score + 50 } }
        : lane,
    );
    expect(renders([state.lanes, scored]).count).toBe(1);
    const recoloured = state.lanes.map((lane, i) =>
      i === 1 ? { ...lane, colour: "lime" as const } : lane,
    );
    expect(renders([state.lanes, recoloured]).count).toBe(2);
    expect(renders([state.lanes, state.lanes.slice(0, 1)]).count).toBe(2);
  });
});

describe("a lane whose Mic is lost", () => {
  /** `state` with Mia's lane traced, her Mic lost at Song time `lostAt`. */
  function lostState(lostAt: number | null): SingState {
    return {
      ...state,
      lanes: state.lanes.map((lane, i) =>
        i === 0
          ? {
              ...lane,
              trace: {
                readings: new PitchBuffer(16),
                micThresholdDbfs: -40,
                difficulty: "medium",
                lostAt,
              },
            }
          : lane,
      ),
    };
  }

  function renderAt(s: SingState, songTime: { now: number }) {
    const result = render(
      <SingScreen
        state={s}
        clock={{ songTime: () => songTime.now }}
        avOffset={() => 0}
      />,
    );
    const headers = [
      ...result.container.querySelectorAll<HTMLElement>("[data-lane-header]"),
    ];
    return { ...result, headers };
  }

  it("dims the lane header to 55 % and shows an ink pill with the crossed-out mic and three pulsing dots", () => {
    const s = lostState(2);
    const { headers, container } = renderAt(s, { now: 3 });
    runFrame();
    expect(headers[0]).toHaveAttribute("data-lost");
    expect(headers[0]).toHaveClass("data-lost:opacity-55");
    expect(headers[1]).not.toHaveAttribute("data-lost");
    const pill = screen
      .getByText("Mia's mic lost")
      .closest<HTMLElement>("[data-lane-lost]");
    expect(pill).toBeVisible();
    expect(pill).toHaveClass("bg-ink", "text-white", "rounded-full");
    // Centred 150 px right of the lane's middle, on its vertical centre.
    const rect = laneLayout(2)[0];
    if (!rect || !pill) throw new Error("no lane");
    expect(pill.style.left).toBe(`${String(rect.x + rect.width / 2 + 150)}px`);
    expect(pill.style.top).toBe(`${String(rect.y + rect.height / 2)}px`);
    expect(pill.querySelector('[data-icon="mic-off"]')).toBeInTheDocument();
    const dots = [...pill.querySelectorAll<HTMLElement>("[data-dot]")];
    expect(dots.map((d) => d.style.animationDelay)).toEqual([
      "0s",
      "0.2s",
      "0.4s",
    ]);
    for (const dot of dots) expect(dot).toHaveClass("animate-mic-lost-dot");
    // Only Mia's lane has a pill showing; the header stays a header.
    const shown = [
      ...container.querySelectorAll<HTMLElement>("[data-lane-lost]"),
    ].filter((el) => !el.hidden);
    expect(shown).toHaveLength(1);
    expect(
      within(headers[0] as HTMLElement).queryByText(/mic lost/),
    ).toBeNull();
  });

  it("shows nothing before the loss reaches the drawing time, and clears once the Mic is back, without a React render", () => {
    const s = lostState(5);
    const songTime = { now: 3 };
    const commits = vi.fn();
    const { container } = render(
      <Profiler id="sing" onRender={commits}>
        <SingScreen
          state={s}
          clock={{ songTime: () => songTime.now }}
          avOffset={() => 0}
        />
      </Profiler>,
    );
    const header = () =>
      container.querySelector<HTMLElement>("[data-lane-header]");
    const pill = () => container.querySelector<HTMLElement>("[data-lane-lost]");
    runFrame();
    expect(header()).not.toHaveAttribute("data-lost");
    expect(pill()?.hidden).toBe(true);
    songTime.now = 6;
    runFrame();
    expect(header()).toHaveAttribute("data-lost");
    expect(pill()?.hidden).toBe(false);
    // The Mic comes back: whoever detects it sets `lostAt` back in place.
    const trace = s.lanes[0]?.trace;
    if (trace) trace.lostAt = null;
    runFrame();
    expect(header()).not.toHaveAttribute("data-lost");
    expect(pill()?.hidden).toBe(true);
    const rendersAfterMount = commits.mock.calls.length;
    runFrame();
    expect(commits).toHaveBeenCalledTimes(rendersAfterMount);
  });
});

describe("a Line rating", () => {
  it("pops its word in the Party colour, outlined in white with a soft ledge, beside the lane header, without a React render", () => {
    const ratings = new LineRatings();
    const s: SingState = { ...state, ratings };
    const commits = vi.fn();
    const { container } = render(
      <Profiler id="sing" onRender={commits}>
        <SingScreen
          state={s}
          clock={{ songTime: () => 3 }}
          avOffset={() => 0}
        />
      </Profiler>,
    );
    const words = () => [
      ...container.querySelectorAll<HTMLElement>("[data-line-rating]"),
    ];
    runFrame(1000);
    expect(words()).toHaveLength(2);
    expect(words().every((w) => w.hidden)).toBe(true);
    const mounted = commits.mock.calls.length;
    lineEnded(s, 1, { rating: 6, word: "sing.lineRating.great" });
    runFrame(1100);
    const bo = words()[1];
    expect(bo).toBeVisible();
    expect(bo).toHaveTextContent("Great!");
    expect(bo?.style.color).toBe("var(--color-party-teal)");
    // A 4 px white outline (half of an 8 px stroke painted under the fill)
    // and a soft ledge.
    expect(bo?.style.getPropertyValue("-webkit-text-stroke")).toBe(
      "8px var(--color-white)",
    );
    expect(bo?.style.getPropertyValue("paint-order")).toBe("stroke");
    expect(bo?.style.textShadow).toBe("0 5px 4px var(--color-lane-ledge)");
    // In the headers layer, above the lanes canvas.
    expect(bo?.closest("[data-layer]")).toHaveAttribute(
      "data-layer",
      "headers",
    );
    expect(words()[0]?.hidden).toBe(true);
    // After the pop it is gone again.
    for (let t = 1350; t <= 3000; t += 200) runFrame(t);
    expect(bo?.hidden).toBe(true);
    expect(commits).toHaveBeenCalledTimes(mounted);
  });
});
