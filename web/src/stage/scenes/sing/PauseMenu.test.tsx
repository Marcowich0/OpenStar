// The pause menu (#217) inside the real Stage frame: Resume is the default,
// Esc resumes, and Restart, Skip and End fire only after a hold.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLiveStore } from "../../../live/liveStore";
import { HOLD_DURATION_MS } from "../../../ui/hold";
import { SCENES } from "../../frame/sceneComponents";
import { StageFrame } from "../../frame/StageFrame";
import { PauseMenu, type PauseMenuControl } from "./PauseMenu";

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const onControl = vi.fn<(control: PauseMenuControl) => void>();
  const store = createLiveStore(() => ({ send: () => true, close: () => {} }));
  const queries = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  render(
    <QueryClientProvider client={queries}>
      <StageFrame
        store={store}
        scenes={{
          ...SCENES,
          songBrowser: { component: () => <PauseMenu onControl={onControl} /> },
        }}
      />
    </QueryClientProvider>,
  );
  return { onControl };
}

const key = (name: string) => {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: name });
  });
};

const keyUp = (name: string) => {
  act(() => {
    fireEvent.keyUp(document.activeElement ?? document.body, { key: name });
  });
};

/** Resume, Restart, Skip, End, then "How to read the screen". */
const tabToLegend = () => {
  // jsdom lays nothing out, so Tab rather than the arrows.
  for (let i = 0; i < 4; i++) key("Tab");
};

describe("the pause menu", () => {
  it("is a card headed Paused with Resume focused and the hold hint", () => {
    setup();
    const dialog = screen.getByRole("dialog", { name: "Paused" });
    expect(dialog).toBeInTheDocument();
    const resume = screen.getByRole("button", { name: "Resume" });
    expect(resume).toHaveFocus();
    for (const name of [
      "Restart",
      "Skip to the next Song",
      "End and show results",
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(
      screen.getByText("Restart, Skip and End: hold Enter or press and hold"),
    ).toBeInTheDocument();
  });

  it("resumes on Resume", () => {
    const { onControl } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onControl).toHaveBeenCalledExactlyOnceWith("resume");
  });

  it("resumes on Esc", () => {
    const { onControl } = setup();
    key("Escape");
    expect(onControl).toHaveBeenCalledExactlyOnceWith("resume");
  });

  it.each(["BrowserBack", "GoBack", "Backspace"])(
    "resumes on a TV remote's Back (%s)",
    (back) => {
      const { onControl } = setup();
      key(back);
      expect(onControl).toHaveBeenCalledExactlyOnceWith("resume");
    },
  );
  describe("How to read the screen", () => {
    const open = () => {
      fireEvent.click(
        screen.getByRole("button", { name: "How to read the screen" }),
      );
      return screen.getByRole("dialog", { name: "How to read the screen" });
    };

    it("opens a card with the Note kinds, the pitch line and the lyric styles", () => {
      const { onControl } = setup();
      const card = open();
      for (const name of [
        "Normal Note",
        "Golden Note",
        "Rap Note",
        "Freestyle Note",
        "Sung Note",
        "On pitch",
        "Off pitch",
      ]) {
        expect(within(card).getByRole("img", { name })).toBeInTheDocument();
      }
      for (const text of [
        "Sung",
        "Being sung",
        "Golden",
        "Freestyle",
        "The next Line",
      ]) {
        expect(within(card).getByText(text)).toBeInTheDocument();
      }
      // Opening it sends nothing: the Song stays paused, no countdown.
      expect(onControl).not.toHaveBeenCalled();
    });

    it("goes back to the pause menu on Esc, without resuming", () => {
      const { onControl } = setup();
      tabToLegend();
      key("Enter");
      keyUp("Enter");
      expect(screen.getByRole("button", { name: "Back" })).toHaveFocus();
      key("Escape");
      expect(
        screen.queryByRole("dialog", { name: "How to read the screen" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("dialog", { name: "Paused" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "How to read the screen" }),
      ).toHaveFocus();
      expect(onControl).not.toHaveBeenCalled();
    });

    it("goes back to the pause menu on Back", () => {
      const { onControl } = setup();
      open();
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      expect(
        screen.queryByRole("dialog", { name: "How to read the screen" }),
      ).not.toBeInTheDocument();
      expect(onControl).not.toHaveBeenCalled();
    });

    it("is reached with the keyboard", () => {
      setup();
      tabToLegend();
      expect(
        screen.getByRole("button", { name: "How to read the screen" }),
      ).toHaveFocus();
      key("Enter");
      keyUp("Enter");
      expect(
        screen.getByRole("dialog", { name: "How to read the screen" }),
      ).toBeInTheDocument();
    });
  });

  it.each([
    ["Restart", "restart"],
    ["Skip to the next Song", "skip"],
    ["End and show results", "end"],
  ] as const)("%s needs a hold", (name, control) => {
    vi.useFakeTimers();
    const { onControl } = setup();
    const button = screen.getByRole("button", { name });
    // A short press does nothing.
    fireEvent.pointerDown(button, { button: 0 });
    act(() => {
      vi.advanceTimersByTime(HOLD_DURATION_MS / 2);
    });
    fireEvent.pointerUp(button, { button: 0 });
    expect(onControl).not.toHaveBeenCalled();
    fireEvent.pointerDown(button, { button: 0 });
    act(() => {
      vi.advanceTimersByTime(HOLD_DURATION_MS);
    });
    expect(onControl).toHaveBeenCalledExactlyOnceWith(control);
  });
});
