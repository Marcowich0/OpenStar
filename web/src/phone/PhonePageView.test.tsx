import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../api/queryClient";
import type { ClientMessage } from "../generated/ClientMessage";
import type { PartyMember } from "../generated/PartyMember";
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
      singing: false,
    })),
    phones: [],
    queue: [],
    head: null,
    lineUp: null,
    playing: null,
    results: null,
  };
}

function profileMember(
  memberId: number,
  profileId: number,
  colour: PartyMember["colour"],
  favouriteTaken = false,
): PartyMember {
  return {
    memberId,
    identity: { kind: "profile", profileId },
    colour,
    favouriteTaken,
    onPhone: true,
    singing: false,
  };
}

function guestMember(
  memberId: number,
  name: string,
  colour: PartyMember["colour"],
): PartyMember {
  return {
    memberId,
    identity: {
      kind: "guest",
      name,
      avatar: { kind: "builtIn", key: "flame" },
      difficulty: "medium",
    },
    colour,
    favouriteTaken: false,
    onPhone: true,
    singing: false,
  };
}

/** A Party with exactly these members. */
function partyOf(members: PartyMember[]): PartySnapshot {
  return { ...party([]), members };
}

const ALL_COLOURS: PartyMember["colour"][] = [
  "cherry",
  "sky",
  "navy",
  "cocoa",
  "teal",
  "lime",
  "berry",
  "mint",
  "bubblegum",
  "forest",
  "grape",
  "tangerine",
];

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

  it("shows the pad with the refusal for a QR link whose code is not 4 digits", () => {
    const { connect, sent } = renderPhone({ joinCode: "12ab" });
    connect(null);

    expect(
      screen.getByText("That code is not on the Stage"),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("code-box")).toHaveLength(4);
    expect(sent).not.toContainEqual(
      expect.objectContaining({ type: "checkJoinCode" }),
    );
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

/** Connects with `snapshot` and goes through the QR link to Who's singing?. */
async function toWhosSinging(snapshot: PartySnapshot, storage?: PhoneStorage) {
  const phone = renderPhone({
    joinCode: "4821",
    ...(storage ? { storage } : {}),
  });
  phone.connect(null, snapshot);
  phone.server({ type: "joinCodeValid", joinCode: "4821" });
  await screen.findByRole("list", { name: "Who's singing?" });
  return phone;
}

function typeName(name: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: name },
  });
}

