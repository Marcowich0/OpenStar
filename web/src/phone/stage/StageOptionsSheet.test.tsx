import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultStageOptions } from "../../stageOptions/stageOptions";
import { StageTab } from "./StageTab";
import {
  LINE_UP,
  MY_PHONE,
  PARTY,
  renderWithParty,
  stubFetchWith,
} from "./testParty";

const kept = { ...defaultStageOptions(), songVideo: false };

beforeEach(() => {
  stubFetchWith((url) =>
    url.pathname === "/api/stage-options" ? Response.json(kept) : undefined,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function renderTab(party = { ...PARTY, lineUp: LINE_UP }) {
  return renderWithParty(party, (store) => (
    <StageTab store={store} myPhoneId={MY_PHONE} />
  ));
}

const openOptions = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Options" }));
  return within(await screen.findByRole("dialog", { name: "Options" }));
};

describe("the Stage options on a Phone", () => {
  it("opens the Stage's Options list, with its groups and the kept values, from the Stage tab", async () => {
    renderTab();
    const sheet = await openOptions();
    expect(
      sheet.getByRole("heading", { name: "Sing screen" }),
    ).toBeInTheDocument();
    expect(sheet.getByRole("heading", { name: "Sound" })).toBeInTheDocument();
    await waitFor(() => {
      expect(sheet.getByRole("switch", { name: "Song video" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
    });
    expect(
      within(sheet.getByTestId("options-sound")).getByRole("button", {
        name: /^Advanced/,
      }),
    ).toBeInTheDocument();
  });

  it("sends a change to the server as this Phone, so the Stage toasts who made it", async () => {
    const { sent } = renderTab();
    const sheet = await openOptions();
    await waitFor(() => {
      expect(sheet.getByRole("switch", { name: "Song video" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
    });
    fireEvent.click(sheet.getByRole("switch", { name: "Line ratings" }));
    expect(sent).toContainEqual({
      type: "setStageOptions",
      options: { ...kept, lineRatings: false },
    });
    // Shown before the server's change notice.
    await waitFor(() => {
      expect(
        sheet.getByRole("switch", { name: "Line ratings" }),
      ).toHaveAttribute("aria-checked", "false");
    });
    fireEvent.click(
      sheet.getByRole("button", { name: "Reset Song video to its default" }),
    );
    expect(sent).toContainEqual({
      type: "setStageOptions",
      options: { ...kept, lineRatings: false, songVideo: true },
    });
  });

  it("closes with Back: the full-height sheet leaves nothing outside it to tap", async () => {
    renderTab();
    const sheet = await openOptions();
    fireEvent.click(sheet.getByRole("button", { name: "Back" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Options" })).toBeNull();
    });
  });

  it("is there while a Song plays too", async () => {
    renderTab({
      ...PARTY,
      lineUp: { ...LINE_UP, canStart: false },
      playing: { requestId: 1, songId: 40, paused: false },
    });
    expect(await screen.findByTestId("playing-card")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Options" }),
    ).toBeInTheDocument();
  });

  it("shows the OpenStar volume under Sound as the same value as the Stage tab's Volume, both ways", async () => {
    const { sent, server } = renderTab();
    server({ type: "volume", volume: 80, stepped: false });
    const tabVolume = () =>
      within(screen.getByRole("group", { name: "Volume", hidden: true }));
    let sheet = await openOptions();
    const row = () => {
      const found = sheet
        .getByTestId("options-sound")
        .querySelector<HTMLElement>('[data-option="openStarVolume"]');
      if (!found) throw new Error("no OpenStar volume row");
      return within(found);
    };
    expect(row().getByText("80")).toBeInTheDocument();
    expect(
      row().getByRole("button", {
        name: "Reset OpenStar volume to its default",
      }),
    ).toHaveAttribute("aria-disabled", "true");

    // A step in the sheet asks the server; its answer shows in both.
    fireEvent.click(row().getByRole("button", { name: "OpenStar volume up" }));
    expect(sent.at(-1)).toEqual({ type: "stepVolume", step: "up" });
    server({ type: "volume", volume: 85, stepped: true });
    expect(row().getByText("85")).toBeInTheDocument();
    expect(tabVolume().getByText("85")).toBeInTheDocument();
    fireEvent.click(
      row().getByRole("button", {
        name: "Reset OpenStar volume to its default",
      }),
    );
    expect(sent.at(-1)).toEqual({ type: "setVolume", volume: 80 });

    // A step from the Stage tab's control, or anyone else, shows in the
    // sheet.
    fireEvent.click(sheet.getByRole("button", { name: "Back" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Options" })).toBeNull();
    });
    fireEvent.click(screen.getByRole("button", { name: "Volume down" }));
    expect(sent.at(-1)).toEqual({ type: "stepVolume", step: "down" });
    server({ type: "volume", volume: 75, stepped: true });
    sheet = await openOptions();
    expect(row().getByText("75")).toBeInTheDocument();
  });
});
