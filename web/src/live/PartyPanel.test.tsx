import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ClientMessage } from "../generated/ClientMessage";
import type { PartySnapshot } from "../generated/PartySnapshot";
import type { LiveClientOptions } from "./liveClient";
import { createLiveStore } from "./liveStore";
import { PartyPanel } from "./PartyPanel";

function fakeStore() {
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
  const live = (fn: (h: NonNullable<typeof handlers>) => void) => {
    act(() => {
      if (handlers) fn(handlers);
    });
  };
  return { store, sent, live };
}

const party = (joinCode: string): PartySnapshot => ({
  partyId: `party-${joinCode}`,
  stageId: "main",
  joinCode,
  startedAtMs: 1,
});

describe("PartyPanel", () => {
  it("shows the connection and the Join code every browser shares", () => {
    const { store, live } = fakeStore();
    render(<PartyPanel store={store} />);
    expect(screen.getByTestId("live-connection")).toHaveTextContent(
      "connecting",
    );

    live((h) => {
      h.onConnection("open");
      h.onMessage({
        type: "liveState",
        stageId: "main",
        party: party("0427"),
        isStage: false,
      });
    });
    expect(screen.getByTestId("live-connection")).toHaveTextContent("open");
    expect(screen.getByTestId("party-join-code")).toHaveTextContent("0427");
    expect(screen.queryByRole("button")).toBeNull();

    live((h) => {
      h.onMessage({
        type: "partyChanged",
        party: party("9133"),
        change: {
          actor: { kind: "stage" },
          event: { code: "partyStarted", params: { joinCode: "9133" } },
        },
      });
    });
    expect(screen.getByTestId("party-join-code")).toHaveTextContent("9133");
  });

  it("offers New party on the Stage and sends it over the WebSocket", () => {
    const { store, sent, live } = fakeStore();
    render(<PartyPanel store={store} />);
    live((h) => {
      h.onConnection("open");
      h.onMessage({
        type: "liveState",
        stageId: "main",
        party: party("0427"),
        isStage: true,
      });
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "New party" }));
    });
    expect(sent).toEqual([{ type: "newParty" }]);
  });

  it("drops New party and says so when the Stage moves", () => {
    const { store, live } = fakeStore();
    render(<PartyPanel store={store} />);
    live((h) => {
      h.onConnection("open");
      h.onMessage({
        type: "liveState",
        stageId: "main",
        party: party("0427"),
        isStage: true,
      });
      h.onMessage({ type: "stageMoved" });
    });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("stage-moved")).toBeInTheDocument();
    expect(screen.getByTestId("party-join-code")).toHaveTextContent("0427");
  });

  it("shows a rejection as catalogue text", () => {
    const { store, live } = fakeStore();
    render(<PartyPanel store={store} />);
    live((h) => {
      h.onMessage({ type: "rejected", reason: { code: "notTheStage" } });
    });
    expect(screen.getByTestId("rejection")).toHaveTextContent(
      "Only the Stage can do that",
    );
  });
});
