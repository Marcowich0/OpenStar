import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PartySnapshot } from "../generated/PartySnapshot";
import type { Profile } from "../generated/Profile";
import type { ProfileEdit } from "../generated/ProfileEdit";
import { HOLD_DURATION_MS } from "../ui/hold";
import { fakeLibraryServer, renderLive, settle } from "./adminTestKit";
import { Profiles } from "./Profiles";

const PIN = "1234";

function profile(id: number, name: string, lastSungAt: number | null) {
  return {
    id,
    name,
    avatar: { kind: "builtIn", key: "star" },
    favouriteColour: "sky",
    lastDifficulty: "medium",
    createdAt: 1_700_000_000_000,
    lastSungAt,
  } satisfies Profile;
}

// 14 March 2024, noon UTC: the same calendar day in every time zone CI runs in.
const SUNG = Date.UTC(2024, 2, 14, 12);
const ADA = profile(1, "Ada", SUNG);
const BO = profile(2, "Bo", null);

/** Tonight's Party: one Guest called `name`. */
function partyWithGuest(name: string): PartySnapshot {
  return {
    partyId: "p1",
    stageId: "main",
    joinCode: "4821",
    startedAtMs: 1,
    members: [
      {
        memberId: 4,
        identity: {
          kind: "guest",
          name,
          avatar: { kind: "builtIn", key: "flame" },
          difficulty: "medium",
        },
        colour: "cherry",
        favouriteTaken: false,
        onPhone: true,
        singing: false,
      },
    ],
    phones: [],
    queue: [],
    head: null,
    lineUp: null,
    playing: null,
    results: null,
    localMics: [],
  };
}

const status = (code: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status: code,
    headers: { "Content-Type": "application/json" },
  });

/**
 * A server with `profiles` and a guarded delete: `401 unlockRequired` until
 * the PIN is given, then `answer` (a `204` that drops the Profile by default).
 */
function profilesServer(
  profiles: Profile[],
  { unlocked = true, answer }: { unlocked?: boolean; answer?: Response } = {},
) {
  let list = profiles;
  let hasUnlock = unlocked;
  const server = fakeLibraryServer({
    "GET /api/profiles": () => list,
    "POST /api/unlock": (_url: URL, init: RequestInit) => {
      const { pin } = JSON.parse(init.body as string) as { pin: string };
      if (pin !== PIN) return status(403, { code: "wrongPin" });
      hasUnlock = true;
      return { unlocked: true };
    },
  });
  const deleteAnswer = (url: URL) => {
    if (!hasUnlock) return status(401, { code: "unlockRequired" });
    if (answer) return answer;
    const id = Number(url.pathname.split("/").pop());
    list = list.filter((p) => p.id !== id);
    return status(204);
  };
  /** Every edit body, in order. */
  const edits: ProfileEdit[] = [];
  const editAnswer = (url: URL, init: RequestInit) => {
    const edit = JSON.parse(init.body as string) as ProfileEdit;
    edits.push(edit);
    if (answer) return answer;
    const id = Number(url.pathname.split("/").pop());
    list = list.map((p) =>
      p.id === id
        ? {
            ...p,
            name: edit.name ?? p.name,
            avatar: edit.avatar ?? p.avatar,
            favouriteColour: edit.favouriteColour ?? p.favouriteColour,
          }
        : p,
    );
    return list.find((p) => p.id === id);
  };
  for (const p of profiles) {
    server.answers[`DELETE /api/profiles/${String(p.id)}`] = deleteAnswer;
    server.answers[`PATCH /api/profiles/${String(p.id)}`] = editAnswer;
  }
  return Object.assign(server, { edits });
}

const list = () => screen.getByRole("list", { name: "Profiles" });
const rows = () => within(list()).getAllByRole("listitem");
const deleteButton = (name: string) =>
  screen.getByRole("button", { name: `Delete ${name}` });
const pad = () => screen.queryByRole("dialog", { name: "Admin PIN" });
const nameField = () => screen.getByRole("textbox", { name: "Name" });

function typeName(name: string) {
  act(() => {
    fireEvent.change(nameField(), { target: { value: name } });
  });
}

