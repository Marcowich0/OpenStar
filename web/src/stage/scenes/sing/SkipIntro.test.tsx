import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SongClock } from "../../../clock/songClock";
import { SkipIntro } from "./SkipIntro";

/** A Song clock standing at `time`, which the test moves. */
function clockAt(time: { seconds: number }): SongClock {
  return { songTime: () => time.seconds } as unknown as SongClock;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the Skip intro pill", () => {
  it("shows while the Intro plays, counts down to the first Note and skips on a press", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const time = { seconds: 2 };
    const onSkip = vi.fn();
    render(
      <SkipIntro
        introEndSeconds={27}
        clock={clockAt(time)}
        playing
        onSkip={onSkip}
      />,
    );
    // The first Note at 0:30.
    expect(screen.getByText("Singing in 0:28")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Skip intro" }));
    expect(onSkip).toHaveBeenCalledOnce();

    time.seconds = 20;
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByText("Singing in 0:10")).toBeInTheDocument();
    // Shortly before the landing spot, nothing worth skipping is left.
    time.seconds = 26;
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.queryByTestId("skip-intro")).toBeNull();
  });

  it("does not show without an Intro, or while the Song does not play", () => {
    const time = { seconds: 2 };
    const { rerender } = render(
      <SkipIntro
        introEndSeconds={null}
        clock={clockAt(time)}
        playing
        onSkip={() => {}}
      />,
    );
    expect(screen.queryByTestId("skip-intro")).toBeNull();
    rerender(
      <SkipIntro
        introEndSeconds={27}
        clock={clockAt(time)}
        playing={false}
        onSkip={() => {}}
      />,
    );
    expect(screen.queryByTestId("skip-intro")).toBeNull();
  });
});
