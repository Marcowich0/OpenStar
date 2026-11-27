import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HOLD_DURATION_MS } from "./hold";
import { HoldButton } from "./HoldButton";
import { UiCueContext, type UiCue } from "./uiCue";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const onHold = vi.fn();
  render(<HoldButton onHold={onHold}>Skip</HoldButton>);
  const button = screen.getByRole("button", { name: "Skip" });
  const fill = () => screen.getByTestId("hold-fill");
  return { onHold, button, fill };
}

function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("HoldButton", () => {
  it("fires its action once after a 700 ms hold", () => {
    const { onHold, button } = setup();
    act(() => {
      fireEvent.pointerDown(button);
    });
    wait(HOLD_DURATION_MS - 1);
    expect(onHold).not.toHaveBeenCalled();
    wait(1);
    expect(onHold).toHaveBeenCalledOnce();
    act(() => {
      fireEvent.pointerUp(button);
    });
    wait(2000);
    expect(onHold).toHaveBeenCalledOnce();
  });

  it("fills linearly from one side over 700 ms while held", () => {
    const { button, fill } = setup();
    expect(fill().style.transform).toBe("scaleX(0)");
    act(() => {
      fireEvent.pointerDown(button);
    });
    expect(button).toHaveAttribute("data-holding", "true");
    expect(fill().style.transform).toBe("scaleX(1)");
    expect(fill().style.transition).toBe("transform 700ms linear");
    expect(fill().classList).toContain("origin-left");
  });

  it("cancels on an early release: nothing fires and the fill resets", () => {
    const { onHold, button, fill } = setup();
    act(() => {
      fireEvent.pointerDown(button);
    });
    wait(400);
    act(() => {
      fireEvent.pointerUp(button);
    });
    wait(2000);
    expect(onHold).not.toHaveBeenCalled();
    expect(button).not.toHaveAttribute("data-holding");
    expect(fill().style.transform).toBe("scaleX(0)");
  });

  it("cancels when the pointer leaves the button", () => {
    const { onHold, button, fill } = setup();
    act(() => {
      fireEvent.pointerDown(button);
    });
    wait(400);
    act(() => {
      fireEvent.pointerLeave(button);
    });
    wait(2000);
    expect(onHold).not.toHaveBeenCalled();
    expect(fill().style.transform).toBe("scaleX(0)");
    expect(screen.queryByText("Hold for a moment")).not.toBeInTheDocument();
  });

  it("shows the hint after a short tap, and fires nothing", () => {
    const { onHold, button } = setup();
    expect(screen.queryByText("Hold for a moment")).not.toBeInTheDocument();
    act(() => {
      fireEvent.pointerDown(button);
      fireEvent.pointerUp(button);
    });
    expect(screen.getByText("Hold for a moment")).toBeInTheDocument();
    expect(onHold).not.toHaveBeenCalled();
  });

  it("starts a hold on Enter key down and cancels it on key up", () => {
    const { onHold, button } = setup();
    act(() => {
      fireEvent.keyDown(button, { key: "Enter" });
    });
    wait(300);
    act(() => {
      fireEvent.keyUp(button, { key: "Enter" });
    });
    wait(2000);
    expect(onHold).not.toHaveBeenCalled();

    act(() => {
      fireEvent.keyDown(button, { key: "Enter" });
    });
    // Key repeats while the key is held do not restart the hold.
    wait(300);
    act(() => {
      fireEvent.keyDown(button, { key: "Enter", repeat: true });
    });
    wait(HOLD_DURATION_MS - 300);
    expect(onHold).toHaveBeenCalledOnce();
  });

  it("is not pressed by a click alone, so Enter does not fire it twice", () => {
    const { onHold, button } = setup();
    act(() => {
      fireEvent.click(button);
    });
    wait(2000);
    expect(onHold).not.toHaveBeenCalled();
  });

  it("shows no confirmation sheet after a completed hold", () => {
    const { button } = setup();
    act(() => {
      fireEvent.pointerDown(button);
    });
    wait(HOLD_DURATION_MS);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByText(/undo/i)).not.toBeInTheDocument();
  });

  it("is sized for a thumb", () => {
    const { button } = setup();
    expect(button.classList).toContain("min-h-16");
  });

  it("never fills or fires while disabled, and shakes when pressed", () => {
    const onHold = vi.fn();
    render(
      <HoldButton onHold={onHold} isDisabled>
        Delete
      </HoldButton>,
    );
    const button = screen.getByRole("button", { name: "Delete" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    act(() => {
      fireEvent.pointerDown(button);
    });
    expect(button).not.toHaveAttribute("data-holding");
    expect(screen.getByTestId("hold-fill").style.transform).toBe("scaleX(0)");
    expect(button).toHaveAttribute("data-shaking", "true");
    wait(HOLD_DURATION_MS * 2);
    act(() => {
      fireEvent.keyDown(button, { key: "Enter" });
    });
    wait(HOLD_DURATION_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });
});

describe("HoldButton sounds (Stage only, ticket 261)", () => {
  function withCues(disabled = false) {
    const cues: UiCue[] = [];
    const onHold = vi.fn();
    render(
      <UiCueContext value={(cue) => cues.push(cue)}>
        <HoldButton onHold={onHold} isDisabled={disabled}>
          Skip
        </HoldButton>
      </UiCueContext>,
    );
    return { cues, onHold, button: screen.getByRole("button") };
  }

  it("ticks four times while held, then sounds done as it fires", () => {
    const { cues, button } = withCues();
    act(() => {
      fireEvent.pointerDown(button);
    });
    expect(cues).toEqual(["holdTick"]);
    wait(HOLD_DURATION_MS - 1);
    expect(cues).toEqual(["holdTick", "holdTick", "holdTick", "holdTick"]);
    wait(1);
    expect(cues.at(-1)).toBe("holdDone");
    wait(2000);
    expect(cues.filter((cue) => cue === "holdDone")).toHaveLength(1);
    expect(cues.filter((cue) => cue === "holdTick")).toHaveLength(4);
  });

  it("stops ticking when the hold is let go early", () => {
    const { cues, button } = withCues();
    act(() => {
      fireEvent.pointerDown(button);
    });
    wait(200);
    act(() => {
      fireEvent.pointerUp(button);
    });
    wait(2000);
    expect(cues).toEqual(["holdTick", "holdTick"]);
  });

  it("bonks when a greyed one is pressed", () => {
    const { cues, button } = withCues(true);
    act(() => {
      fireEvent.pointerDown(button);
    });
    wait(2000);
    expect(cues).toEqual(["refuse"]);
  });

  it("is marked as sounding itself, so its click is not a select", () => {
    const { button } = withCues();
    expect(button).toHaveAttribute("data-ui-cue");
  });
});
