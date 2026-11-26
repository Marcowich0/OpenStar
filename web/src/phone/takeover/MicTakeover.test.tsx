import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { PhoneStorage } from "../../live/phoneId";
import type { PhoneMic, PhoneMicSnapshot } from "../mic/phoneMic";
import { PhonePageView } from "../PhoneScreen";
import {
  BO_SEAT,
  JONAS_SEAT,
  LINE_UP,
  MY_PHONE,
  PARTY,
  renderWithParty,
  stubFetch,
} from "../stage/testParty";

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
    readingsPerSecond: 0,
    detector: null,
  };
  const listeners = new Set<() => void>();
  const levels = new Set<(dbfs: number) => void>();
  const mic = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    turnOn: vi.fn(),
    turnOff: vi.fn(),
    singAgain: vi.fn(),
    onLevel: (listener: (dbfs: number) => void) => {
      levels.add(listener);
      return () => levels.delete(listener);
    },
    set(next: Partial<PhoneMicSnapshot>) {
      snapshot = { ...snapshot, ...next };
      act(() => {
        for (const listener of listeners) listener();
      });
    },
    level(dbfs: number) {
      for (const listener of levels) listener(dbfs);
    },
  } satisfies PhoneMic & Record<string, unknown>;
  return mic;
}

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
  return { ...rendered, mic };
}

const PLAYING: PartySnapshot = {
  ...PARTY,
  playing: { requestId: 1, songId: 40, paused: false },
};

const takeover = () => screen.getByRole("main", { name: "Your mic" });

