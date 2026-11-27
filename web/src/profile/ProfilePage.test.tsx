import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NO_STATS, PROFILE_ADA, STATS_ADA } from "./profileStatsFixture";
import { ProfilePageView } from "./ProfilePage";

/** The stat tile labelled `label`: its label and its number. */
function tile(label: string) {
  const tiles = screen.getByRole("list", { name: "Headline numbers" });
  const found = within(tiles)
    .getAllByRole("listitem")
    .find((item) => within(item).queryByText(label));
  if (!found) throw new Error(`no tile ${label}`);
  return found;
}

describe("the Profile page", () => {
  it("shows the avatar large in the favourite colour and the name", () => {
    render(<ProfilePageView profile={PROFILE_ADA} stats={STATS_ADA} />);
    expect(
      screen.getByRole("heading", { level: 2, name: "Ada" }),
    ).toBeInTheDocument();
    const avatar = screen.getByRole("img", { name: "Ada" });
    expect(avatar).toHaveStyle({ width: "96px" });
    expect(avatar.querySelector("circle")?.style.fill).toBe(
      "var(--color-party-berry)",
    );
  });

  it("shows Songs sung, rounds and High scores held as stat tiles", () => {
    render(<ProfilePageView profile={PROFILE_ADA} stats={STATS_ADA} />);
    expect(tile("Songs sung")).toHaveTextContent("12");
    expect(tile("Rounds")).toHaveTextContent("31");
    expect(tile("High scores held")).toHaveTextContent("2");
  });

  it("shows the best Score per Difficulty, with its Song", () => {
    render(<ProfilePageView profile={PROFILE_ADA} stats={STATS_ADA} />);
    const best = screen.getByRole("list", { name: "Best Scores" });
    const rows = within(best).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Medium");
    expect(rows[0]).toHaveTextContent("8,120");
    expect(rows[0]).toHaveTextContent("Africa");
    expect(rows[1]).toHaveTextContent("Hard");
    expect(rows[1]).toHaveTextContent("9,400");
    expect(rows[1]).toHaveTextContent("Valerie");
  });

  it("lists the High scores held with their covers", () => {
    render(<ProfilePageView profile={PROFILE_ADA} stats={STATS_ADA} />);
    const held = screen.getByRole("list", { name: "High scores held" });
    const rows = within(held).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Valerie");
    expect(rows[0]).toHaveTextContent("Amy Winehouse");
    expect(rows[0]).toHaveTextContent("Hard");
    expect(rows[0]).toHaveTextContent("9,400");
    expect(rows[0]?.querySelector("img")).toHaveAttribute(
      "src",
      "/api/songs/4/cover",
    );
    // The second sang Voice 2 of a duet; a Song gone from the Library shows
    // its generated tile.
    expect(rows[1]).toHaveTextContent("Voice 2");
    expect(rows[1]?.querySelector("img")).toBeNull();
    expect(
      within(rows[1] as HTMLElement).getByTestId("cover").style.backgroundColor,
    ).toBe("var(--color-party-grape)");
  });

  it("lists the most-sung Songs with how often", () => {
    render(<ProfilePageView profile={PROFILE_ADA} stats={STATS_ADA} />);
    const most = screen.getByRole("list", { name: "Most sung" });
    const rows = within(most).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Africa"),
      expect.stringContaining("Valerie"),
    ]);
    expect(rows[0]).toHaveTextContent("7 rounds");
    expect(rows[1]).toHaveTextContent("1 round");
  });

  it("says No Songs sung yet for a Profile that never sang", () => {
    render(<ProfilePageView profile={PROFILE_ADA} stats={NO_STATS} />);
    expect(screen.getByText("No Songs sung yet")).toBeInTheDocument();
    expect(
      screen.queryByRole("list", { name: "Headline numbers" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("list", { name: "High scores held" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Ada" }),
    ).toBeInTheDocument();
  });

  it("draws larger on the Stage", () => {
    render(
      <ProfilePageView profile={PROFILE_ADA} stats={STATS_ADA} size="stage" />,
    );
    expect(screen.getByRole("img", { name: "Ada" })).toHaveStyle({
      width: "200px",
    });
  });
});
