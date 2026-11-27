import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { VolumeStep } from "../generated/VolumeStep";
import type { OpenStarVolume } from "../live/useOpenStarVolume";
import { OptionsList } from "./OptionsList";
import { defaultStageOptions, type StageOptions } from "./stageOptions";

function setup(
  options: StageOptions = defaultStageOptions(),
  /** The OpenStar volume, or `"none"` to bind none. */
  volume: number | null | "none" = 80,
) {
  const onChange = vi.fn<(change: Partial<StageOptions>) => void>();
  const step = vi.fn<(step: VolumeStep) => void>();
  const set = vi.fn<(volume: number) => void>();
  const openStarVolume: OpenStarVolume | undefined =
    volume === "none" ? undefined : { volume, step, set };
  render(
    <OptionsList
      options={options}
      onChange={onChange}
      openStarVolume={openStarVolume}
    />,
  );
  return { onChange, step, set };
}

const group = (id: string) => within(screen.getByTestId(`options-${id}`));
const advanced = (id: string) =>
  group(id).getByRole("button", { name: /^Advanced/ });
const row = (id: string) => {
  const found = document.querySelector<HTMLElement>(`[data-option="${id}"]`);
  if (!found) throw new Error(`no row ${id}`);
  return within(found);
};
const resetOf = (id: string) =>
  row(id).getByRole("button", { name: /^Reset .* to its default$/ });

const groupIds = () =>
  [...document.querySelectorAll<HTMLElement>("[data-options-group]")].map(
    (group) => group.dataset.optionsGroup,
  );

