import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Card } from "./Card";

describe("Card", () => {
  it.each([
    ["small", "rounded-card-sm"],
    ["medium", "rounded-card"],
    ["large", "rounded-card-lg"],
  ] as const)("in %s uses the %s radius", (radius, radiusClass) => {
    render(<Card radius={radius}>Paused</Card>);
    const card = screen.getByText("Paused");
    expect(card.classList).toContain(radiusClass);
    expect(card.classList).toContain("bg-white");
    expect(card.classList).toContain("shadow-ledge-lg");
  });

  it("pops in when asked to", () => {
    render(<Card popIn>Hi</Card>);
    expect(screen.getByText("Hi").classList).toContain("animate-pop-in");
  });
});
