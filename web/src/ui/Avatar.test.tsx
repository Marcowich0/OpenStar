import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AVATAR_KEYS } from "../avatars/avatarIcons";
import type { Avatar as AvatarValue } from "../generated/Avatar";
import { PALETTE_KEYS } from "../theme/tokens";
import { Avatar } from "./Avatar";

const star: AvatarValue = { kind: "builtIn", key: "star" };

function disc(): SVGCircleElement {
  const circle = screen.getByRole("img").querySelector("circle");
  if (circle === null) throw new Error("no disc");
  return circle;
}

describe("Avatar", () => {
  it("is labelled with its owner's name", () => {
    render(<Avatar name="Mia" avatar={star} colour="teal" size={70} />);
    expect(screen.getByRole("img", { name: "Mia" })).toBeInTheDocument();
  });

  it("is a disc filled with the palette key's colour", () => {
    render(<Avatar name="Mia" avatar={star} colour="tangerine" size={70} />);
    expect(disc().style.fill).toBe("var(--color-party-tangerine)");
  });

  it("has a white rim of 7 % of its diameter and a ledge", () => {
    render(<Avatar name="Mia" avatar={star} colour="teal" size={70} />);
    // The disc is drawn on a 100-unit grid: the rim is 7 units wide and
    // sits inside the edge.
    expect(disc().getAttribute("stroke-width")).toBe("7");
    expect(disc().getAttribute("r")).toBe("46.5");
    expect(disc().style.stroke).toBe("var(--color-white)");
    expect(screen.getByRole("img").className).toContain("shadow-ledge");
  });

  it("is drawn at the size it is given", () => {
    render(<Avatar name="Mia" avatar={star} colour="teal" size={46} />);
    const avatar = screen.getByRole("img");
    expect(avatar.style.width).toBe("46px");
    expect(avatar.style.height).toBe("46px");
  });

  it("shows its icon at 32 px and above", () => {
    render(<Avatar name="Mia" avatar={star} colour="teal" size={32} />);
    const uses = [...screen.getByRole("img").querySelectorAll("use")].map(
      (use) => use.getAttribute("href"),
    );
    expect(uses.some((href) => href?.endsWith("star.svg#glyph"))).toBe(true);
    expect(uses.some((href) => href?.endsWith("star.svg#detail"))).toBe(true);
    expect(screen.getByRole("img").querySelector("text")).toBeNull();
  });

  it("draws the icon over 55 % of the disc", () => {
    render(<Avatar name="Mia" avatar={star} colour="teal" size={70} />);
    const icon = screen.getByRole("img").querySelector("svg svg");
    expect(icon?.getAttribute("width")).toBe("55");
    expect(icon?.getAttribute("x")).toBe("22.5");
  });

  it("shows the outlined initial instead below 32 px", () => {
    render(<Avatar name="mia" avatar={star} colour="lime" size={31} />);
    const avatar = screen.getByRole("img", { name: "mia" });
    expect(avatar.querySelector("use")).toBeNull();
    const initial = avatar.querySelector("text");
    expect(initial?.textContent).toBe("M");
    // Fredoka 700 at half the diameter, white, the ink outline painted under
    // the fill (half of the 7-unit stroke shows: 3.5 % of the diameter).
    expect(initial?.getAttribute("font-size")).toBe("50");
    expect(initial?.getAttribute("font-weight")).toBe("700");
    expect(initial?.getAttribute("stroke-width")).toBe("7");
    expect(initial?.getAttribute("paint-order")).toBe("stroke fill");
    expect(initial?.style.fill).toBe("var(--color-white)");
    expect(initial?.style.stroke).toBe("var(--color-on-bright)");
    expect(initial?.getAttribute("class")).toContain("font-sans");
  });

  it("holds no hex colour, whatever the colour and icon", () => {
    const { container } = render(
      <>
        {PALETTE_KEYS.map((colour, index) => (
          <Avatar
            key={colour}
            name={colour}
            avatar={{ kind: "builtIn", key: AVATAR_KEYS[index] ?? "star" }}
            colour={colour}
            size={index % 2 === 0 ? 24 : 70}
          />
        ))}
      </>,
    );
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("hides its drawing from assistive tech behind the label", () => {
    render(<Avatar name="Mia" avatar={star} colour="teal" size={20} />);
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });
});
