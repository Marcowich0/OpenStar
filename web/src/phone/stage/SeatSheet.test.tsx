import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LineUp } from "../../generated/LineUp";
import type { PartyMemberId } from "../../generated/PartyMemberId";
import { SeatSheet } from "./SeatSheet";
import {
  BO_SEAT,
  JONAS_SEAT,
  LINE_UP,
  MY_PHONE,
  PARTY,
  renderWithParty,
  stubFetch,
} from "./testParty";

beforeEach(stubFetch);
afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSheet(seated: PartyMemberId, lineUp: LineUp = LINE_UP) {
  const onSeated = vi.fn();
  const onClose = vi.fn();
  const party = { ...PARTY, lineUp };
  const live = renderWithParty(party, (store) => (
    <SeatSheet
      store={store}
      myPhoneId={MY_PHONE}
      seated={seated}
      onSeated={onSeated}
      onClose={onClose}
    />
  ));
  return { ...live, onSeated, onClose };
}

const DUET: LineUp = {
  ...LINE_UP,
  duet: true,
  seats: LINE_UP.seats.map((seat, i) => ({
    ...seat,
    voice: i === 0 ? "p1" : "p2",
  })),
};

describe("the seat sheet", () => {
  it("shows who sits in the seat and which seat it is", async () => {
    renderSheet(2);
    const sheet = await screen.findByRole("dialog", { name: "Jonas" });
    expect(
      await within(sheet).findByText("Seat 2 for Valerie"),
    ).toBeInTheDocument();
  });

  it("moves a Party member who sits in another seat into this one", async () => {
    const { sent, lineUpChanged, onSeated } = renderSheet(2);
    const who = within(await screen.findByRole("group", { name: "Who" }));
    // Every Party member, this seat's own pressed.
    expect(await who.findByRole("button", { name: "Jonas" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(who.getByRole("button", { name: "Sara" })).toBeInTheDocument();
    fireEvent.click(who.getByRole("button", { name: "Bo" }));
    expect(sent.at(-1)).toEqual({
      type: "editLineUp",
      requestId: 1,
      edit: {
        kind: "setWho",
        seat: 1,
        who: { kind: "member", memberId: 1 },
      },
    });
    // Bo leaves seat 1 and takes seat 2, which keeps the Red mic.
    lineUpChanged({
      ...LINE_UP,
      seats: [{ ...JONAS_SEAT, memberId: 1, difficulty: BO_SEAT.difficulty }],
    });
    await waitFor(() => {
      expect(onSeated).toHaveBeenCalledWith(1);
    });
  });

  it("offers every Mic, with Mics in use in another seat disabled and tagged", async () => {
    const { sent } = renderSheet(1);
    const mic = within(await screen.findByRole("group", { name: "Mic" }));
    expect(mic.getByRole("button", { name: /^This phone/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      await mic.findByRole("button", { name: /^Jonas's phone/ }),
    ).toBeEnabled();
    const red = await mic.findByRole("button", { name: /^Red mic/ });
    expect(red).toBeDisabled();
    expect(within(red).getByText("in use")).toBeInTheDocument();

    fireEvent.click(mic.getByRole("button", { name: /^Jonas's phone/ }));
    expect(sent.at(-1)).toEqual({
      type: "editLineUp",
      requestId: 1,
      edit: {
        kind: "setMic",
        seat: 0,
        mic: { kind: "phone", phoneId: "jonas-phone" },
      },
    });
  });

  it("offers Voice only in a duet", async () => {
    renderSheet(1);
    await screen.findByRole("group", { name: "Mic" });
    expect(screen.queryByRole("group", { name: "Voice" })).toBeNull();
  });

  it("sets the Voice in a duet", async () => {
    const { sent } = renderSheet(1, DUET);
    const voice = within(await screen.findByRole("group", { name: "Voice" }));
    expect(voice.getByRole("button", { name: "Voice 1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(voice.getByRole("button", { name: "Voice 2" }));
    expect(sent.at(-1)).toEqual({
      type: "editLineUp",
      requestId: 1,
      edit: { kind: "setVoice", seat: 0, voice: "p2" },
    });
  });

  it("sets the Difficulty", async () => {
    const { sent } = renderSheet(2);
    const difficulty = within(
      await screen.findByRole("group", { name: "Difficulty" }),
    );
    expect(difficulty.getByRole("button", { name: "Hard" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(difficulty.getByRole("button", { name: "Easy" }));
    expect(sent.at(-1)).toEqual({
      type: "editLineUp",
      requestId: 1,
      edit: { kind: "setDifficulty", seat: 1, difficulty: "easy" },
    });
  });

  it("takes the singer off this Song and closes", async () => {
    const { sent, lineUpChanged, onClose } = renderSheet(2);
    fireEvent.click(
      await screen.findByRole("button", { name: "Take Jonas off this Song" }),
    );
    expect(sent.at(-1)).toEqual({
      type: "editLineUp",
      requestId: 1,
      edit: { kind: "removeSeat", seat: 1 },
    });
    lineUpChanged({ ...LINE_UP, seats: [BO_SEAT] });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("shows the server's refusal", async () => {
    const { server } = renderSheet(1);
    const mic = within(await screen.findByRole("group", { name: "Mic" }));
    fireEvent.click(await mic.findByRole("button", { name: /^Jonas's phone/ }));
    server({ type: "rejected", reason: { code: "micInUse" } });
    expect(await screen.findByRole("alert")).toHaveTextContent(/./);
  });
});
