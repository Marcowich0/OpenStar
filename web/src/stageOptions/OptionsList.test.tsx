import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OPTION_GROUPS, OptionsList } from "./OptionsList";
import { defaultStageOptions, type StageOptions } from "./stageOptions";

function setup(
  options: StageOptions = defaultStageOptions(),
  groups = OPTION_GROUPS,
) {
  const onChange = vi.fn<(change: Partial<StageOptions>) => void>();
  render(<OptionsList options={options} onChange={onChange} groups={groups} />);
  return { onChange };
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
  it("shows Players, Sing screen and Sound in order, and no Look while it has no option", () => {
    setup();
    expect(groupIds()).toEqual(["players", "singScreen", "sound"]);
    expect(screen.queryByRole("heading", { name: "Look" })).toBeNull();
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
    const { onChange } = setup({ ...defaultStageOptions(), effects: false });
    expect(screen.queryByTestId("options-advanced-changed")).toBeNull();
    fireEvent.click(row("effects").getByRole("switch"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ effects: true });
    fireEvent.click(resetOf("effects"));
    expect(onChange).toHaveBeenLastCalledWith({ effects: true });
  });

  it("shows Look once it has an option", () => {
    const look = OPTION_GROUPS.find((g) => g.id === "look");
    const singScreen = OPTION_GROUPS.find((g) => g.id === "singScreen");
    if (!look || !singScreen) throw new Error("no group");
    setup(
      defaultStageOptions(),
      OPTION_GROUPS.map((g) =>
        g === look ? { ...look, rows: singScreen.rows.slice(0, 1) } : g,
      ),
    );
    expect(groupIds()).toEqual(["players", "look", "singScreen", "sound"]);
    expect(group("look").getByRole("heading", { name: "Look" })).toBeTruthy();
  });
});