beforeEach(() => {
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the mic takeover", () => {
  it("replaces the Remote while this Phone is a seat's Mic: You're up, and the tap turns the mic on", async () => {
    const { mic } = renderPage(PARTY);
    expect(
      await screen.findByRole("heading", { name: "You're up, Bo!" }),
    ).toBeTruthy();
    expect(
      await screen.findByText("Valerie is next. This phone is your mic"),
    ).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    // In the seated Player's Party colour.
    expect(takeover().style.backgroundColor).toBe("var(--color-party-cherry)");
    expect(within(takeover()).getByText("Mic · Bo")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn on my mic" }));
    expect(mic.turnOn).toHaveBeenCalledTimes(1);
  });

  it("is in the seated Player's colour when this Phone is someone else's Mic", async () => {
    const sara = { ...BO_SEAT, memberId: 3 };
    renderPage({ ...PARTY, lineUp: { ...LINE_UP, seats: [sara] } });
    expect(
      await screen.findByRole("heading", { name: "You're up, Sara!" }),
    ).toBeTruthy();
    expect(takeover().style.backgroundColor).toBe("var(--color-party-lime)");
  });

  it("shows the level meter and Start once the mic is on; Start is the Line-up's", async () => {
    const { sent } = renderPage(PARTY, fakeMic("on"));
    expect(await screen.findByText("Sing a note to check")).toBeTruthy();
    expect(
      screen.getByText("Keep this screen open while you sing"),
    ).toBeTruthy();
    expect(screen.getByRole("img", { name: "Mic level" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(sent).toContainEqual({
      type: "controlSong",
      requestId: 1,
      control: "start",
    });
  });

  it("keeps Start disabled while the Line-up is invalid", async () => {
    const { sent } = renderPage(
      { ...PARTY, lineUp: { ...LINE_UP, canStart: false } },
      fakeMic("on"),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    expect(sent.some((m) => m.type === "controlSong")).toBe(false);
  });

  it("moves the ring with the sung level", async () => {
    const { mic } = renderPage(PARTY, fakeMic("on"));
    const ring = await screen.findByTestId("level-ring");
    mic.level(-12);
    expect(ring.style.getPropertyValue("--level")).toBe("1");
    mic.level(-60);
    expect(ring.style.getPropertyValue("--level")).toBe("0");
  });

  it("while singing shows Sing it!, the title, the Score from each Line end and the progress", async () => {
    const { server } = renderPage(PLAYING, fakeMic("on"));
    expect(
      await screen.findByRole("heading", { name: "Sing it!" }),
    ).toBeTruthy();
    expect(await screen.findByText("Valerie")).toBeTruthy();
    expect(
      screen.getByRole("progressbar", { name: "Song progress" }),
    ).toBeTruthy();
    expect(screen.getByText("Screen stays on while you sing")).toBeTruthy();
    server({ type: "lineScore", requestId: 1, total: 2350 });
    expect(screen.getByText("2350")).toBeTruthy();
  });

  it("offers Turn on my mic when the Song started without it, then goes straight to Singing", async () => {
    const mic = fakeMic("off");
    renderPage(PLAYING, mic);
    fireEvent.click(
      await screen.findByRole("button", { name: "Turn on my mic" }),
    );
    expect(mic.turnOn).toHaveBeenCalled();
    mic.set({ state: "on" });
    expect(screen.getByText("Screen stays on while you sing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  });

  it("shows why the mic is blocked, with Try again", async () => {
    const mic = fakeMic("failed");
    mic.set({ blocked: "permissionRefused" });
    renderPage(PARTY, mic);
    expect(await screen.findByText("The mic did not open")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mic.turnOn).toHaveBeenCalled();
  });

  it("says the mic stopped after the page was hidden, with Sing again", async () => {
    const mic = fakeMic("lost");
    renderPage(PLAYING, mic);
    fireEvent.click(await screen.findByRole("button", { name: "Sing again" }));
    expect(mic.singAgain).toHaveBeenCalled();
  });

  it("names the Voice in a duet only", async () => {
    renderPage({ ...PARTY, lineUp: { ...LINE_UP, duet: true } });
    expect(
      await screen.findByRole("button", {
        name: /Voice 1 · Medium/,
      }),
    ).toBeTruthy();
  });

  it("sets this Phone's own Difficulty from the chip, as the Me sheet does", async () => {
    const { sent } = renderPage(PARTY);
    fireEvent.click(await screen.findByRole("button", { name: /Medium/ }));
    fireEvent.click(await screen.findByRole("radio", { name: "Hard" }));
    expect(sent).toContainEqual({
      type: "setMyDifficulty",
      difficulty: "hard",
    });
  });

  it("sets the seat's Difficulty when the seated Player is someone else", async () => {
    const sara = { ...BO_SEAT, memberId: 3 };
    const { sent } = renderPage({
      ...PARTY,
      lineUp: { ...LINE_UP, seats: [JONAS_SEAT, sara] },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Medium/ }));
    fireEvent.click(await screen.findByRole("radio", { name: "Easy" }));
    expect(sent).toContainEqual({
      type: "editLineUp",
      requestId: 1,
      edit: { kind: "setDifficulty", seat: 1, difficulty: "easy" },
    });
  });

  it("locks the Difficulty once the Song started", async () => {
    renderPage(PLAYING, fakeMic("on"));
    await screen.findByRole("heading", { name: "Sing it!" });
    expect(screen.queryByRole("button", { name: /Medium/ })).toBeNull();
    expect(within(takeover()).getByText("Medium")).toBeTruthy();
  });

  it("opens the Remote on top with Queue & controls, and Back to my mic returns", async () => {
    renderPage(PARTY, fakeMic("on"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Queue & controls" }),
    );
    expect(screen.getByRole("tablist")).toBeTruthy();
    expect(screen.queryByRole("main", { name: "Your mic" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to my mic" }));
    expect(takeover()).toBeTruthy();
  });

  it("shows the Party's toasts too", async () => {
    const { server } = renderPage(PARTY, fakeMic("on"));
    await screen.findByText("Sing a note to check");
    server({
      type: "partyChanged",
      party: PARTY,
      change: {
        actor: { kind: "stage" },
        event: { code: "lineUpChanged" },
      },
    });
    expect(screen.getByRole("status", { name: "Party changes" })).toBeTruthy();
  });

  it("returns to the Remote when this Phone is taken off the Song", async () => {
    const { lineUpChanged } = renderPage(PARTY, fakeMic("on"));
    await screen.findByText("Sing a note to check");
    lineUpChanged({ ...LINE_UP, seats: [JONAS_SEAT] });
    expect(screen.queryByRole("main", { name: "Your mic" })).toBeNull();
    expect(screen.getByRole("tablist")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to my mic" })).toBeNull();
  });
});
