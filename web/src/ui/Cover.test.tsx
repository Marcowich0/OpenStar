import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PALETTE_KEYS } from "../theme/tokens";
import { Cover } from "./Cover";

function cover(): HTMLElement {
  return screen.getByTestId("cover");
}

describe("Cover", () => {
  it("is a rounded square with a white rim as thick as the caller sets, on a ledge", () => {
    render(<Cover src="/media/1/cover.jpg" tileColour="sky" rim={9} />);
    expect(cover().style.borderWidth).toBe("9px");
    expect(cover().className).toContain("border-white");
    expect(cover().className).toContain("aspect-square");
    expect(cover().style.borderRadius).not.toBe("");
    expect(cover().className).toContain("shadow-ledge");
  });

  it("shows the Song's cover image", () => {
    render(<Cover src="/media/1/cover.jpg" tileColour="sky" rim={4} />);
    const image = cover().querySelector("img");
    expect(image?.getAttribute("src")).toBe("/media/1/cover.jpg");
    expect(cover().style.backgroundColor).toBe("");
  });

  it("shows the generated tile in the Library's colour when the Song has no cover", () => {
    render(<Cover src={null} tileColour="berry" rim={4} />);
    expect(cover().querySelector("img")).toBeNull();
    expect(cover().style.backgroundColor).toBe("var(--color-party-berry)");
  });

  it("falls back to the generated tile when the cover will not load", () => {
    render(<Cover src="/media/1/gone.jpg" tileColour="forest" rim={4} />);
    const image = cover().querySelector("img");
    if (image === null) throw new Error("no image");
    act(() => {
      fireEvent.error(image);
    });
    expect(cover().querySelector("img")).toBeNull();
    expect(cover().style.backgroundColor).toBe("var(--color-party-forest)");
  });

  it("shows what the caller lays over it", () => {
    render(
      <Cover src={null} tileColour="mint" rim={4}>
        <span data-testid="over" />
      </Cover>,
    );
    expect(screen.getByTestId("over")).toBeInTheDocument();
  });

  it("holds no hex colour, whatever the tile colour", () => {
    const { container } = render(
      <>
        {PALETTE_KEYS.map((colour) => (
          <Cover key={colour} src={null} tileColour={colour} rim={6} />
        ))}
      </>,
    );
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
