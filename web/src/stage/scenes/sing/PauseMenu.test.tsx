// The pause menu (#217) inside the real Stage frame: Resume is the default,
// Esc resumes, and Restart, Skip and End fire only after a hold.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
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
