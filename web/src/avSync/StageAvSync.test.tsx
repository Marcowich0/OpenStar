// Check A/V sync on the Stage (#163): started from the Setup pill or by a
// Remote through the server, ←/→ and a Remote's presses step the Stage's
// own A/V offset and save it at once, the clicks play through the Stage's
// gain chain while it runs, and Done ends it for everyone.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AvOffset } from "../generated/AvOffset";
import type { ClientMessage } from "../generated/ClientMessage";
import type { MicBridge } from "../generated/MicBridge";
import type { MicBridges } from "../generated/MicBridges";
import type { NotProAudio } from "../generated/NotProAudio";
import type { PartySnapshot } from "../generated/PartySnapshot";
import type { ServerMessage } from "../generated/ServerMessage";
import type { LiveClientOptions } from "../live/liveClient";
import { createLiveStore } from "../live/liveStore";
import { fakeStageContext } from "./fakeStageAudio";
import { SCENES } from "../stage/frame/sceneComponents";
import { StageFrame } from "../stage/frame/StageFrame";
import { StageOutputProvider } from "../stage/output/StageOutput";
import type { StageOutputWatcher } from "../stage/output/stageOutput";

// The Stage's AudioContext, which jsdom lacks: a recording fake.
vi.mock("../stage/playback/stageAudio", async () =>
  (await import("./fakeStageAudio")).fakeStageAudioModule(),
);

const PARTY = {
  partyId: "p",
  stageId: "main",
  joinCode: "ABCD",
  startedAtMs: 0,
  members: [],
  phones: [],
  queue: [],
  head: null,
  lineUp: null,
  playing: null,
  results: null,
  localMics: [],
} as unknown as PartySnapshot;

function Empty() {
  return <div />;
}
const STAND_INS = Object.fromEntries(
  Object.keys(SCENES).map((id) => [id, { component: Empty }]),
) as unknown as typeof SCENES;

function fakeWatcher(key: string): StageOutputWatcher {
  return {
    start: () => {},
    stop: () => {},
    current: () => key,
    subscribe: () => () => {},
    onOutputChanged: () => () => {},
  };
}

function bodyOf(init: RequestInit | undefined): string {
  return typeof init?.body === "string" ? init.body : "";
}

let saved: AvOffset[] = [];
let kept = 0;
let micBridges: MicBridges = { bridges: [], requests: [] };

beforeEach(() => {
  saved = [];
  kept = 0;
  micBridges = { bridges: [], requests: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
        "http://openstar.test",
      );
      if (url.pathname === "/api/av-offset" && init?.method === "PUT") {
        const body = JSON.parse(bodyOf(init)) as AvOffset;
        saved.push(body);
        kept = body.avOffsetMs;
        return Promise.resolve(Response.json(body));
      }
      if (url.pathname === "/api/mic-bridges") {
        return Promise.resolve(Response.json(micBridges));
      }
      if (url.pathname === "/api/av-offset") {
        return Promise.resolve(
          Response.json({
            browser: url.searchParams.get("browser") ?? "",
            output: url.searchParams.get("output") ?? "",
            avOffsetMs: kept,
          } satisfies AvOffset),
        );
      }
      return Promise.resolve(Response.json({}));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderStage({ keptMs = 0 } = {}) {
  kept = keptMs;
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  const sent: ClientMessage[] = [];
  const store = createLiveStore((given) => {
    handlers = given;
    return {
      send: (message) => {
        sent.push(message);
        return true;
      },
      close: () => {},
    };
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <StageOutputProvider
        store={store}
        makeWatcher={() => fakeWatcher("Speakers")}
        storage={() => ({ getItem: () => "stage-1", setItem: () => {} })}
      >
        <StageFrame
          store={store}
          scenes={STAND_INS}
          chooseScene={() => "songBrowser"}
        />
      </StageOutputProvider>
    </QueryClientProvider>,
  );
  const server = (message: ServerMessage) => {
    act(() => {
      handlers?.onMessage(message);
    });
  };
  act(() => {
    handlers?.onConnection("open");
  });
  server({ type: "liveState", stageId: "main", party: PARTY, isStage: true });
  return { sent, server };
}

const dialog = () => screen.queryByRole("dialog", { name: "Check A/V sync" });
const value = () => screen.getByLabelText("A/V offset").textContent;

function press(key: string) {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key });
  });
}

