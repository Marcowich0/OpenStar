import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeLibraryServer, renderLive, settle } from "../admin/adminTestKit";
import { OptionsScreen } from "./OptionsScreen";
import {
  createStageOptionsHolder,
  defaultStageOptions,
  STAGE_OPTIONS,
  type StageOptions,
} from "./stageOptions";
import { StageOptionsLoader } from "./useStageOptions";

/** A server keeping one set of Stage options, recording every PUT. */
function optionsServer(stored: StageOptions = defaultStageOptions()) {
  let kept = stored;
  const puts: StageOptions[] = [];
  let refuse = false;
  const server = fakeLibraryServer({
    "GET /api/stage-options": () => kept,
    "PUT /api/stage-options": (_url: URL, init: RequestInit) => {
      if (refuse) return new Response(null, { status: 500 });
      kept = JSON.parse(init.body as string) as StageOptions;
      puts.push(kept);
      return kept;
    },
  });
  return {
    server,
    puts,
    set(next: StageOptions) {
      kept = next;
    },
    refuse() {
      refuse = true;
    },
  };
}

async function setup(stored?: StageOptions) {
  const server = optionsServer(stored);
  const holder = createStageOptionsHolder();
  const live = await renderLive(
    <>
      <StageOptionsLoader holder={holder} />
      <OptionsScreen />
    </>,
  );
  return { ...server, holder, live };
}

const row = (id: string) => {
  const found = document.querySelector<HTMLElement>(`[data-option="${id}"]`);
  if (!found) throw new Error(`no row ${id}`);
  return within(found);
};
const resetOf = (id: string) =>
  row(id).getByRole("button", { name: /^Reset .* to its default$/ });