describe("the New Profile and Guest form", () => {
  it.each([
    ["New Profile", "New Profile"],
    ["I'm a Guest", "New Guest"],
  ])(
    "%s opens the form: a name, the twelve colours and a random picture",
    async (button, heading) => {
      await toWhosSinging(
        partyOf([
          guestMember(4, "Lukas", "cherry"),
          profileMember(5, 2, "navy"),
        ]),
      );
      fireEvent.click(screen.getByRole("button", { name: button }));

      expect(
        screen.getByRole("heading", { name: heading }),
      ).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute(
        "maxlength",
        "16",
      );
      const colours = within(
        screen.getByRole("radiogroup", { name: /Colour/ }),
      );
      const radios = colours.getAllByRole("radio");
      // Each colour carries its palette name, so colour is never the only cue.
      expect(radios.map((r) => r.closest("label")?.textContent)).toEqual([
        "Cherry",
        "Sky",
        "Navy",
        "Cocoa",
        "Teal",
        "Lime",
        "Berry",
        "Mint",
        "Bubblegum",
        "Forest",
        "Grape",
        "Tangerine",
      ]);
      expect(colours.getByRole("radio", { name: "Cherry" })).toBeDisabled();
      expect(colours.getByRole("radio", { name: "Navy" })).toBeDisabled();
      expect(colours.getByRole("radio", { name: "Sky" })).toBeChecked();
      const pictures = within(
        screen.getByRole("radiogroup", { name: "Picture" }),
      );
      expect(pictures.getAllByRole("radio")).toHaveLength(24);
      expect(
        pictures
          .getAllByRole("radio")
          .filter((r) => (r as HTMLInputElement).checked),
      ).toHaveLength(1);
    },
  );

  it('asks "Are you Bo?" for a Profile\'s name, and Yes joins as Bo', async () => {
    const { sent } = await toWhosSinging(partyOf([]));
    fireEvent.click(screen.getByRole("button", { name: "I'm a Guest" }));
    typeName("  bO ");

    expect(screen.getByText("Are you Bo?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(sent).toContainEqual({
      type: "join",
      phoneId: PHONE_ID,
      joinCode: "4821",
      joinAs: { kind: "profile", profileId: 2 },
    });
  });

  it.each(["I'm a Guest", "New Profile"])(
    "%s: a Guest name used tonight blocks the form",
    async (button) => {
      const { sent } = await toWhosSinging(
        partyOf([guestMember(4, "Kim", "cherry")]),
      );
      fireEvent.click(screen.getByRole("button", { name: button }));
      typeName("kIM ");

      expect(
        screen.getByText("Someone already has that name tonight"),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /^Join/ }));
      expect(sent).not.toContainEqual(
        expect.objectContaining({ type: "join" }),
      );
    },
  );

  it("joins as a Guest with the name, colour and picture", async () => {
    const { sent, server } = await toWhosSinging(
      partyOf([guestMember(4, "Lukas", "cherry")]),
    );
    fireEvent.click(screen.getByRole("button", { name: "I'm a Guest" }));
    typeName(" Mia ");
    fireEvent.click(screen.getByRole("radio", { name: "Teal" }));
    fireEvent.click(screen.getByRole("radio", { name: "Picture 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Join as Mia" }));

    expect(sent).toContainEqual({
      type: "join",
      phoneId: PHONE_ID,
      joinCode: "4821",
      joinAs: {
        kind: "guest",
        name: "Mia",
        colour: "teal",
        avatar: { kind: "builtIn", key: "moon" },
      },
    });
    server(
      { type: "phoneStatus", memberId: 5 },
      {
        type: "liveState",
        stageId: "main",
        isStage: false,
        party: partyOf([
          guestMember(4, "Lukas", "cherry"),
          guestMember(5, "Mia", "teal"),
        ]),
      },
    );
    expect(
      await screen.findByRole("tab", { name: "Songs" }),
    ).toBeInTheDocument();
  });

  it("creates a new Profile with the colour as its favourite and remembers it", async () => {
    const storage = memoryStorage({ "openstar.phoneId": PHONE_ID });
    const { sent, server } = await toWhosSinging(partyOf([]), storage);
    fireEvent.click(screen.getByRole("button", { name: "New Profile" }));
    typeName("Mia");
    fireEvent.click(screen.getByRole("radio", { name: "Grape" }));
    fireEvent.click(screen.getByRole("button", { name: "Join as Mia" }));

    expect(sent).toContainEqual({
      type: "join",
      phoneId: PHONE_ID,
      joinCode: "4821",
      joinAs: expect.objectContaining({
        kind: "newProfile",
        name: "Mia",
        favouriteColour: "grape",
      }) as unknown,
    });
    server(
      { type: "phoneStatus", memberId: 1 },
      {
        type: "liveState",
        stageId: "main",
        isStage: false,
        party: partyOf([profileMember(1, 9, "grape")]),
      },
    );
    expect(
      await screen.findByRole("tab", { name: "Songs" }),
    ).toBeInTheDocument();
    expect(storage.items.get("openstar.profileId")).toBe("9");
  });

  it("Back returns to Who's singing?", async () => {
    await toWhosSinging(partyOf([]));
    fireEvent.click(screen.getByRole("button", { name: "New Profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      screen.getByRole("heading", { name: "Who's singing?" }),
    ).toBeInTheDocument();
  });
});