describe("Check A/V sync and Pro Audio", () => {
  const SWITCH_FIRST =
    "A Mic bridge interface is not in Pro Audio: switch profiles before calibrating (Setup › Mics)";
  /** An open bridge; `notProAudio` left out when everything is in Pro Audio. */
  const bridge = (notProAudio?: NotProAudio[]): MicBridge => ({
    bridgeId: "zeus",
    hostName: "zeus",
    open: true,
    channels: [],
    interfaces: [],
    ...(notProAudio === undefined ? {} : { notProAudio }),
  });

  it("says to switch profiles first while a connected bridge's interface is not in Pro Audio", async () => {
    micBridges = {
      bridges: [
        bridge([
          {
            deviceName: "card",
            cardName: "card",
            label: "Scarlett 4i4",
            profile: "Analog Surround 2.1",
            switchRefused: false,
          },
        ]),
      ],
      requests: [],
    };
    const { server } = renderStage();
    server({ type: "avSync", running: true });
    expect(await screen.findByText(SWITCH_FIRST)).toBeInTheDocument();
  });

  it("says nothing of profiles while every connected interface is in Pro Audio", async () => {
    micBridges = { bridges: [bridge()], requests: [] };
    const { server } = renderStage();
    server({ type: "avSync", running: true });
    await waitFor(() => {
      expect(value()).toBe("0 ms");
    });
    expect(screen.queryByText(SWITCH_FIRST)).toBeNull();
  });
});

describe("Check A/V sync on the Stage", () => {
  it("starts from the Setup pill with no Admin PIN, and opens once the server says it runs", () => {
    const { sent, server } = renderStage();
    fireEvent.click(screen.getByRole("button", { name: "Setup" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Check A/V sync" }));
    expect(sent.at(-1)).toEqual({ type: "startAvSync" });
    expect(dialog()).toBeNull();

    server({ type: "avSync", running: true });
    expect(dialog()).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /ball bouncing/ })).toBeVisible();
  });

  it("opens when a Remote starts it, and shows the kept value large with its sign", async () => {
    const { server } = renderStage({ keptMs: 120 });
    server({ type: "avSync", running: true });
    await waitFor(() => {
      expect(value()).toBe("+120 ms");
    });
  });

  it("steps 10 ms with ←/→ and saves each change at once under the Stage's own browser id", async () => {
    const { server } = renderStage();
    server({ type: "avSync", running: true });
    await waitFor(() => {
      expect(value()).toBe("0 ms");
    });
    press("ArrowRight");
    press("ArrowRight");
    expect(value()).toBe("+20 ms");
    press("ArrowLeft");
    expect(value()).toBe("+10 ms");
    await waitFor(() => {
      expect(saved.map((s) => s.avOffsetMs)).toEqual([10, 20, 10]);
    });
    expect(saved.every((s) => s.browser === "stage-1")).toBe(true);
    expect(saved.every((s) => s.output === "Speakers")).toBe(true);
  });

  it("applies a Remote's −, + and Reset relayed by the server, and its own buttons", async () => {
    const { server } = renderStage({ keptMs: 490 });
    server({ type: "avSync", running: true });
    await waitFor(() => {
      expect(value()).toBe("+490 ms");
    });
    server({ type: "stepAvSync", step: "up" });
    server({ type: "stepAvSync", step: "up" });
    expect(value()).toBe("+500 ms");
    server({ type: "stepAvSync", step: "down" });
    expect(value()).toBe("+490 ms");
    server({ type: "stepAvSync", step: "reset" });
    expect(value()).toBe("0 ms");
    fireEvent.click(screen.getByRole("button", { name: "A/V offset down" }));
    expect(value()).toBe("−10 ms");
    fireEvent.click(screen.getByRole("button", { name: "Reset to 0" }));
    expect(value()).toBe("0 ms");
    await waitFor(() => {
      expect(saved.map((s) => s.avOffsetMs)).toEqual([
        500, 500, 490, 0, -10, 0,
      ]);
    });
  });

  it("tells every Remote its value once loaded and after every change, never the 0 shown while loading", async () => {
    const { sent, server } = renderStage({ keptMs: 120 });
    const reports = () =>
      sent.flatMap((m) =>
        m.type === "reportAvSyncOffset" ? [m.avOffsetMs] : [],
      );
    server({ type: "avSync", running: true });
    await waitFor(() => {
      expect(reports()).toEqual([120]);
    });
    server({ type: "stepAvSync", step: "up" });
    press("ArrowLeft");
    press("ArrowLeft");
    expect(reports()).toEqual([120, 130, 120, 110]);
  });

  it("clicks on the Stage's gain chain while it runs, and stops when Done ends it", () => {
    const { sent, server } = renderStage();
    const before = fakeStageContext().oscillators.length;
    server({ type: "avSync", running: true });
    const clicks = fakeStageContext().oscillators.slice(before);
    expect(clicks.length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(sent.at(-1)).toEqual({ type: "endAvSync" });
    expect(dialog()).toBeNull();
    for (const click of clicks) expect(click.outputs).toEqual([]);
  });

  it("closes when the server says it ended, and closing it ends it for everyone", () => {
    const { sent, server } = renderStage();
    server({ type: "avSync", running: true });
    server({ type: "avSync", running: false });
    expect(dialog()).toBeNull();
    expect(sent.some((m) => m.type === "endAvSync")).toBe(false);

    server({ type: "avSync", running: true });
    press("Escape");
    expect(dialog()).toBeNull();
    expect(sent.at(-1)).toEqual({ type: "endAvSync" });
  });
});
