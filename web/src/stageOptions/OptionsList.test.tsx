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
  it("shows Players, Look, Sing screen and Sound in order", () => {
    setup();
    expect(groupIds()).toEqual(["players", "look", "singScreen", "sound"]);
    expect(group("look").getByRole("heading", { name: "Look" })).toBeTruthy();
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

  it("leaves out a group with no option", () => {
    setup(
      defaultStageOptions(),
      OPTION_GROUPS.map((g) => (g.id === "look" ? { ...g, rows: [] } : g)),
    );
    expect(groupIds()).toEqual(["players", "singScreen", "sound"]);
    expect(screen.queryByRole("heading", { name: "Look" })).toBeNull();
  });
});
