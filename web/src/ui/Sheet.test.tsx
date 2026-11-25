import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { Sheet } from "./Sheet";

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
    act(() => {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
