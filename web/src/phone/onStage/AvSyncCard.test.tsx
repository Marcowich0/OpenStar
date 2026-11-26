// Check A/V sync on a Remote's Stage tab (#163): started from the waiting
// Line-up or the empty Queue with no Admin PIN, not while a Song plays; while
// the server says it runs, big −/+, Reset to 0 and Done, each a request the
// server passes to the Stage.

import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PartySnapshot } from "../../generated/PartySnapshot";
import { StageTab } from "../stage/StageTab";
import {
  LINE_UP,
  MY_PHONE,
  PARTY,
  renderWithParty,
  stubFetch,
} from "../stage/testParty";

beforeEach(stubFetch);
afterEach(() => {
  vi.unstubAllGlobals();
});

const emptyQueue: PartySnapshot = {
  ...PARTY,
  queue: [],
  head: null,
  lineUp: null,
};

const playing: PartySnapshot = {
  ...PARTY,
  lineUp: { ...LINE_UP, canStart: false },
  playing: { requestId: 1, songId: 40, paused: false },
};

function renderTab(party: PartySnapshot) {
  return renderWithParty(party, (store) => (
    <StageTab store={store} myPhoneId={MY_PHONE} />
  ));
}

const startButton = () =>
  screen.queryByRole("button", { name: "Check A/V sync" });

describe("Check A/V sync on the Stage tab", () => {
  it("is started from the waiting Line-up and from the empty Queue", () => {
    for (const party of [PARTY, emptyQueue]) {
      const { sent, view } = renderTab(party);
      const button = startButton();
      if (!button) throw new Error("no Check A/V sync button");
      fireEvent.click(button);
      expect(sent).toEqual([{ type: "startAvSync" }]);
      view.unmount();
    }
  });

  it("is not offered while a Song plays", () => {
    renderTab(playing);
    expect(startButton()).toBeNull();
  });

  it("shows big −/+, Reset to 0 and Done while the server says it runs", () => {
    const { sent, server } = renderTab(emptyQueue);
    expect(screen.queryByTestId("av-sync-card")).toBeNull();

    server({ type: "avSync", running: true });
    const card = screen.getByTestId("av-sync-card");
    expect(startButton()).toBeNull();
    fireEvent.click(
      within(card).getByRole("button", { name: "A/V offset down" }),
    );
    fireEvent.click(
      within(card).getByRole("button", { name: "A/V offset up" }),
    );
    fireEvent.click(within(card).getByRole("button", { name: "Reset to 0" }));
    fireEvent.click(within(card).getByRole("button", { name: "Done" }));
    expect(sent).toEqual([
      { type: "stepAvSync", step: "down" },
      { type: "stepAvSync", step: "up" },
      { type: "stepAvSync", step: "reset" },
      { type: "endAvSync" },
    ]);

    server({ type: "avSync", running: false });
    expect(screen.queryByTestId("av-sync-card")).toBeNull();
    expect(startButton()).toBeInTheDocument();
  });

  it("shows the Stage's current value large, as the Stage reports it", () => {
    const { server } = renderTab(emptyQueue);
    server({ type: "avSync", running: true });
    const value = () => screen.getByTestId("av-sync-value").textContent;
    // Not known until the Stage has reported it.
    expect(value()).toBe("–");
    server({ type: "avSyncCheck", startedBy: null, avOffsetMs: 120 });
    expect(value()).toBe("+120 ms");
    server({ type: "avSyncCheck", startedBy: null, avOffsetMs: -40 });
    expect(value()).toBe("−40 ms");
  });
});