const openAdvanced = (group: string) => {
  fireEvent.click(
    within(screen.getByTestId(`options-${group}`)).getByRole("button", {
      name: /^Advanced/,
    }),
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Setup › Options", () => {
  it("shows every option in its group with an explanation, at the defaults", async () => {
    await setup();
    openAdvanced("sound");
    openAdvanced("look");
    openAdvanced("singScreen");
    for (const [group, ids] of [
      ["options-players", ["startingDifficulty"]],
      ["options-look", ["laneFrostingPercent"]],
      [
        "options-singScreen",
        [
          "lyricSize",
          "lineRatings",
          "effects",
          "songVideo",
          "skipIntros",
          "showNextLine",
        ],
      ],
      ["options-sound", ["previewVolumePercent", "resumeCountdownSeconds"]],
    ] as const) {
      const box = screen.getByTestId(group);
      for (const id of ids) {
        expect(box.querySelector(`[data-option="${id}"]`)).not.toBeNull();
        // Greyed: nothing to reset.
        expect(resetOf(id).getAttribute("aria-disabled")).toBe("true");
      }
    }
    expect(
      row("startingDifficulty")
        .getByRole("button", { name: "Medium" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      row("effects").getByRole("switch").getAttribute("aria-checked"),
    ).toBe("true");
    expect(row("resumeCountdownSeconds").getByText("3 seconds")).toBeTruthy();
    expect(row("previewVolumePercent").getByText("100 %")).toBeTruthy();
    expect(
      row("lyricSize")
        .getByRole("button", { name: "M" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      row("showNextLine").getByRole("switch").getAttribute("aria-checked"),
    ).toBe("true");
    expect(row("laneFrostingPercent").getByText("66 %")).toBeTruthy();
    expect(
      row("lineRatings").getByText(/The Line bonus counts either way/),
    ).toBeTruthy();
  });

  it("saves each change at once as the whole set, and Reset puts the default back", async () => {
    const s = await setup();
    fireEvent.click(row("effects").getByRole("switch"));
    await settle();
    expect(s.puts).toEqual([{ ...defaultStageOptions(), effects: false }]);
    expect(
      row("effects").getByRole("switch").getAttribute("aria-checked"),
    ).toBe("false");
    expect(resetOf("effects").getAttribute("aria-disabled")).toBeNull();

    fireEvent.click(
      row("startingDifficulty").getByRole("button", { name: "Hard" }),
    );
    await settle();
    expect(s.puts.at(-1)).toEqual({
      ...defaultStageOptions(),
      effects: false,
      startingDifficulty: "hard",
    });

    fireEvent.click(resetOf("effects"));
    await settle();
    expect(s.puts.at(-1)).toEqual({
      ...defaultStageOptions(),
      startingDifficulty: "hard",
    });
    expect(resetOf("effects").getAttribute("aria-disabled")).toBe("true");
    // A greyed Reset sends nothing.
    const sent = s.puts.length;
    fireEvent.click(resetOf("effects"));
    await settle();
    expect(s.puts).toHaveLength(sent);
  });

  it("steps a number within its range", async () => {
    const s = await setup({
      ...defaultStageOptions(),
      resumeCountdownSeconds: STAGE_OPTIONS.resumeCountdownMaxSeconds,
    });
    openAdvanced("sound");
    const countdown = row("resumeCountdownSeconds");
    fireEvent.click(countdown.getByRole("button", { name: /up$/ }));
    await settle();
    expect(s.puts).toEqual([]);
    for (let i = 0; i < 6; i++) {
      fireEvent.click(countdown.getByRole("button", { name: /down$/ }));
      await settle();
    }
    expect(s.puts.at(-1)?.resumeCountdownSeconds).toBe(0);
    expect(countdown.getByText("0 seconds")).toBeTruthy();

    fireEvent.click(
      row("previewVolumePercent").getByRole("button", { name: /down$/ }),
    );
    await settle();
    expect(s.puts.at(-1)?.previewVolumePercent).toBe(90);
  });

  it("picks a Lyric size and switches the next Line off, under Sing screen › Advanced", async () => {
    const s = await setup();
    const sizes = row("lyricSize").getAllByRole("button", { pressed: false });
    expect(sizes.map((b) => b.textContent)).toEqual(["S", "L", "XL"]);
    fireEvent.click(row("lyricSize").getByRole("button", { name: "XL" }));
    await settle();
    expect(s.puts.at(-1)).toEqual({
      ...defaultStageOptions(),
      lyricSize: "xl",
    });
    expect(document.querySelector('[data-option="showNextLine"]')).toBeNull();
    openAdvanced("singScreen");
    fireEvent.click(row("showNextLine").getByRole("switch"));
    await settle();
    expect(s.puts.at(-1)).toEqual({
      ...defaultStageOptions(),
      lyricSize: "xl",
      showNextLine: false,
    });
  });

  it("steps the Lane frosting from its default onto the 10s, within 40 to 90 %", async () => {
    const s = await setup();
    openAdvanced("look");
    const frosting = row("laneFrostingPercent");
    fireEvent.click(frosting.getByRole("button", { name: /up$/ }));
    await settle();
    expect(s.puts.at(-1)?.laneFrostingPercent).toBe(70);
    fireEvent.click(resetOf("laneFrostingPercent"));
    await settle();
    fireEvent.click(frosting.getByRole("button", { name: /down$/ }));
    await settle();
    expect(s.puts.at(-1)?.laneFrostingPercent).toBe(60);
    for (let i = 0; i < 4; i++) {
      fireEvent.click(frosting.getByRole("button", { name: /down$/ }));
      await settle();
    }
    expect(s.puts.at(-1)?.laneFrostingPercent).toBe(40);
    expect(frosting.getByText("40 %")).toBeTruthy();
    expect(
      frosting
        .getByRole("button", { name: /down$/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("keeps the Stage's holder filled, and refetches on a change notice", async () => {
    const s = await setup({ ...defaultStageOptions(), lineRatings: false });
    expect(s.holder.current().lineRatings).toBe(false);
    s.set({ ...defaultStageOptions(), songVideo: false });
    await s.live.receive({ type: "changed", topics: ["stageOptions"] });
    expect(s.holder.current()).toEqual({
      ...defaultStageOptions(),
      songVideo: false,
    });
    expect(
      row("songVideo").getByRole("switch").getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("says so when a change could not be saved, and shows what is kept", async () => {
    const s = await setup();
    s.refuse();
    fireEvent.click(row("lineRatings").getByRole("switch"));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe(
      "Couldn't save the options. Try again.",
    );
    expect(
      row("lineRatings").getByRole("switch").getAttribute("aria-checked"),
    ).toBe("true");
  });
});

describe("the holder", () => {
  it("holds the defaults until the options load", () => {
    expect(createStageOptionsHolder().current()).toEqual(
      STAGE_OPTIONS.defaults,
    );
  });
});
