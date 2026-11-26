import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  JONAS_SEAT,
  LINE_UP,
  MY_PHONE,
  PARTY,
  renderWithParty,
} from "../stage/testParty";
import type { PhoneMic, PhoneMicSnapshot } from "./phoneMic";
import { PhoneMicCard } from "./PhoneMicCard";

function fakeMic(): PhoneMic & { set: (s: Partial<PhoneMicSnapshot>) => void } {
  let snapshot: PhoneMicSnapshot = {
    state: "off",
    readingsPerSecond: 0,
    detector: null,
  };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    turnOn: vi.fn(),
    turnOff: vi.fn(),
    set(next) {
      snapshot = { ...snapshot, ...next };
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

describe("the Phone's mic card", () => {
  it("offers Turn on my mic while this Phone is a seat's Mic, and the tap turns it on", () => {
    const mic = fakeMic();
    renderWithParty(PARTY, (store) => (
      <PhoneMicCard store={store} myPhoneId={MY_PHONE} mic={mic} />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Turn on my mic" }));
    expect(mic.turnOn).toHaveBeenCalledTimes(1);
  });

  it("is not there while this Phone is no seat's Mic", () => {
    const mic = fakeMic();
    renderWithParty(
      { ...PARTY, lineUp: { ...LINE_UP, seats: [JONAS_SEAT] } },
      (store) => <PhoneMicCard store={store} myPhoneId={MY_PHONE} mic={mic} />,
    );
    expect(screen.queryByRole("button", { name: "Turn on my mic" })).toBeNull();
  });

  it("shows readings per second and the detector's cost while the mic is on", () => {
    const mic = fakeMic();
    renderWithParty(PARTY, (store) => (
      <PhoneMicCard store={store} myPhoneId={MY_PHONE} mic={mic} />
    ));
    mic.set({ state: "on", readingsPerSecond: 93 });
    expect(screen.getByText("Mic is on")).toBeInTheDocument();
    expect(screen.getByText("93 readings/s")).toBeInTheDocument();
    expect(screen.getByText("Detector: measuring")).toBeInTheDocument();
    mic.set({ detector: { windows: 200, p50Ms: 0.4123, p95Ms: 0.987 } });
    expect(
      screen.getByText("Detector 0.41 ms p50, 0.99 ms p95"),
    ).toBeInTheDocument();
  });

  it("offers Try again when the mic did not open", () => {
    const mic = fakeMic();
    renderWithParty(PARTY, (store) => (
      <PhoneMicCard store={store} myPhoneId={MY_PHONE} mic={mic} />
    ));
    mic.set({ state: "failed" });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mic.turnOn).toHaveBeenCalledTimes(1);
  });
});
