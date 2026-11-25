import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HOLD_DURATION_MS } from "./hold";
import { HoldButton } from "./HoldButton";

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
});