function press(name: string | RegExp) {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

/** Presses Delete for `name` for `ms`, then lets go. */
async function holdDelete(name: string, ms = HOLD_DURATION_MS) {
  vi.useFakeTimers();
  const button = deleteButton(name);
  act(() => {
    fireEvent.pointerDown(button);
  });
  act(() => {
    vi.advanceTimersByTime(ms);
  });
  act(() => {
    fireEvent.pointerUp(button);
  });
  vi.useRealTimers();
  await settle();
}

async function enterPin(pin: string) {
  for (const digit of pin)
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    });
  const ok = screen.getByRole("button", { name: "OK" });
  act(() => {
    fireEvent.click(ok);
  });
  await settle();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the Profiles section", () => {
  it("lists every Profile with its avatar, name and last sung", async () => {
    profilesServer([ADA, BO]);
    await renderLive(<Profiles />);

    const [ada, bo] = rows();
    expect(ada?.querySelector('[role="img"]')).toHaveAttribute(
      "aria-label",
      "Ada",
    );
    expect(ada).toHaveTextContent("Ada");
    expect(ada).toHaveTextContent("Last sung Mar 14, 2024");
    expect(bo?.querySelector('[role="img"]')).toHaveAttribute(
      "aria-label",
      "Bo",
    );
    expect(bo).toHaveTextContent("Never sung");
  });

  it("says so when there are no Profiles", async () => {
    profilesServer([]);
    await renderLive(<Profiles />);

    expect(screen.getByText("No Profiles yet")).toBeVisible();
  });

  it("refreshes on the Profiles change notice", async () => {
    const server = profilesServer([ADA]);
    const live = await renderLive(<Profiles />);
    expect(rows()).toHaveLength(1);

    server.answers["GET /api/profiles"] = [ADA, BO];
    await live.changed("profiles");

    expect(rows()).toHaveLength(2);
  });

  it("does nothing on a short press of Delete", async () => {
    const server = profilesServer([ADA, BO]);
    await renderLive(<Profiles />);

    await holdDelete("Ada", HOLD_DURATION_MS - 200);

    expect(server.count("DELETE /api/profiles/1")).toBe(0);
    expect(rows()).toHaveLength(2);
  });

  it("deletes a Profile after a press and hold", async () => {
    const server = profilesServer([ADA, BO]);
    const live = await renderLive(<Profiles />);

    await holdDelete("Ada");
    expect(server.count("DELETE /api/profiles/1")).toBe(1);
    await live.changed("profiles");

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("Bo");
  });

  it("asks for the Admin PIN first without an Unlock, then deletes", async () => {
    const server = profilesServer([ADA, BO], { unlocked: false });
    await renderLive(<Profiles />);

    await holdDelete("Ada");
    expect(pad()).not.toBeNull();
    expect(server.count("DELETE /api/profiles/1")).toBe(1);

    await enterPin(PIN);

    expect(pad()).toBeNull();
    expect(server.count("DELETE /api/profiles/1")).toBe(2);
    expect(rows()).toHaveLength(1);
  });

  it("shows the refusal while the Profile sings, and keeps it", async () => {
    profilesServer([ADA, BO], {
      answer: status(409, { code: "profileSinging" }),
    });
    await renderLive(<Profiles />);

    await holdDelete("Ada");

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "This Profile is singing in the Song that plays",
    );
    expect(rows()[0]).toContainElement(alert);
    expect(rows()).toHaveLength(2);
  });
});

describe("editing a Profile", () => {
  it("Edit opens the Phone's form, filled in with the Profile's own", async () => {
    profilesServer([ADA, BO]);
    await renderLive((store) => <Profiles store={store} />);

    press("Edit Ada");

    const form = screen.getByRole("form", { name: "Edit Ada" });
    expect(nameField()).toHaveValue("Ada");
    expect(nameField()).toHaveAttribute("maxlength", "16");
    const colours = within(
      within(form).getByRole("radiogroup", { name: /Favourite colour/ }),
    );
    expect(colours.getAllByRole("radio")).toHaveLength(12);
    expect(colours.getByRole("radio", { name: "Sky" })).toBeChecked();
    const pictures = within(
      within(form).getByRole("radiogroup", { name: "Picture" }),
    );
    expect(pictures.getByRole("radio", { name: "Picture 1" })).toBeChecked();
  });

  it("saves the name, picture and favourite colour, and the list follows", async () => {
    const server = profilesServer([ADA, BO]);
    const live = await renderLive((store) => <Profiles store={store} />);

    press("Edit Ada");
    typeName(" Ada L ");
    act(() => {
      fireEvent.click(screen.getByRole("radio", { name: "Teal" }));
      fireEvent.click(screen.getByRole("radio", { name: "Picture 3" }));
    });
    press("Save");
    await settle();

    expect(server.edits).toEqual([
      {
        name: "Ada L",
        avatar: { kind: "builtIn", key: "moon" },
        favouriteColour: "teal",
      },
    ]);
    // The server tells everyone, every Phone showing Ada included.
    await live.changed("profiles");
    expect(screen.queryByRole("form", { name: "Edit Ada" })).toBeNull();
    expect(rows()[0]).toHaveTextContent("Ada L");
    expect(rows()[0]?.querySelector('[role="img"]')).toHaveAttribute(
      "aria-label",
      "Ada L",
    );
  });

  it("keeps its own name free, and refuses another Profile's", async () => {
    const server = profilesServer([ADA, BO]);
    await renderLive((store) => <Profiles store={store} />);

    press("Edit Ada");
    typeName("ADA");
    expect(screen.queryByRole("alert")).toBeNull();

    typeName(" bo");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "A Profile with that name already exists",
    );
    press("Save");
    await settle();
    expect(server.edits).toEqual([]);
  });

  it("shows the server's refusal of a taken name and stays open", async () => {
    const server = profilesServer([ADA], {
      answer: status(409, { code: "profileNameTaken", profileId: 7 }),
    });
    await renderLive((store) => <Profiles store={store} />);

    press("Edit Ada");
    typeName("Cleo");
    press("Save");
    await settle();

    expect(server.edits).toHaveLength(1);
    const form = screen.getByRole("form", { name: "Edit Ada" });
    expect(within(form).getByRole("alert")).toHaveTextContent(
      "A Profile with that name already exists",
    );
  });

  it("refuses a name a Guest has tonight", async () => {
    const server = profilesServer([ADA]);
    const live = await renderLive((store) => <Profiles store={store} />);
    await live.receive({
      type: "liveState",
      stageId: "main",
      isStage: false,
      party: partyWithGuest("Kim"),
    });

    press("Edit Ada");
    typeName("kim");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Someone already has that name tonight",
    );
    press("Save");
    await settle();
    expect(server.edits).toEqual([]);
  });
});
