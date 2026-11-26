// The 3-2-1 resume countdown over the frozen frame (#158, look #217). The
// pause itself is the pause menu's (`scenes/sing/PauseMenu.tsx`).

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ResumeCountdown } from "./ResumeCountdown";

describe("the resume countdown", () => {
  it("shows nothing while the Song plays or is paused", () => {
    for (const phase of ["playing", "paused"] as const) {
      const { container, unmount } = render(
        <ResumeCountdown state={{ phase }} />,
      );
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("shows the countdown's number", () => {
    render(<ResumeCountdown state={{ phase: "countdown", count: 2 }} />);
    expect(screen.getByRole("status")).toHaveTextContent("2");
    expect(screen.getByTestId("resume-countdown")).toHaveAttribute(
      "data-count",
      "2",
    );
  });

  it("pops each new number in afresh", () => {
    const { rerender } = render(
      <ResumeCountdown state={{ phase: "countdown", count: 3 }} />,
    );
    const three = screen.getByTestId("resume-countdown");
    rerender(<ResumeCountdown state={{ phase: "countdown", count: 2 }} />);
    // A new element, so its pop-in animation runs again.
    expect(screen.getByTestId("resume-countdown")).not.toBe(three);
  });
});
