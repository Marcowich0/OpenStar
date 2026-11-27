import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NumberPad } from "./NumberPad";
import { UiCueContext, type UiCue } from "./uiCue";

function press(name: string) {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

function type(digits: string) {
  for (const digit of digits) press(digit);
}

/** Lets the caller's answer (a resolved promise) reach the pad. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

const boxes = () =>
  within(screen.getByRole("group", { name: "Join code" })).getAllByTestId(
    "code-box",
  );

describe("NumberPad, Join code form", () => {
  it("has four boxes above a 3 × 4 grid: 1–9, a blank, 0 and delete", () => {
    render(<NumberPad form="joinCode" onSubmit={vi.fn()} />);
    expect(boxes()).toHaveLength(4);
    const keys = screen.getByTestId("pad-grid").querySelectorAll(":scope > *");
    expect(
      [...keys].map((key) => key.getAttribute("aria-label") ?? key.textContent),
    ).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "Delete"]);
    expect(
      screen.queryByRole("button", { name: "OK" }),
    ).not.toBeInTheDocument();
  });

  it("shows typed digits and marks the next box to fill", () => {
    render(<NumberPad form="joinCode" onSubmit={vi.fn()} />);
    expect(boxes()[0]).toHaveAttribute("data-next", "true");
    type("48");
    expect(boxes().map((box) => box.textContent)).toEqual(["4", "8", "", ""]);
    expect(boxes()[2]).toHaveAttribute("data-next", "true");
    expect(boxes()[0]).not.toHaveAttribute("data-next");
  });

  it("deletes the last digit", () => {
    render(<NumberPad form="joinCode" onSubmit={vi.fn()} />);
    type("482");
    press("Delete");
    expect(boxes().map((box) => box.textContent)).toEqual(["4", "8", "", ""]);
  });

  it("submits the code as soon as the fourth digit is typed", () => {
    const onSubmit = vi.fn();
    render(<NumberPad form="joinCode" onSubmit={onSubmit} />);
    type("482");
    expect(onSubmit).not.toHaveBeenCalled();
    type("1");
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("4821");
  });

  it("on a refused code shakes the boxes, says so and clears for a new try", async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce("refused");
    render(<NumberPad form="joinCode" onSubmit={onSubmit} />);
    type("4821");
    await settle();
    expect(
      screen.getByText("That code is not on the Stage"),
    ).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Join code" })).toHaveAttribute(
      "data-shaking",
      "true",
    );
    expect(boxes().map((box) => box.textContent)).toEqual(["", "", "", ""]);
    expect(boxes()[0]).toHaveAttribute("data-next", "true");

    type("1");
    expect(
      screen.queryByText("That code is not on the Stage"),
    ).not.toBeInTheDocument();
  });

  it("takes digits from a hardware keyboard too", () => {
    const onSubmit = vi.fn();
    render(<NumberPad form="joinCode" onSubmit={onSubmit} />);
    act(() => {
      for (const key of ["1", "2", "9", "Backspace", "3", "4"])
        fireEvent.keyDown(document.body, { key });
    });
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("1234");
  });
});

describe("NumberPad, Admin PIN form", () => {
  it("has a lock icon, the heading Admin PIN and an OK key", () => {
    render(<NumberPad form="adminPin" onSubmit={vi.fn()} />);
    expect(
      screen.getByRole("heading", { name: "Admin PIN" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("pin-lock")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "OK" })).toBeInTheDocument();
  });

  it("shows digits as dots, never as numbers", () => {
    render(<NumberPad form="adminPin" onSubmit={vi.fn()} />);
    type("4071");
    const entry = screen.getByRole("img", { name: "4 digits entered" });
    expect(entry.textContent).toBe("");
    expect(entry.querySelectorAll("[data-filled]")).toHaveLength(4);
  });

  it("submits only on OK, with 4 to 8 digits", () => {
    const onSubmit = vi.fn();
    render(<NumberPad form="adminPin" onSubmit={onSubmit} />);
    type("123");
    press("OK");
    expect(onSubmit).not.toHaveBeenCalled();
    type("4567");
    expect(onSubmit).not.toHaveBeenCalled();
    press("OK");
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("1234567");
  });

  it("takes digits and OK from a hardware keyboard", () => {
    const onSubmit = vi.fn();
    render(<NumberPad form="adminPin" onSubmit={onSubmit} />);
    act(() => {
      for (const key of ["8", "8", "7", "7", "6", "Enter"])
        fireEvent.keyDown(document.body, { key });
    });
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("88776");
  });

  it("leaves the keyboard alone while a text field has focus", () => {
    const onSubmit = vi.fn();
    render(
      <>
        <input aria-label="Name" />
        <NumberPad form="adminPin" onSubmit={onSubmit} />
      </>,
    );
    const input = screen.getByRole("textbox", { name: "Name" });
    act(() => {
      for (const key of ["1", "2", "3", "4", "Enter"])
        fireEvent.keyDown(input, { key });
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows the message the caller supplies", () => {
    render(
      <NumberPad
        form="adminPin"
        onSubmit={vi.fn()}
        message="Too many wrong PINs, try again in 0:42"
      />,
    );
    expect(
      screen.getByText("Too many wrong PINs, try again in 0:42"),
    ).toBeInTheDocument();
  });

  it("clears and shakes on a refused PIN, without the Join code text", async () => {
    render(
      <NumberPad
        form="adminPin"
        onSubmit={vi.fn().mockResolvedValueOnce("refused")}
      />,
    );
    type("1234");
    press("OK");
    await settle();
    expect(
      screen.getByRole("img", { name: "0 digits entered" }),
    ).toHaveAttribute("data-shaking", "true");
    expect(
      screen.queryByText("That code is not on the Stage"),
    ).not.toBeInTheDocument();
  });

  it("has keys sized for a thumb", () => {
    render(<NumberPad form="adminPin" onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: "5" }).classList).toContain(
      "h-16",
    );
  });
});

describe("NumberPad sounds (Stage only, ticket 261)", () => {
  it("bonks when its code or PIN is refused", async () => {
    const cues: UiCue[] = [];
    render(
      <UiCueContext value={(cue) => cues.push(cue)}>
        <NumberPad
          form="adminPin"
          onSubmit={vi.fn().mockResolvedValueOnce("refused")}
        />
      </UiCueContext>,
    );
    type("1234");
    press("OK");
    await settle();
    expect(cues.filter((cue) => cue === "refuse")).toHaveLength(1);
    expect(cues.at(-1)).toBe("refuse");
  });
});
