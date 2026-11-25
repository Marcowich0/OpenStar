import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BubblePopSamples } from "./BubblePopSamples";

describe("the Stage's Bubble Pop samples", () => {
  it("show a button in each fill, the green one breathing", () => {
    render(<BubblePopSamples />);
    const sing = screen.getByRole("button", { name: "Sing!" });
    expect(sing.classList).toContain("bg-green");
    expect(sing.classList).toContain("animate-breathe");
    expect(screen.getByRole("button", { name: "End" }).classList).toContain(
      "bg-red",
    );
    expect(screen.getByRole("button", { name: "Back" }).classList).toContain(
      "bg-white",
    );
    expect(
      screen.getByRole("button", { name: "Make this the Stage again" })
        .classList,
    ).toContain("bg-ink");
  });

  it("show a disabled Start that shakes when pressed", () => {
    render(<BubblePopSamples />);
    const start = screen.getByRole("button", { name: "Start" });
    expect(start).toHaveAttribute("aria-disabled", "true");
    act(() => {
      fireEvent.click(start);
    });
    expect(start).toHaveAttribute("data-shaking", "true");
  });

  it("show chips, a Score and the twelve Party colours by name", () => {
    render(<BubblePopSamples />);
    expect(screen.getByText("Duet")).toBeInTheDocument();
    expect(screen.getByText("9480").classList).toContain("tabular-nums");
    expect(screen.getAllByRole("img")).toHaveLength(12);
    expect(screen.getByRole("img", { name: "Tangerine" })).toBeInTheDocument();
  });
});
