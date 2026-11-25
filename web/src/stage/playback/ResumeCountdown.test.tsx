// What the sing screen shows over the frozen frame while the Song is paused
// or counting down to resume (#158). The look of the countdown is #55's.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ResumeCountdown } from "./ResumeCountdown";

describe("the pause and resume countdown overlay", () => {
  it("shows nothing while the Song plays", () => {
    const { container } = render(
      <ResumeCountdown state={{ phase: "playing" }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("says the Song is paused", () => {
    render(<ResumeCountdown state={{ phase: "paused" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Paused");
  });

  it("shows the countdown's number", () => {
    render(<ResumeCountdown state={{ phase: "countdown", count: 2 }} />);
    expect(screen.getByRole("status")).toHaveTextContent("2");
    expect(screen.getByTestId("resume-countdown")).toHaveAttribute(
      "data-count",
      "2",
    );
  });
});
