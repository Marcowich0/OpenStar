// Calibrate mics on the Stage (#170): the Setup pill asks the server to open
// the run, and the overlay follows the run the server holds: the checklist
// of joined Phones, each chosen Mic waiting or ready with Go, the tones on
// the Stage's gain chain, and one result row per Mic.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CalibrationRun } from "../generated/CalibrationRun";
import type { ClientMessage } from "../generated/ClientMessage";
import type { PartySnapshot } from "../generated/PartySnapshot";
import type { ServerMessage } from "../generated/ServerMessage";
import type { LiveClientOptions } from "../live/liveClient";
import { createLiveStore } from "../live/liveStore";
import { fakeStageContext } from "../avSync/fakeStageAudio";
import { SCENES } from "../stage/frame/sceneComponents";
import { StageFrame } from "../stage/frame/StageFrame";

// The Stage's AudioContext, which jsdom lacks: a recording fake.
vi.mock("../stage/playback/stageAudio", async () =>
  (await import("../avSync/fakeStageAudio")).fakeStageAudioModule(),
);

const guest = (memberId: number, name: string) => ({
  memberId,
  identity: {
    kind: "guest",
    name,
    avatar: { kind: "builtIn", key: "star" },
    difficulty: "medium",
  },
  colour: "sky",
  favouriteTaken: false,
  onPhone: true,
  singing: false,
});

const PARTY = {
  partyId: "p",
  stageId: "main",
  joinCode: "ABCD",
  startedAtMs: 0,
  members: [guest(1, "Bo"), guest(2, "Jonas")],
  phones: [
    { phoneId: "phone-bo", memberId: 1 },
    { phoneId: "phone-jonas", memberId: 2 },
  ],
  queue: [],
  head: null,
  lineUp: null,
  playing: null,
  results: null,
  localMics: [],
} as unknown as PartySnapshot;

const BO = { kind: "phone", phoneId: "phone-bo" } as const;
const JONAS = { kind: "phone", phoneId: "phone-jonas" } as const;

function Empty() {
  return <div />;
}
const STAND_INS = Object.fromEntries(
  Object.keys(SCENES).map((id) => [id, { component: Empty }]),
) as unknown as typeof SCENES;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json([]))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderStage() {
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
      <StageFrame
        store={store}
        scenes={STAND_INS}
        chooseScene={() => "songBrowser"}
      />
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
  const tell = (run: CalibrationRun | null) => {
    server({ type: "calibration", run });
  };
  return { sent, server, tell };
}

const dialog = () => screen.queryByRole("dialog", { name: "Calibrate mics" });

const CHECKLIST: CalibrationRun = {
  phase: "choosing",
  mics: [
    { mic: BO, chosen: true, ready: false },
    { mic: JONAS, chosen: true, ready: false },
  ],
};

describe("Calibrate mics on the Stage", () => {
  it("starts from the Setup pill with no Admin PIN, and opens once the server holds the run", () => {
    const { sent, tell } = renderStage();
    fireEvent.click(screen.getByRole("button", { name: "Setup" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Calibrate mics" }));
    expect(sent.at(-1)).toEqual({ type: "openCalibration" });
    expect(dialog()).toBeNull();

    tell(CHECKLIST);
    expect(dialog()).toBeInTheDocument();
  });

  it("lists every joined Phone by its member's name, ticked; ticks go to the server; nothing ticked cannot continue", () => {
    const { sent, tell } = renderStage();
    tell(CHECKLIST);
    const bo = screen.getByRole("checkbox", { name: "Bo" });
    const jonas = screen.getByRole("checkbox", { name: "Jonas" });
    expect(bo).toBeChecked();
    expect(jonas).toBeChecked();

    fireEvent.click(jonas);
    expect(sent.at(-1)).toEqual({
      type: "chooseCalibrationMic",
      mic: JONAS,
      chosen: false,
    });
    tell({
      phase: "choosing",
      mics: [
        { mic: BO, chosen: false, ready: false },
        { mic: JONAS, chosen: false, ready: false },
      ],
    });
    expect(screen.getByRole("checkbox", { name: "Jonas" })).not.toBeChecked();
    const before = sent.length;
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(sent.length).toBe(before);

    fireEvent.click(screen.getByRole("checkbox", { name: "Bo" }));
    expect(sent.at(-1)).toEqual({
      type: "chooseCalibrationMic",
      mic: BO,
      chosen: true,
    });
    tell({
      phase: "choosing",
      mics: [
        { mic: BO, chosen: true, ready: false },
        { mic: JONAS, chosen: false, ready: false },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(sent.at(-1)).toEqual({ type: "startCalibration" });
  });

  it("Cancel ends the run for everyone and closes it", () => {
    const { sent, tell } = renderStage();
    tell(CHECKLIST);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(sent.at(-1)).toEqual({ type: "endCalibration" });
    expect(dialog()).toBeNull();
  });

  it("shows each chosen Mic as waiting or ready, and Go starts the tones once one is ready", () => {
    const { sent, tell } = renderStage();
    tell({
      phase: "waiting",
      mics: [
        { mic: BO, chosen: true, ready: false },
        { mic: JONAS, chosen: true, ready: false },
      ],
    });
    const row = (name: string) =>
      within(screen.getByTestId("calibration-mics")).getByText(name)
        .parentElement as HTMLElement;
    expect(row("Bo")).toHaveTextContent("waiting");
    expect(row("Jonas")).toHaveTextContent("waiting");
    const before = sent.length;
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(sent.length).toBe(before);

    tell({
      phase: "waiting",
      mics: [
        { mic: BO, chosen: true, ready: true },
        { mic: JONAS, chosen: true, ready: false },
      ],
    });
    expect(row("Bo")).toHaveTextContent("ready");
    expect(row("Jonas")).toHaveTextContent("waiting");
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(sent.at(-1)).toEqual({ type: "calibrationGo" });
  });

  it("plays the tones on the Stage's gain chain when the server says they start, and stops them when the run ends", () => {
    const { tell } = renderStage();
    const before = fakeStageContext().oscillators.length;
    tell({ phase: "tones", mics: [{ mic: BO, chosen: true, ready: true }] });
    expect(screen.getByText(/stay quiet/)).toBeInTheDocument();
    // The tone run waits for the context to resume first.
    return act(async () => {
      await Promise.resolve();
    }).then(() => {
      const tones = fakeStageContext().oscillators.slice(before);
      expect(tones).toHaveLength(8);
      tell(null);
      expect(dialog()).toBeNull();
      for (const tone of tones) expect(tone.outputs).toEqual([]);
    });
  });

  it("shows one result row per Mic, with whole milliseconds, and Done closes it", () => {
    const { sent, tell } = renderStage();
    tell({
      phase: "results",
      mics: [
        {
          mic: BO,
          chosen: true,
          ready: true,
          outcome: { result: "calibrated", micDelayMs: 101.6 },
        },
        {
          mic: JONAS,
          chosen: true,
          ready: true,
          outcome: { result: "failed" },
        },
      ],
    });
    expect(screen.getByText("Bo · 102 ms ✓")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Jonas couldn't hear the Stage: move closer or turn the sound up",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(sent.at(-1)).toEqual({ type: "endCalibration" });
    expect(dialog()).toBeNull();
  });

  it("closes when the server ends the run, without ending it again", () => {
    const { sent, tell } = renderStage();
    tell(CHECKLIST);
    tell(null);
    expect(dialog()).toBeNull();
    expect(sent.some((m) => m.type === "endCalibration")).toBe(false);
  });
});
