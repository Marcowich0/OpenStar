import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { Dialog } from "./Dialog";

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button">Behind the dialog</button>
      <Dialog title="Leave the Party?" isOpen={open} onOpenChange={setOpen}>
        <button type="button">Stay</button>
        <button type="button">Leave</button>
      </Dialog>
    </>
  );
}

function tab(shift = false) {
  const target = document.activeElement ?? document.body;
  act(() => {
    fireEvent.keyDown(target, { key: "Tab", shiftKey: shift });
  });
}

describe("Dialog", () => {
  it("is a labelled modal dialog that takes the focus", () => {
    render(<Harness />);
    const dialog = screen.getByRole("dialog", { name: "Leave the Party?" });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("traps the focus inside while open", () => {
    render(<Harness />);
    const dialog = screen.getByRole("dialog");
    const stay = screen.getByRole("button", { name: "Stay" });
    const leave = screen.getByRole("button", { name: "Leave" });

    act(() => {
      leave.focus();
    });
    tab();
    expect(stay).toHaveFocus();

    tab(true);
    expect(leave).toHaveFocus();

    for (let i = 0; i < 5; i++) {
      tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it("closes on Esc", () => {
    render(<Harness />);
    act(() => {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
