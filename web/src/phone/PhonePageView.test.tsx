import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../api/queryClient";
import type { ClientMessage } from "../generated/ClientMessage";
import type { PartySnapshot } from "../generated/PartySnapshot";
import type { Profile } from "../generated/Profile";
import type { ServerMessage } from "../generated/ServerMessage";
import type { LiveClientOptions } from "../live/liveClient";
import { createLiveStore } from "../live/liveStore";
import type { PhoneStorage } from "../live/phoneId";
import { PhonePageView } from "./PhoneScreen";

const PHONE_ID = "phone-a";

function profile(id: number, name: string, lastSungAt: number | null): Profile {
  return {
    id,
    name,
    avatar: { kind: "builtIn", key: "star" },
    favouriteColour: "cherry",
    lastDifficulty: "medium",
    createdAt: 0,
    lastSungAt,
  };
}

const PROFILES = [
  profile(1, "Ada", null),
  profile(2, "Bo", 500),
  profile(3, "Lukas", 900),
];

function party(
  members: [memberId: number, profileId: number][],
): PartySnapshot {
  return {
    partyId: "p1",
    stageId: "main",
    joinCode: "4821",
    startedAtMs: 1,
    members: members.map(([memberId, profileId]) => ({
      memberId,
      identity: { kind: "profile", profileId },
      colour: memberId === 1 ? "navy" : "sky",
      favouriteTaken: false,
      onPhone: true,
    })),
    phones: [],
    queue: [],
    head: null,
    lineUp: null,
  };
}

function memoryStorage(initial: Record<string, string> = {}): PhoneStorage & {
  items: Map<string, string>;
} {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

/** Renders the Phone page with a live store whose server the test plays. */
function renderPhone({
  joinCode,
  storage = memoryStorage({ "openstar.phoneId": PHONE_ID }),
}: { joinCode?: string; storage?: PhoneStorage } = {}) {
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  const sent: ClientMessage[] = [];
  const store = createLiveStore(
    (given) => {
      handlers = given;
      return {
        send: (message) => {
          sent.push(message);
          return true;
        },
        close: () => {},
      };
    },
    () => ({ type: "hello", phoneId: PHONE_ID }),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <PhonePageView joinCode={joinCode} store={store} storage={storage} />
    </QueryClientProvider>,
  );
  const server = (...messages: ServerMessage[]) => {
    act(() => {
      for (const message of messages) handlers?.onMessage(message);
    });
  };
  /** The socket opens, the Stage's Party arrives and the Phone id is answered. */
  const connect = (memberId: number | null, snapshot = party([])) => {
    act(() => {
      handlers?.onConnection("open");
    });
    server(
      { type: "liveState", stageId: "main", party: snapshot, isStage: false },
      { type: "phoneStatus", memberId },
    );
  };
  return { sent, server, connect, storage };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json(PROFILES))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function typeCode(code: string) {
  for (const digit of code) {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: digit }));
      await Promise.resolve();
    });
  }
}

