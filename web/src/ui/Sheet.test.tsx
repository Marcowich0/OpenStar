import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SHEET_ENTER_MS, Sheet } from "./Sheet";

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button">The current tab</button>
      <Sheet label="Valerie" isOpen={open} onOpenChange={setOpen}>
        <button type="button">Add to the Queue</button>
      </Sheet>
    </>
  );
}

/** A tap, as React Aria's outside-press detection reads it. */
function tap(element: Element) {
  act(() => {
    fireEvent.pointerDown(element, { button: 0 });
    fireEvent.click(element, { button: 0 });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** The sheet's slide in has finished. */
function settle() {
  act(() => {
    vi.advanceTimersByTime(SHEET_ENTER_MS);
  });
}

describe("Sheet", () => {
  it("is a labelled dialog over the current tab, at the bottom of the screen", () => {
    render(<Harness />);
    const sheet = screen.getByRole("dialog", { name: "Valerie" });
    expect(sheet).toContainElement(
      screen.getByRole("button", { name: "Add to the Queue" }),
    );
    expect(screen.getByTestId("sheet-veil")).toHaveClass("items-end");
  });

  it("closes when tapped outside it", () => {
    render(<Harness />);
    settle();
    tap(screen.getByTestId("sheet-veil"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays open when tapped inside it", () => {
    render(<Harness />);
    tap(screen.getByRole("button", { name: "Add to the Queue" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes on Esc", () => {
    render(<Harness />);
    settle();
    act(() => {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closed while it still slides in, closes once it is in", () => {
    // Reversing the slide mid-way would cancel the transition React Aria
    // waits for, and leave an invisible veil over the whole screen.
    render(<Harness />);
    tap(screen.getByTestId("sheet-veil"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    settle();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
