import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BubblePopBackground } from "./BubblePopBackground";

describe("BubblePopBackground", () => {
  it("shows its content over the background", () => {
    render(
      <BubblePopBackground>
        <p>Hello</p>
      </BubblePopBackground>,
    );
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("paints a radial gradient from the surface colour through cream to cream-2", () => {
    const { container } = render(<BubblePopBackground />);
    const backdrop = container.querySelector("[data-bubble-pop-backdrop]");
    expect(backdrop?.className).toMatch(
      /bg-\[radial-gradient\([^\]]*var\(--color-surface\)[^\]]*var\(--color-cream\)[^\]]*var\(--color-cream-2\)/,
    );
  });

  it("floats three soft blobs in blue, pink and green at half opacity, hidden from assistive tech", () => {
    const { container } = render(<BubblePopBackground />);
    const blobs = [...container.querySelectorAll("[data-blob]")];
    expect(blobs).toHaveLength(3);
    expect(blobs.map((blob) => blob.getAttribute("data-blob"))).toEqual([
      "blue",
      "pink",
      "green",
    ]);
    for (const blob of blobs) {
      expect(blob.classList).toContain(
        `bg-blob-${blob.getAttribute("data-blob") ?? ""}`,
      );
      expect(blob.classList).toContain("opacity-50");
      expect(blob.classList).toContain("animate-float");
      expect(blob.closest("[aria-hidden='true']")).not.toBeNull();
    }
  });
});