describe("the Options list", () => {
  it("shows Players, Look, Sing screen and Sound in order", () => {
    setup();
    expect(groupIds()).toEqual(["players", "look", "singScreen", "sound"]);
    expect(group("look").getByRole("heading", { name: "Look" })).toBeTruthy();
  });

  it("shows Line ratings, Effects, Song video, Skip long intros and Lyric size under Sing screen, and the next Line under Advanced", () => {
    setup();
    const rowIds = () =>
      [
        ...screen
          .getByTestId("options-singScreen")
          .querySelectorAll<HTMLElement>("[data-option]"),
      ].map((row) => row.dataset.option);
    expect(rowIds()).toEqual([
      "lineRatings",
      "effects",
      "songVideo",
      "skipIntros",
      "lyricSize",
    ]);
    fireEvent.click(advanced("singScreen"));
    expect(rowIds().at(-1)).toBe("showNextLine");
  });

  it("offers the three themes under Look › Theme, Bubble Pop by default", () => {
    const { onChange } = setup();
    const choices = group("look").getByRole("group", { name: "Theme" });
    expect(
      within(choices)
        .getAllByRole("button")
        .map((button) => [
          button.textContent,
          button.getAttribute("aria-pressed"),
        ]),
    ).toEqual([
      ["Bubble Pop", "true"],
      ["Bubble Pop Night", "false"],
      ["High contrast", "false"],
    ]);
    expect(row("theme").getByText("Default: Bubble Pop")).toBeTruthy();

    fireEvent.click(
      within(choices).getByRole("button", { name: "Bubble Pop Night" }),
    );
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      theme: "bubblePopNight",
    });
  });

  it("folds Countdown after a pause under Sound's Advanced, closed, with no dot at the default", () => {
    setup();
    const fold = advanced("sound");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(fold.textContent).toBe("Advanced");
    expect(screen.queryByTestId("options-advanced-changed")).toBeNull();
    expect(
      document.querySelector('[data-option="resumeCountdownSeconds"]'),
    ).toBeNull();

    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(row("resumeCountdownSeconds").getByText("3 seconds")).toBeTruthy();
    expect(
      resetOf("resumeCountdownSeconds").getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("shows a dot on a fold with a changed option, and Reset inside it puts the default back", () => {
    const { onChange } = setup({
      ...defaultStageOptions(),
      resumeCountdownSeconds: 0,
    });
    const fold = advanced("sound");
    expect(within(fold).getByTestId("options-advanced-changed")).toBeTruthy();
    expect(fold.textContent).toBe("Advanced(changed)");

    fireEvent.click(fold);
    fireEvent.click(resetOf("resumeCountdownSeconds"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      resumeCountdownSeconds: 3,
    });
  });

  it("changes the options outside the fold alone, and leaves its dot off", () => {
    const { onChange } = setup({ ...defaultStageOptions(), effects: "off" });
    expect(screen.queryByTestId("options-advanced-changed")).toBeNull();
    fireEvent.click(row("effects").getByRole("button", { name: "Full" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ effects: "full" });
    fireEvent.click(resetOf("effects"));
    expect(onChange).toHaveBeenLastCalledWith({ effects: "full" });
  });

  it("shows Effects as Off, Calm and Full, at Full by default, with Reset to Full", () => {
    const pressed = () =>
      row("effects")
        .getAllByRole("button", { pressed: true })
        .map((b) => b.textContent);
    const choices = () =>
      row("effects")
        .getAllByRole("button")
        .filter((b) => b.hasAttribute("aria-pressed"))
        .map((b) => b.textContent);
    const { onChange } = setup();
    expect(choices()).toEqual(["Off", "Calm", "Full"]);
    expect(pressed()).toEqual(["Full"]);
    expect(resetOf("effects").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(row("effects").getByRole("button", { name: "Calm" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ effects: "calm" });
  });

  it("shows a changed Effects pressed, and Reset puts Full back", () => {
    const { onChange } = setup({ ...defaultStageOptions(), effects: "calm" });
    expect(
      row("effects")
        .getByRole("button", { name: "Calm" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(resetOf("effects").getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(resetOf("effects"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ effects: "full" });
  });

  it("shows the OpenStar volume, UI sounds and Preview volume under Sound, in that order", () => {
    setup();
    const ids = [
      ...screen
        .getByTestId("options-sound")
        .querySelectorAll<HTMLElement>("[data-option]"),
    ].map((found) => found.dataset.option);
    expect(ids).toEqual([
      "openStarVolume",
      "uiSoundsPercent",
      "previewVolumePercent",
    ]);
  });

  it("steps UI sounds by 10 from its default, 60 %, down to Off", () => {
    const { onChange } = setup();
    expect(row("uiSoundsPercent").getByText("60 %")).toBeTruthy();
    expect(row("uiSoundsPercent").getByText("Default: 60 %")).toBeTruthy();
    expect(resetOf("uiSoundsPercent").getAttribute("aria-disabled")).toBe(
      "true",
    );
    fireEvent.click(
      row("uiSoundsPercent").getByRole("button", { name: "UI sounds down" }),
    );
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ uiSoundsPercent: 50 });
  });

  it("shows UI sounds at 0 as Off, and Reset puts 60 % back", () => {
    const { onChange } = setup({
      ...defaultStageOptions(),
      uiSoundsPercent: 0,
    });
    expect(row("uiSoundsPercent").getByText("Off")).toBeTruthy();
    expect(
      row("uiSoundsPercent")
        .getByRole("button", { name: "UI sounds down" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.click(resetOf("uiSoundsPercent"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ uiSoundsPercent: 60 });
  });

  it("shows the OpenStar volume as it is now and steps it by one step, not as an option", () => {
    const { onChange, step } = setup(defaultStageOptions(), 85);
    expect(row("openStarVolume").getByText("85")).toBeTruthy();
    expect(row("openStarVolume").getByText("Default: 80")).toBeTruthy();
    fireEvent.click(
      row("openStarVolume").getByRole("button", {
        name: "OpenStar volume up",
      }),
    );
    fireEvent.click(
      row("openStarVolume").getByRole("button", {
        name: "OpenStar volume down",
      }),
    );
    expect(step.mock.calls).toEqual([["up"], ["down"]]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("resets the OpenStar volume to 80, and greys Reset at 80", () => {
    const { set } = setup(defaultStageOptions(), 35);
    fireEvent.click(resetOf("openStarVolume"));
    expect(set).toHaveBeenCalledExactlyOnceWith(80);
  });

  it("greys Reset when the OpenStar volume is at its default", () => {
    const { set } = setup();
    expect(resetOf("openStarVolume").getAttribute("aria-disabled")).toBe(
      "true",
    );
    fireEvent.click(resetOf("openStarVolume"));
    expect(set).not.toHaveBeenCalled();
  });

  it("greys the OpenStar volume until a Stage has told it", () => {
    const { step, set } = setup(defaultStageOptions(), null);
    expect(row("openStarVolume").getByText("–")).toBeTruthy();
    for (const name of [
      "OpenStar volume up",
      "OpenStar volume down",
      /^Reset/,
    ]) {
      const button = row("openStarVolume").getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(button);
    }
    expect(step).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("leaves the OpenStar volume out when there is none to bind to", () => {
    setup(defaultStageOptions(), "none");
    expect(document.querySelector('[data-option="openStarVolume"]')).toBeNull();
    expect(
      document.querySelector('[data-option="uiSoundsPercent"]'),
    ).not.toBeNull();
  });
});
