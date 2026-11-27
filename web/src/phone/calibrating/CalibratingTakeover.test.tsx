import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CalibrationRun } from "../../generated/CalibrationRun";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { PhoneStorage } from "../../live/phoneId";
import { followLineUp } from "../mic/micLineUp";
import type { PhoneMic, PhoneMicSnapshot } from "../mic/phoneMic";
import { PhonePageView } from "../PhoneScreen";
import {
  MY_PHONE,
  PARTY,
  renderWithParty,
  stubFetch,
} from "../stage/testParty";
import { TONES_RUN_MS } from "./calibrating";

function memoryStorage(): PhoneStorage {
  const items = new Map([["openstar.phoneId", MY_PHONE]]);
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

function fakeMic(state: PhoneMicSnapshot["state"] = "off") {
  let snapshot: PhoneMicSnapshot = {
    state,
    blocked: null,
    synced: state === "on",
    readingsPerSecond: 0,
    detector: null,
  };
  const listeners = new Set<() => void>();
  const mic = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    turnOn: vi.fn(),
    turnOff: vi.fn(),
    singAgain: vi.fn(),
    onLevel: () => () => {},
    set(next: Partial<PhoneMicSnapshot>) {
      snapshot = { ...snapshot, ...next };
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  } satisfies PhoneMic & Record<string, unknown>;
  return mic;
}

const ME = { kind: "phone", phoneId: MY_PHONE } as const;
const JONAS = { kind: "phone", phoneId: "jonas-phone" } as const;

const run = (
  phase: CalibrationRun["phase"],
  ready = false,
): CalibrationRun => ({
  phase,
  mics: [ME, JONAS].map((mic) => ({ mic, chosen: true, ready })),
});

/** The Song browser: no Line-up, so this Phone shows the Remote. */
const BROWSING: PartySnapshot = { ...PARTY, head: null, lineUp: null };

function renderPage(
  party: PartySnapshot,
  mic: ReturnType<typeof fakeMic> = fakeMic(),
) {
  const rendered = renderWithParty(party, (store) => (
    <PhonePageView
      joinCode={undefined}
      store={store}
      storage={memoryStorage()}
      mic={mic}
    />
  ));
  const calibration = (next: CalibrationRun | null) => {
    rendered.server({ type: "calibration", run: next });
  };
  return { ...rendered, mic, calibration };
}

const takeover = () => screen.getByRole("main", { name: "Calibrating" });
const queryTakeover = () => screen.queryByRole("main", { name: "Calibrating" });
const micTakeover = () => screen.queryByRole("main", { name: "Your mic" });

beforeEach(() => {
  stubFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the Calibrating takeover", () => {
  it("covers the Remote of a chosen Phone in its Party colour, with I'm listening", () => {
    const { calibration } = renderPage(BROWSING);
    expect(screen.getByRole("tablist")).toBeTruthy();
    calibration(run("choosing"));
    expect(queryTakeover()).toBeNull();

    calibration(run("waiting"));
    expect(takeover().style.backgroundColor).toBe("var(--color-party-cherry)");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("heading", { name: "Calibrating" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "I'm listening" })).toBeTruthy();
  });

  it("covers the Remote that started the run from its Stage tab once its Phone is chosen", () => {
    const { calibration, sent } = renderPage({
      ...BROWSING,
      queue: [],
    });
    fireEvent.click(screen.getByRole("tab", { name: "Stage" }));
    fireEvent.click(screen.getByRole("button", { name: "Calibrate mics" }));
    expect(sent.at(-1)).toEqual({ type: "openCalibration" });

    calibration(run("choosing"));
    expect(queryTakeover()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(sent.at(-1)).toEqual({ type: "startCalibration" });

    calibration(run("waiting"));
    expect(takeover()).toBeTruthy();
    expect(screen.getByRole("button", { name: "I'm listening" })).toBeTruthy();
  });

  it("covers the mic takeover of a seated Phone", async () => {
    const { calibration } = renderPage(PARTY);
    expect(
      await screen.findByRole("heading", { name: "You're up, Bo!" }),
    ).toBeTruthy();
    calibration(run("waiting"));
    expect(takeover()).toBeTruthy();
    expect(micTakeover()).toBeNull();
  });

  it("I'm listening opens the mic as for singing, then tells the server the Mic is ready", () => {
    const { calibration, mic, sent, server } = renderPage(BROWSING);
    calibration(run("waiting"));
    fireEvent.click(screen.getByRole("button", { name: "I'm listening" }));
    expect(mic.turnOn).toHaveBeenCalledTimes(1);
    mic.set({ state: "opening" });
    expect(screen.getByText("Opening the mic…")).toBeTruthy();
    expect(sent).not.toContainEqual({ type: "calibrationListening" });

    // Open, but with no offset to the Stage's clock yet: not ready.
    mic.set({ state: "on", synced: false });
    expect(sent).not.toContainEqual({ type: "calibrationListening" });
    mic.set({ synced: true });
    expect(sent).toContainEqual({ type: "calibrationListening" });
    server({ type: "calibration", run: run("waiting", true) });
    expect(screen.getByText("Ready. Waiting for the others…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "I'm listening" })).toBeNull();
  });

  it("a mic already open for the Line-up says it is listening at the tap", () => {
    const { calibration, mic, sent } = renderPage(PARTY, fakeMic("on"));
    calibration(run("waiting"));
    fireEvent.click(screen.getByRole("button", { name: "I'm listening" }));
    expect(mic.turnOn).not.toHaveBeenCalled();
    expect(sent.filter((m) => m.type === "calibrationListening")).toHaveLength(
      1,
    );
  });

  it("sends nothing when the mic does not open, and says why with Try again", () => {
    const { calibration, mic, sent } = renderPage(BROWSING);
    calibration(run("waiting"));
    fireEvent.click(screen.getByRole("button", { name: "I'm listening" }));
    mic.set({ state: "opening" });
    mic.set({ state: "failed", blocked: "permissionRefused" });
    expect(sent).not.toContainEqual({ type: "calibrationListening" });
    expect(takeover().dataset.step).toBe("blocked");
    expect(screen.getByText(/allow the microphone/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mic.turnOn).toHaveBeenCalledTimes(2);
    mic.set({ state: "on", blocked: null, synced: true });
    expect(sent).toContainEqual({ type: "calibrationListening" });
  });

  it("shows the run's progress during the tones and asks the Player to stay quiet", () => {
    vi.useFakeTimers();
    const { calibration } = renderPage(BROWSING, fakeMic("on"));
    calibration(run("waiting", true));
    calibration(run("tones", true));
    expect(screen.getByText("Please stay quiet and hold still")).toBeTruthy();
    const bar = screen.getByRole("progressbar", { name: "Calibrating" });
    expect(Number(bar.getAttribute("aria-valuenow"))).toBe(0);
    act(() => {
      vi.advanceTimersByTime(TONES_RUN_MS / 2);
    });
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeCloseTo(50, -1);
    act(() => {
      vi.advanceTimersByTime(TONES_RUN_MS);
    });
    expect(Number(bar.getAttribute("aria-valuenow"))).toBe(100);
  });

  it("returns to what the Phone showed before once the results show", async () => {
    const browsing = renderPage(BROWSING, fakeMic("on"));
    browsing.calibration(run("tones", true));
    browsing.calibration({
      ...run("results", true),
      mics: run("results", true).mics.map((m) => ({
        ...m,
        outcome: { result: "calibrated", micDelayMs: 98 },
      })),
    });
    expect(queryTakeover()).toBeNull();
    expect(screen.getByRole("tablist")).toBeTruthy();
    browsing.view.unmount();

    const seated = renderPage(PARTY, fakeMic("on"));
    seated.calibration(run("tones", true));
    seated.calibration(run("results", true));
    expect(queryTakeover()).toBeNull();
    expect(
      await screen.findByRole("heading", { name: "Mic is on" }),
    ).toBeTruthy();
  });

  it("closes on Cancel before the tones, a Stage drop or a server restart", () => {
    const { calibration, server } = renderPage(BROWSING);
    // Cancel, or the Stage closing: the server ends the run.
    calibration(run("waiting"));
    expect(takeover()).toBeTruthy();
    calibration(null);
    expect(queryTakeover()).toBeNull();
    expect(screen.getByRole("tablist")).toBeTruthy();

    // A restarted server holds no run: the new connection's live state has
    // none and no Calibration message follows it.
    calibration(run("waiting"));
    server({
      type: "liveState",
      stageId: "main",
      party: BROWSING,
      isStage: false,
    });
    expect(queryTakeover()).toBeNull();
  });
});

describe("the mic after a Calibration run", () => {
  function follow(party: PartySnapshot) {
    const mic = fakeMic("on");
    const rendered = renderPage(party, mic);
    const stop = followLineUp(rendered.store, MY_PHONE, mic);
    return { ...rendered, mic, stop };
  }

  it("is released when the run ends on a Phone that is not seated", () => {
    const { calibration, mic, stop } = follow(BROWSING);
    calibration(run("waiting", true));
    calibration(run("tones", true));
    expect(mic.turnOff).not.toHaveBeenCalled();
    calibration(run("results", true));
    expect(mic.turnOff).toHaveBeenCalled();
    stop();
  });

  it("stays open on a Phone seated in the Line-up", () => {
    const { calibration, mic, stop } = follow(PARTY);
    calibration(run("tones", true));
    calibration(run("results", true));
    calibration(null);
    expect(mic.turnOff).not.toHaveBeenCalled();
    stop();
  });
});
