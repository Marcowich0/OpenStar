import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { PhoneStorage } from "../../live/phoneId";
import type { PhoneMic, PhoneMicSnapshot } from "../mic/phoneMic";
import { quietDiagnostics } from "../mic/testPhoneMic";
import { PhonePageView } from "../PhoneScreen";
import {
  BO_SEAT,
  JONAS_SEAT,
  LINE_UP,
  MY_PHONE,
  PARTY,
  renderWithParty,
  stubFetch,
  stubFetchWith,
} from "../stage/testParty";
import {
  playerResult,
  songResults,
} from "../../stage/scenes/results/testResults";

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
    setThreshold: vi.fn(),
    diagnostics: quietDiagnostics,
    watchStage: vi.fn(),
    reopen: vi.fn(),
  } satisfies PhoneMic & Record<string, unknown>;
  return mic;
}

function renderPage(
  party: PartySnapshot,
  mic: ReturnType<typeof fakeMic> = fakeMic(),
  diagnostics = false,
) {
  const rendered = renderWithParty(party, (store) => (
    <PhonePageView
      joinCode={undefined}
      store={store}
      storage={memoryStorage()}
      mic={mic}
      diagnostics={diagnostics}
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
  // The diagnostics toggle is remembered in the browser's storage.
  localStorage.clear();
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

  it("shows a full-screen card naming a refused permission, and Try again opens the mic again", async () => {
    const mic = fakeMic("failed");
    mic.set({ blocked: "permissionRefused" });
    renderPage(PARTY, mic);
    const card = await screen.findByRole("region", {
      name: "Your mic is blocked",
    });
    expect(within(card).getByText("Permission refused")).toBeTruthy();
    // The full-screen card replaces the avatar and the level ring.
    expect(screen.queryByTestId("level-ring")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    expect(mic.turnOn).toHaveBeenCalledTimes(1);
    // Once the mic opens, the card goes.
    mic.set({ state: "on", blocked: null });
    expect(
      screen.queryByRole("region", { name: "Your mic is blocked" }),
    ).toBeNull();
    expect(screen.getByText("Sing a note to check")).toBeTruthy();
  });

  it("names an address that isn't HTTPS", async () => {
    const mic = fakeMic("failed");
    mic.set({ blocked: "noHttps" });
    renderPage(PARTY, mic);
    const card = await screen.findByRole("region", {
      name: "Your mic is blocked",
    });
    expect(within(card).getByText("This address isn't HTTPS")).toBeTruthy();
  });

  it("says the mic stopped and the Song kept going after the page was hidden, and Sing again reopens it", async () => {
    const mic = fakeMic("lost");
    renderPage(PLAYING, mic);
    expect(
      await screen.findByRole("heading", { name: "Your mic stopped" }),
    ).toBeTruthy();
    expect(screen.getByText(/The song kept going/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sing again" }));
    expect(mic.singAgain).toHaveBeenCalledTimes(1);
    mic.set({ state: "on" });
    expect(screen.getByRole("heading", { name: "Sing it!" })).toBeTruthy();
  });

  it("offers Turn on my mic for a mic lost before Start, which reopens it", async () => {
    const mic = fakeMic("lost");
    renderPage(PARTY, mic);
    fireEvent.click(
      await screen.findByRole("button", { name: "Turn on my mic" }),
    );
    expect(mic.singAgain).toHaveBeenCalledTimes(1);
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

  it("sets this Phone's own Mic threshold by hand from the mic check's slider", async () => {
    stubFetchWith((url) =>
      url.pathname === "/api/mic-settings"
        ? Response.json({
            stageOutput: url.searchParams.get("stageOutput"),
            mics: [],
          })
        : undefined,
    );
    const { sent, server } = renderPage(PARTY, fakeMic("on"));
    server({
      type: "volume",
      volume: 80,
      stepped: false,
      stageOutput: "Speakers",
    });
    const slider = await screen.findByRole("slider", { name: /Mic threshold/ });
    // An uncalibrated Phone's default.
    expect(slider).toHaveValue("-30");
    await waitFor(() => {
      expect(slider).toBeEnabled();
    });
    expect(screen.getByText(/Default: not calibrated/)).toBeTruthy();
    fireEvent.change(slider, { target: { value: "-38" } });
    // Shown at once (kept in the query's cache), sent once the slider rests.
    await waitFor(() => {
      expect(slider).toHaveValue("-38");
    });
    expect(screen.getByText(/Set by hand/)).toBeTruthy();
    expect(sent.some((m) => m.type === "setPhoneMicThreshold")).toBe(false);
    await waitFor(() => {
      expect(sent).toContainEqual({
        type: "setPhoneMicThreshold",
        stageOutput: "Speakers",
        phoneId: MY_PHONE,
        referenceDbfs: -38,
      });
    });
  });

  it("opens the mic diagnostics from their toggle, asking the Stage what it receives", async () => {
    const mic = fakeMic("on");
    renderPage(PARTY, mic);
    fireEvent.click(
      await screen.findByRole("button", { name: "Show mic diagnostics" }),
    );
    const panel = screen.getByRole("region", { name: "Mic diagnostics" });
    expect(within(panel).getByText("Audio buffer and worklet")).toBeTruthy();
    expect(within(panel).getByText("no answer from the Stage")).toBeTruthy();
    expect(mic.watchStage).toHaveBeenLastCalledWith(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Hide mic diagnostics" }),
    );
    expect(
      screen.queryByRole("region", { name: "Mic diagnostics" }),
    ).toBeNull();
    expect(mic.watchStage).toHaveBeenLastCalledWith(false);
  });

  it("shows the Player no diagnostics", async () => {
    renderPage(PARTY, fakeMic("on"));
    await screen.findByText("Sing a note to check");
    expect(screen.queryByTestId("phone-mic-diagnostics")).toBeNull();
    expect(screen.queryByText(/readings\/s/)).toBeNull();
  });

  it("shows readings per second and the detector's cost with ?perf", async () => {
    renderPage(PARTY, fakeMic("on"), true);
    expect(
      await screen.findByTestId("phone-mic-diagnostics"),
    ).toHaveTextContent("0 readings/s");
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

  it("opens the Me sheet's screens from the Remote on top of the takeover", async () => {
    renderPage(PARTY, fakeMic("on"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Queue & controls" }),
    );
    const openMe = async () => {
      fireEvent.click(await screen.findByRole("button", { name: /^Me/ }));
      return screen.getByRole("dialog", { name: "Me" });
    };
    fireEvent.click(
      within(await openMe()).getByRole("button", {
        name: "Someone else is using this phone",
      }),
    );
    expect(screen.getByRole("list", { name: "Who's singing?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("tablist")).toBeTruthy();

    fireEvent.click(
      within(await openMe()).getByRole("button", {
        name: "Change name, look or colour",
      }),
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("tablist")).toBeTruthy();
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

/** The results of Valerie (Request 1): Bo sang on this Phone. */
const BO_RESULT = playerResult({
  memberId: 1,
  name: "Bo",
  colour: "cherry",
  mic: { kind: "phone", phoneId: MY_PHONE },
  total: 6420,
  rankTitleBand: 5,
  newHighScore: true,
});
const RESULTS: PartySnapshot = {
  ...PARTY,
  head: null,
  lineUp: null,
  queue: [],
  results: songResults([BO_RESULT], { songId: 40 }),
};

describe("after the Song", () => {
  it("shows the Player's own Score, Rank title and New high score! until Done", async () => {
    renderPage(RESULTS, fakeMic("on"));
    const screenAfter = await screen.findByRole("main", {
      name: "After the Song",
    });
    expect(screenAfter.style.backgroundColor).toBe("var(--color-party-cherry)");
    expect(within(screenAfter).getByTestId("after-score").textContent).toBe(
      "6420",
    );
    expect(within(screenAfter).getByText("Headliner")).toBeTruthy();
    expect(within(screenAfter).getByText("New high score!")).toBeTruthy();
    expect(within(screenAfter).queryByText("Ended early")).toBeNull();
    expect(await within(screenAfter).findByText("Valerie")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("marks a Player who did not finish as Ended early, with no badge", async () => {
    const ended = {
      ...RESULTS,
      results: songResults(
        [{ ...BO_RESULT, unfinished: true, newHighScore: false }],
        { songId: 40, ended: "ended" },
      ),
    };
    renderPage(ended, fakeMic("on"));
    const screenAfter = await screen.findByRole("main", {
      name: "After the Song",
    });
    expect(within(screenAfter).getByText("Ended early")).toBeTruthy();
    expect(within(screenAfter).queryByText("New high score!")).toBeNull();
  });

  it("Done returns to the Remote's Stage tab", async () => {
    const { mic } = renderPage(RESULTS, fakeMic("on"));
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    expect(screen.queryByRole("main", { name: "After the Song" })).toBeNull();
    expect(
      screen.getByRole("tab", { name: "Stage", selected: true }),
    ).toBeTruthy();
    // The mic stays held for a next Line-up that seats this Phone.
    expect(mic.turnOff).not.toHaveBeenCalled();
  });

  it("opens the Stage tab once after Done: a Remote opened again later picks its tab as usual", async () => {
    renderPage(RESULTS, fakeMic("on"));
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    expect(
      screen.getByRole("tab", { name: "Stage", selected: true }),
    ).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /^Me/ }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Me" })).getByRole("button", {
        name: "Change name, look or colour",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    // No Line-up waits: a Remote opens on Songs.
    expect(
      screen.getByRole("tab", { name: "Songs", selected: true }),
    ).toBeTruthy();
  });

  it("shows the result to a Phone back after the Song while the Stage is on the results", async () => {
    renderPage(RESULTS, fakeMic("lost"));
    expect(
      await screen.findByRole("main", { name: "After the Song" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sing again" })).toBeNull();
  });

  it("shows the Remote to a Phone back once the Stage has left the results", async () => {
    renderPage({ ...RESULTS, results: null }, fakeMic("lost"));
    expect(await screen.findByRole("tablist")).toBeTruthy();
    expect(screen.queryByRole("main", { name: "After the Song" })).toBeNull();
  });

  it("closes the Remote on top when the Song's results arrive, so the result shows", async () => {
    const { server } = renderPage(PLAYING, fakeMic("on"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Queue & controls" }),
    );
    expect(screen.getByRole("tablist")).toBeTruthy();
    server({
      type: "partyChanged",
      party: { ...RESULTS, playing: null },
      change: { actor: { kind: "stage" }, event: { code: "lineUpChanged" } },
    });
    expect(screen.getByRole("main", { name: "After the Song" })).toBeTruthy();
  });
});