describe("the Phone page's join flow", () => {
  it("asks for the Join code on the number pad when the address was typed", () => {
    const { connect } = renderPhone();
    connect(null);

    expect(
      screen.getByRole("heading", { name: "Join the Party" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Type the 4 numbers shown on the Stage, under the QR code",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("code-box")).toHaveLength(4);
  });

  it("shows no pad before the server has answered the Phone id", () => {
    renderPhone();
    expect(screen.queryByTestId("code-box")).toBeNull();
  });

  it("refuses a wrong code typed on the pad", async () => {
    const { connect, sent, server } = renderPhone();
    connect(null);

    await typeCode("1111");
    expect(sent).toContainEqual({ type: "checkJoinCode", joinCode: "1111" });
    server({ type: "rejected", reason: { code: "joinCodeWrong" } });

    expect(
      await screen.findByText("That code is not on the Stage"),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("code-box")).toHaveLength(4);
  });

  it("goes on to Who's singing? once the typed code is confirmed", async () => {
    const { connect, server } = renderPhone();
    connect(null);

    await typeCode("4821");
    server({ type: "joinCodeValid", joinCode: "4821" });

    expect(
      await screen.findByRole("heading", { name: "Who's singing?" }),
    ).toBeInTheDocument();
  });

  it("goes straight to Who's singing? from the QR link with the current code", async () => {
    const { connect, sent, server } = renderPhone({ joinCode: "4821" });
    connect(null);

    expect(sent).toContainEqual({ type: "checkJoinCode", joinCode: "4821" });
    expect(screen.queryByTestId("code-box")).toBeNull();
    server({ type: "joinCodeValid", joinCode: "4821" });

    expect(
      await screen.findByRole("heading", { name: "Who's singing?" }),
    ).toBeInTheDocument();
  });

  it("shows the pad with the refusal for a QR link with another code", async () => {
    const { connect, server } = renderPhone({ joinCode: "1111" });
    connect(null);
    server({ type: "rejected", reason: { code: "joinCodeWrong" } });

    expect(
      await screen.findByText("That code is not on the Stage"),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("code-box")).toHaveLength(4);
  });

  it("lists every Profile in order, marks those here, then New Profile and I'm a Guest", async () => {
    const { connect, server } = renderPhone({ joinCode: "4821" });
    connect(null, party([[1, 2]]));
    server({ type: "joinCodeValid", joinCode: "4821" });

    const grid = await screen.findByRole("list", { name: "Who's singing?" });
    const entries = Array.from(grid.querySelectorAll("li"));
    expect(entries.map((li) => li.textContent)).toEqual([
      "Lukas",
      "Bohere",
      "Ada",
    ]);
    // Each entry draws its avatar beside the name, which already labels it.
    for (const li of entries)
      expect(li.querySelector('[role="img"]')).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "New Profile" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "I'm a Guest" }),
    ).toBeInTheDocument();
  });

  it("joins as the picked Profile, remembers it and opens the Remote", async () => {
    const storage = memoryStorage({ "openstar.phoneId": PHONE_ID });
    const { connect, server, sent } = renderPhone({
      joinCode: "4821",
      storage,
    });
    connect(null);
    server({ type: "joinCodeValid", joinCode: "4821" });

    fireEvent.click(await screen.findByRole("button", { name: /^Ada/ }));
    expect(sent).toContainEqual({
      type: "join",
      phoneId: PHONE_ID,
      joinCode: "4821",
      joinAs: { kind: "profile", profileId: 1 },
    });
    server(
      { type: "phoneStatus", memberId: 1 },
      {
        type: "partyChanged",
        party: party([[1, 1]]),
        change: {
          actor: { kind: "member", memberId: 1 },
          event: {
            code: "memberJoined",
            params: { memberId: 1, name: "Ada", colour: "navy" },
          },
        },
      },
    );

    expect(
      await screen.findByRole("tab", { name: "Songs" }),
    ).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(storage.items.get("openstar.profileId")).toBe("1");
    });
  });

  it("offers a remembered Profile with one big button, and Someone else opens the grid", async () => {
    const { connect, server, sent } = renderPhone({
      joinCode: "4821",
      storage: memoryStorage({
        "openstar.phoneId": PHONE_ID,
        "openstar.profileId": "2",
      }),
    });
    connect(null);
    server({ type: "joinCodeValid", joinCode: "4821" });

    const imBo = await screen.findByRole("button", { name: "I'm Bo" });
    expect(screen.getByRole("img", { name: "Bo" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Who's singing?" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Someone else" }));
    expect(
      screen.getByRole("list", { name: "Who's singing?" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Bo/ }));
    expect(sent).toContainEqual({
      type: "join",
      phoneId: PHONE_ID,
      joinCode: "4821",
      joinAs: { kind: "profile", profileId: 2 },
    });
    expect(imBo).not.toBeInTheDocument();
  });

  it("shows the grid when the remembered Profile no longer exists", async () => {
    const { connect, server } = renderPhone({
      joinCode: "4821",
      storage: memoryStorage({
        "openstar.phoneId": PHONE_ID,
        "openstar.profileId": "99",
      }),
    });
    connect(null);
    server({ type: "joinCodeValid", joinCode: "4821" });

    expect(
      await screen.findByRole("list", { name: "Who's singing?" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Someone else" })).toBeNull();
  });

  it("goes back to the pad when the code changed before the pick", async () => {
    const { connect, server } = renderPhone({ joinCode: "4821" });
    connect(null);
    server({ type: "joinCodeValid", joinCode: "4821" });

    fireEvent.click(await screen.findByRole("button", { name: /^Ada/ }));
    server({ type: "rejected", reason: { code: "joinCodeWrong" } });

    expect(
      await screen.findByText("That code is not on the Stage"),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("code-box")).toHaveLength(4);
  });
});

describe("the Remote", () => {
  it("opens with no code and no tap for a Phone already in the Party", async () => {
    const { connect, sent } = renderPhone({ joinCode: "4821" });
    connect(1, party([[1, 2]]));

    expect(screen.queryByTestId("code-box")).toBeNull();
    expect(sent).not.toContainEqual(
      expect.objectContaining({ type: "checkJoinCode" }),
    );
    expect(screen.getByText("OpenStar")).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Bo" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Songs",
      "Queue",
      "Stage",
      "People",
    ]);
  });

  it("shows the pad again after the Party ends for this Phone", () => {
    const { connect, server } = renderPhone();
    connect(1, party([[1, 2]]));
    server({ type: "leftParty" });

    expect(screen.getAllByTestId("code-box")).toHaveLength(4);
  });
});
