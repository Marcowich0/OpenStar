import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PartySnapshot } from "../../generated/PartySnapshot";
import { guestMember, partyOf } from "../../phone/people/testPhone";
import { HOLD_DURATION_MS } from "../../ui/hold";
import { click, press, renderOverlays, request, summary } from "./testOverlay";

const SONGS = [
  summary(1, "Africa"),
  summary(2, "Islands"),
  summary(3, "Moon"),
  summary(4, "Wave"),
];

const bo = guestMember(1, "Bo", "cherry");
const jonas = guestMember(2, "Jonas", "teal");
const kim = guestMember(3, "Kim", "lime");
const mia = guestMember(4, "Mia", "sky");
const lukas = guestMember(5, "Lukas", "grape");

const AFRICA = request(11, 1, { requestedPlayers: [1, 2], adder: 1 });
const ISLANDS = request(12, 2, { adder: null });
const MOON = request(13, 3, { adder: 2 });
const WAVE = request(14, 4, { requestedPlayers: [3], adder: 3 });

/** Four Requests, the first one the head with its Line-up waiting. */
const party = (more: Partial<PartySnapshot> = {}): PartySnapshot => ({
  ...partyOf([bo, jonas, kim, mia, lukas]),
  queue: [AFRICA, ISLANDS, MOON, WAVE],
  head: 11,
  ...more,
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function openQueue(snapshot = party()) {
  const view = renderOverlays(snapshot, { songs: SONGS });
  press("q");
  return view;
}

const rows = () =>
  within(screen.getByRole("list", { name: "Queue" })).getAllByRole("listitem");
const row = (title: string) => {
  const found = rows().find((r) => within(r).queryByText(title));
  if (!found) throw new Error(`no row for ${title}`);
  return found;
};
/** Opens a row's pick list with Enter, as the host does. */
function openRow(title: string) {
  const button = within(row(title)).getByRole("button", { name: /^\d/ });
  act(() => {
    button.focus();
  });
  click(button);
  return screen.getByRole("menu");
}
const offered = (title: string) => {
  const menu = openRow(title);
  const names = [...menu.querySelectorAll("button")].map((b) => b.textContent);
  press("Escape");
  return names;
};
/** Lets the commands' promises settle on the server's answer. */
async function settle() {
  await act(async () => {});
}
const entry = (name: string) =>
  within(screen.getByRole("menu")).getByRole("menuitem", { name });

describe("the Queue overlay", () => {
  it("lists the Requests, the head first, with who sings and who added them", () => {
    openQueue();
    expect(screen.getByRole("dialog", { name: "Queue" })).toBeVisible();
    const all = rows();
    expect(
      all.map((r) => within(r).getByTestId("queue-row-title").textContent),
    ).toEqual(["Africa", "Islands", "Moon", "Wave"]);
    expect(all[0]).toHaveTextContent("Bo, Jonas · added by Bo");
    expect(all[1]).toHaveTextContent("Anyone · from the Stage");
    expect(all[2]).toHaveTextContent("Anyone · added by Jonas");
    expect(all[3]).toHaveTextContent("Kim · added by Kim");
  });

  it("rings the head in green and marks it up next", () => {
    openQueue();
    const [head, second] = rows() as [HTMLElement, HTMLElement];
    expect(head).toHaveAttribute("data-head", "upNext");
    expect(within(head).getByText("Up next")).toBeVisible();
    expect(second).not.toHaveAttribute("data-head");
    expect(within(second).queryByText("Up next")).toBeNull();
  });

  it("offers the Queue tab's actions under the same rules", () => {
    openQueue();
    // The head never moves; it can still change singers or be removed.
    expect(offered("Africa")).toEqual([
      "Change singers",
      "Remove from the Queue",
    ]);
    // The second place is the top below the head: only Move down.
    expect(offered("Islands")).toEqual([
      "Move down",
      "Change singers",
      "Remove from the Queue",
    ]);
    expect(offered("Moon")).toEqual([
      "Play next",
      "Move up",
      "Move down",
      "Change singers",
      "Remove from the Queue",
    ]);
    // The last can't move down.
    expect(offered("Wave")).toEqual([
      "Play next",
      "Move up",
      "Change singers",
      "Remove from the Queue",
    ]);
  });

  it("sends Play next, Move up and Move down and closes when the Request moved", async () => {
    const { sent, changeParty } = openQueue();
    openRow("Wave");
    click(entry("Play next"));
    expect(sent.at(-1)).toEqual({
      type: "moveRequest",
      requestId: 14,
      to: "next",
    });
    expect(screen.getByRole("menu")).toBeVisible();
    changeParty(party({ queue: [AFRICA, WAVE, ISLANDS, MOON] }));
    await settle();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(
      rows().map((r) => within(r).getByTestId("queue-row-title").textContent),
    ).toEqual(["Africa", "Wave", "Islands", "Moon"]);

    openRow("Moon");
    click(entry("Move up"));
    expect(sent.at(-1)).toEqual({
      type: "moveRequest",
      requestId: 13,
      to: "up",
    });
    press("Escape");
    openRow("Wave");
    click(entry("Move down"));
    expect(sent.at(-1)).toEqual({
      type: "moveRequest",
      requestId: 14,
      to: "down",
    });
  });

  it("shows a refusal in the pick list", async () => {
    const { reject } = openQueue();
    openRow("Moon");
    click(entry("Move up"));
    reject({ code: "requestCannotMove" });
    await settle();
    expect(within(screen.getByRole("menu")).getByRole("alert")).toBeVisible();
  });

  it("removes a Request only after a hold", async () => {
    vi.useFakeTimers();
    const { sent, changeParty } = openQueue();
    const menu = openRow("Moon");
    const remove = within(menu).getByRole("button", {
      name: "Remove from the Queue",
    });
    // A short press does nothing.
    act(() => {
      fireEvent.pointerDown(remove);
      vi.advanceTimersByTime(HOLD_DURATION_MS / 2);
      fireEvent.pointerUp(remove);
    });
    expect(sent.some((m) => m.type === "removeRequest")).toBe(false);
    act(() => {
      fireEvent.pointerDown(remove);
      vi.advanceTimersByTime(HOLD_DURATION_MS + 50);
    });
    expect(sent.at(-1)).toEqual({ type: "removeRequest", requestId: 13 });
    changeParty(party({ queue: [AFRICA, ISLANDS, WAVE] }));
    await settle();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByText("Moon")).toBeNull();
  });

  it("can't remove the Request whose Song plays", () => {
    openQueue(party({ playing: { requestId: 11, songId: 1, paused: false } }));
    const [head] = rows() as [HTMLElement];
    expect(head).toHaveAttribute("data-head", "playing");
    expect(within(head).getByText("Playing now")).toBeVisible();
    const menu = openRow("Africa");
    expect(
      within(menu).queryByRole("button", { name: "Remove from the Queue" }),
    ).toBeNull();
    expect(menu).toHaveTextContent("It is playing now. Use Skip or End");
  });

  it("changes singers in a pick list of Party members toggled with Enter, up to the seat count", () => {
    const { sent, changeParty } = openQueue();
    openRow("Africa");
    click(entry("Change singers"));
    const list = screen.getByRole("menu", { name: "Who sings Africa?" });
    const member = (name: string) =>
      within(list).getByRole("menuitemcheckbox", { name });
    expect(member("Bo")).toHaveAttribute("aria-checked", "true");
    expect(member("Kim")).toHaveAttribute("aria-checked", "false");

    // Enter on a focused member toggles it.
    act(() => {
      member("Kim").focus();
    });
    act(() => {
      fireEvent.keyDown(member("Kim"), { key: "Enter" });
      fireEvent.click(member("Kim"));
    });
    expect(sent.at(-1)).toEqual({
      type: "setRequestedPlayers",
      requestId: 11,
      requestedPlayers: [1, 2, 3],
    });
    const withSingers = (players: number[]) => {
      return party({
        queue: [{ ...AFRICA, requestedPlayers: players }, ISLANDS, MOON, WAVE],
      });
    };
    changeParty(withSingers([1, 2, 3]));
    expect(member("Kim")).toHaveAttribute("aria-checked", "true");
    click(member("Mia"));
    changeParty(withSingers([1, 2, 3, 4]));
    expect(member("Mia")).toHaveAttribute("aria-checked", "true");
    // Four seats taken: Lukas can't be added, Bo can be taken off.
    expect(member("Lukas")).toHaveAttribute("aria-disabled", "true");
    const count = sent.length;
    click(member("Lukas"));
    expect(sent).toHaveLength(count);
    click(member("Bo"));
    expect(sent.at(-1)).toEqual({
      type: "setRequestedPlayers",
      requestId: 11,
      requestedPlayers: [2, 3, 4],
    });
    // Esc closes the pick list, not the overlay.
    press("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Queue" })).toBeVisible();
  });

  it("updates live when a Remote changes the Queue, and only that toasts", () => {
    const { changeParty } = openQueue();
    // The Stage's own change: no toast.
    changeParty(
      party({ queue: [AFRICA, ISLANDS, MOON] }),
      { kind: "stage" },
      {
        code: "requestRemoved",
        params: { requestId: 14, songId: 4, title: "Wave" },
      },
    );
    expect(rows()).toHaveLength(3);
    const toasts = screen.getByRole("status", { name: "Party changes" });
    expect(toasts).toBeEmptyDOMElement();
    // A Remote's change: the row moves, and a toast says so.
    changeParty(
      party({ queue: [AFRICA, MOON, ISLANDS] }),
      { kind: "member", memberId: 2 },
      {
        code: "requestPlayNext",
        params: { requestId: 13, songId: 3, title: "Moon" },
      },
    );
    expect(
      rows().map((r) => within(r).getByTestId("queue-row-title").textContent),
    ).toEqual(["Africa", "Moon", "Islands"]);
    expect(toasts).not.toBeEmptyDOMElement();
  });
});
