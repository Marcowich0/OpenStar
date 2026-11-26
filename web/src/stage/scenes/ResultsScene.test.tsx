import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { PlayerResult } from "../../generated/PlayerResult";
import { ResultsList } from "./PlaceholderScenes";

const player = (name: string, total: number, place: number): PlayerResult => ({
  memberId: place,
  player: { kind: "guest", name },
  name,
  avatar: { kind: "builtIn", key: "star" },
  colour: "cherry",
  mic: null,
  voice: null,
  difficulty: "medium",
  total,
  notes: total,
  golden: 0,
  lineBonus: 0,
  place,
  rankTitleBand: 0,
  newHighScore: false,
  micLost: false,
  unfinished: false,
});

describe("the results the Stage shows", () => {
  it("lists every Player, ranked, with place and total", () => {
    render(
      <ResultsList
        players={[
          player("Bo", 6115, 1),
          player("Cy", 6115, 1),
          player("Di", 0, 3),
        ]}
      />,
    );
    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual(["1. Bo: 6,115", "1. Cy: 6,115", "3. Di: 0"]);
  });
});
