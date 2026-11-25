import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Score } from "./Score";

describe("Score", () => {
  it("shows the Score in tabular figures", () => {
    render(<Score value={9480} />);
    const score = screen.getByText("9480");
    expect(score.classList).toContain("tabular-nums");
  });
});
