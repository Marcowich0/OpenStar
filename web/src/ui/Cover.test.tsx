import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PALETTE_KEYS } from "../theme/tokens";
import type { PaletteKey } from "../theme/tokens";
import { Cover } from "./Cover";

function song(tileColour: PaletteKey, title = "Sunny Day", id = 4) {
  return { id, title, tileColour };
}

function cover(): HTMLElement {
  return screen.getByTestId("cover");
}

describe("Cover", () => {
  it("is a rounded square with a white rim as thick as the caller sets, on a ledge", () => {
    render(<Cover src="/media/1/cover.jpg" song={song("sky")} rim={9} />);
    expect(cover().style.borderWidth).toBe("9px");
    expect(cover().className).toContain("border-white");
    expect(cover().className).toContain("aspect-square");
    expect(cover().style.borderRadius).not.toBe("");
    expect(cover().className).toContain("shadow-ledge");
  });

  it("shows the Song's cover image", () => {
    render(<Cover src="/media/1/cover.jpg" song={song("sky")} rim={4} />);
    const image = cover().querySelector("img");
    expect(image?.getAttribute("src")).toBe("/media/1/cover.jpg");
    expect(cover().style.backgroundColor).toBe("");
  });

  it("loads its image only when it nears the screen, when asked to", () => {
    render(<Cover src="/media/1/cover.jpg" song={song("sky")} rim={4} lazy />);
    expect(cover().querySelector("img")).toHaveAttribute("loading", "lazy");
  });

  it("shows the Song's generated cover, on its tile colour, when it has no cover", () => {
    render(<Cover src={null} song={song("berry", "Sunny Day")} rim={4} />);
    expect(cover().querySelector("img")).toBeNull();
    expect(cover().style.backgroundColor).toBe("var(--color-party-berry)");
    const art = screen.getByTestId("generated-cover");
    expect(art.querySelector("svg")).not.toBeNull();
    expect(art.querySelector("text")?.textContent).toBe("S");
    expect(art.innerHTML).toContain("var(--color-party-berry)");
  });

  it("gives two Songs without a cover different generated covers", () => {
    render(
      <>
        <Cover src={null} song={song("berry", "Sunny Day", 4)} rim={4} />
        <Cover src={null} song={song("berry", "Night Song", 5)} rim={4} />
      </>,
    );
    const [first, second] = screen.getAllByTestId("generated-cover");
    expect(first?.innerHTML).not.toBe(second?.innerHTML);
  });

  it("shows a plain tile while the Song is not known yet", () => {
    render(<Cover src={null} song={null} rim={4} />);
    expect(screen.queryByTestId("generated-cover")).toBeNull();
    expect(cover().style.backgroundColor).not.toBe("");
  });

  it("falls back to the generated tile when the cover will not load", () => {
    render(<Cover src="/media/1/gone.jpg" song={song("forest")} rim={4} />);
    const image = cover().querySelector("img");
    if (image === null) throw new Error("no image");
    act(() => {
      fireEvent.error(image);
    });
    expect(cover().querySelector("img")).toBeNull();
    expect(cover().style.backgroundColor).toBe("var(--color-party-forest)");
    expect(screen.getByTestId("generated-cover")).toBeInTheDocument();
  });

  it("shows what the caller lays over it", () => {
    render(
      <Cover src={null} song={song("mint")} rim={4}>
        <span data-testid="over" />
      </Cover>,
    );
    expect(screen.getByTestId("over")).toBeInTheDocument();
  });

  it("holds no hex colour, whatever the tile colour", () => {
    const { container } = render(
      <>
        {PALETTE_KEYS.map((colour) => (
          <Cover key={colour} src={null} song={song(colour)} rim={6} />
        ))}
      </>,
    );
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
