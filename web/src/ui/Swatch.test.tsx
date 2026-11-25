import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PALETTE_KEYS } from "../theme/tokens";
import { Swatch } from "./Swatch";

describe("Swatch", () => {
  it.each([
    ["tangerine", "Tangerine"],
    ["bubblegum", "Bubblegum"],
    ["navy", "Navy"],
  ] as const)(
    "is labelled with the %s Party colour's display name",
    (key, name) => {
      render(<Swatch colour={key} />);
      expect(screen.getByRole("img", { name })).toBeInTheDocument();
    },
  );

  it("is filled with the Party colour's token", () => {
    render(<Swatch colour="teal" />);
    expect(screen.getByRole("img").style.backgroundColor).toBe(
      "var(--color-party-teal)",
    );
  });

  it("gives each of the twelve colours its own label", () => {
    render(
      <>
        {PALETTE_KEYS.map((key) => (
          <Swatch key={key} colour={key} />
        ))}
      </>,
    );
    const names = screen
      .getAllByRole("img")
      .map((swatch) => swatch.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(12);
  });
});
