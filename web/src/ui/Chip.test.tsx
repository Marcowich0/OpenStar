import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Chip, Pill } from "./Chip";

describe("Chip", () => {
  it.each([
    ["plain", ["bg-surface", "text-ink", "shadow-ledge-sm"]],
    ["duet", ["bg-purple", "text-white"]],
    ["best", ["bg-yellow", "text-on-bright"]],
    ["warn", ["bg-warn-bg", "text-warn-fg"]],
    ["off", ["text-ink-2"]],
  ] as const)("in the %s tone is a full-radius label", (tone, classes) => {
    render(<Chip tone={tone}>Duet</Chip>);
    const chip = screen.getByText("Duet");
    expect(chip.classList).toContain("rounded-full");
    for (const name of classes) expect(chip.classList).toContain(name);
  });

  it("is plain by default", () => {
    render(<Chip>Pop</Chip>);
    expect(screen.getByText("Pop").classList).toContain("bg-surface");
  });
});

describe("Pill", () => {
  it("is ink with white text, full radius and a dark ledge", () => {
    render(<Pill>Volume 80</Pill>);
    const pill = screen.getByText("Volume 80");
    for (const name of [
      "bg-ink-fill",
      "text-white",
      "rounded-full",
      "shadow-ledge-ink",
    ])
      expect(pill.classList).toContain(name);
  });

  it("pops in when asked to", () => {
    render(<Pill popIn>Hi</Pill>);
    expect(screen.getByText("Hi").classList).toContain("animate-pop-in");
  });
});