describe("join refusals", () => {
  async function joinAsAdaWithCherryHeld() {
    // Ada's favourite is Cherry; the Guest Lukas holds it tonight.
    const phone = await toWhosSinging(
      partyOf([guestMember(4, "Lukas", "cherry")]),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Ada/ }));
    phone.server(
      { type: "phoneStatus", memberId: 5 },
      {
        type: "liveState",
        stageId: "main",
        isStage: false,
        party: partyOf([
          guestMember(4, "Lukas", "cherry"),
          profileMember(5, 1, "sky", true),
        ]),
      },
    );
    await screen.findByText("You're Sky tonight");
    return phone;
  }

  it("tells a Profile whose favourite is held its colour tonight, and Let's go opens the Remote", async () => {
    await joinAsAdaWithCherryHeld();

    expect(
      screen.getByText(
        "Lukas already has Cherry, your usual colour. You get it back at the next Party",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Ada" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Let's go" }));
    expect(screen.getByRole("tab", { name: "Songs" })).toBeInTheDocument();
  });

  it("Pick another colour offers only the free colours and makes the pick the Party colour and favourite", async () => {
    const { sent, server } = await joinAsAdaWithCherryHeld();
    fireEvent.click(
      screen.getByRole("button", { name: "Pick another colour" }),
    );

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(10);
    expect(screen.queryByRole("radio", { name: "Cherry" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Sky" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Mint" }));
    fireEvent.click(screen.getByRole("button", { name: "Take Mint" }));

    expect(sent).toContainEqual({
      type: "editMember",
      memberId: 5,
      edit: { colour: "mint" },
    });
    server({
      type: "partyChanged",
      party: partyOf([
        guestMember(4, "Lukas", "cherry"),
        profileMember(5, 1, "mint"),
      ]),
      change: {
        actor: { kind: "member", memberId: 5 },
        event: { code: "memberChanged", params: { memberId: 5, name: "Ada" } },
      },
    });
    expect(
      await screen.findByRole("tab", { name: "Songs" }),
    ).toBeInTheDocument();
  });

  it("does not show the colour notice to a Phone that was already in the Party", async () => {
    const { connect } = renderPhone();
    connect(
      5,
      partyOf([
        guestMember(4, "Lukas", "cherry"),
        profileMember(5, 1, "sky", true),
      ]),
    );
    expect(
      await screen.findByRole("tab", { name: "Songs" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("You're Sky tonight")).toBeNull();
  });

  it("explains a full Party, and Try again sends the join again", async () => {
    const { sent, server } = await toWhosSinging(
      partyOf(
        ALL_COLOURS.map((c, i) => guestMember(i + 10, `G${String(i)}`, c)),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Ada/ }));
    server({ type: "rejected", reason: { code: "partyFull" } });

    expect(
      await screen.findByRole("heading", { name: "The Party is full" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "All 12 colours are taken tonight. Someone who is done singing can tap Leave party on their phone, or be removed from the Party people list.",
      ),
    ).toBeInTheDocument();
    const joins = () => sent.filter((m) => m.type === "join").length;
    expect(joins()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(joins()).toBe(2);
    expect(sent.at(-1)).toEqual({
      type: "join",
      phoneId: PHONE_ID,
      joinCode: "4821",
      joinAs: { kind: "profile", profileId: 1 },
    });
  });

  it("explains a full Party for the form too", async () => {
    const { server } = await toWhosSinging(partyOf([]));
    fireEvent.click(screen.getByRole("button", { name: "I'm a Guest" }));
    typeName("Mia");
    fireEvent.click(screen.getByRole("button", { name: "Join as Mia" }));
    server({ type: "rejected", reason: { code: "partyFull" } });

    expect(
      await screen.findByRole("heading", { name: "The Party is full" }),
    ).toBeInTheDocument();
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
    // "You left the Party" first (#119), then the pad.
    fireEvent.click(screen.getByRole("button", { name: "Join again" }));

    expect(screen.getAllByTestId("code-box")).toHaveLength(4);
  });
});
