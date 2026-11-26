import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SingState } from "../../sing/frame";
import { SingScreen } from "../../sing/SingScreen";
import { writeLaneScore } from "./laneScore";

function lane(name: string, score: number) {
  return {
    colour: "cherry" as const,
    voice: 0,
    player: {
      name,
      avatar: { kind: "builtIn" as const, key: "star" as const },
      guest: false,
      score,
    },
  };
}

const state = (scores: [number, number]): SingState => ({
  grid: { gapSeconds: 1, beatsPerMinute: 120 },
  voices: [],
  lanes: [lane("Mia", scores[0]), lane("Bo", scores[1])],
});

const clock = { songTime: () => 0 };
const noOffset = () => 0;

beforeEach(() => {
  // No canvas in jsdom: the render loop never starts, the headers still render.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function scores(container: HTMLElement) {
  return [...container.querySelectorAll("[data-lane-score]")].map(
    (el) => el.textContent,
  );
}

describe("writing a lane's running Score", () => {
  it("shows the new Score in that Player's header without a render, and a later render agrees", () => {
    const { container, rerender } = render(
      <SingScreen state={state([0, 0])} clock={clock} avOffset={noOffset} />,
    );
    writeLaneScore(container, 1, 4321);
    expect(scores(container)).toEqual(["0", "4321"]);
    // React's own text node was updated, so a render with the same value
    // (the lane's `score` is kept in step) leaves it, and a new one wins.
    rerender(
      <SingScreen state={state([0, 4321])} clock={clock} avOffset={noOffset} />,
    );
    expect(scores(container)).toEqual(["0", "4321"]);
    rerender(
      <SingScreen
        state={state([10, 5000])}
        clock={clock}
        avOffset={noOffset}
      />,
    );
    expect(scores(container)).toEqual(["10", "5000"]);
  });

  it("does nothing for a lane with no header Player", () => {
    const { container } = render(
      <SingScreen state={state([0, 0])} clock={clock} avOffset={noOffset} />,
    );
    writeLaneScore(container, 5, 99);
    expect(scores(container)).toEqual(["0", "0"]);
  });
});
