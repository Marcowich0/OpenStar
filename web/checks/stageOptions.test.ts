// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { STAGE_OPTIONS } from "../src/stageOptions/stageOptions";

describe("the Stage options", () => {
  it("have the server's defaults and ranges (crates/protocol/src/stage_options.rs)", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL("../../crates/protocol/src/stage_options.rs", import.meta.url),
      ),
      "utf8",
    );
    const constant = (name: string, type: string) => {
      const found = new RegExp(`pub const ${name}: ${type} = ([^;]+);`).exec(
        source,
      );
      expect(found, name).not.toBeNull();
      return found?.[1] ?? "";
    };
    const number = (name: string) => Number(constant(name, "u8"));
    const bool = (name: string) => constant(name, "bool") === "true";
    /** An enum's default, `Type::FooBar`, as its camelCase name `fooBar`. */
    const variant = (name: string, type: string) => {
      const value = constant(name, type).replace(`${type}::`, "");
      return value.charAt(0).toLowerCase() + value.slice(1);
    };
    expect(STAGE_OPTIONS).toEqual({
      defaults: {
        startingDifficulty: variant(
          "STARTING_DIFFICULTY_DEFAULT",
          "Difficulty",
        ),
        resumeCountdownSeconds: number("RESUME_COUNTDOWN_DEFAULT_SECONDS"),
        lineRatings: bool("LINE_RATINGS_DEFAULT"),
        effects: variant("EFFECTS_DEFAULT", "Effects"),
        songVideo: bool("SONG_VIDEO_DEFAULT"),
        previewVolumePercent: number("PREVIEW_VOLUME_DEFAULT_PERCENT"),
        skipIntros: bool("SKIP_INTROS_DEFAULT"),
        lyricSize: variant("LYRIC_SIZE_DEFAULT", "LyricSize"),
        showNextLine: bool("SHOW_NEXT_LINE_DEFAULT"),
        laneFrostingPercent: number("LANE_FROSTING_DEFAULT_PERCENT"),
        theme: variant("THEME_DEFAULT", "Theme"),
        uiSoundsPercent: number("UI_SOUNDS_DEFAULT_PERCENT"),
      },
      // Seconds and percentages start at 0; the percentages end at 100.
      resumeCountdown: {
        min: 0,
        max: number("RESUME_COUNTDOWN_MAX_SECONDS"),
        step: 1,
      },
      previewVolume: {
        min: 0,
        max: 100,
        step: number("PREVIEW_VOLUME_STEP_PERCENT"),
      },
      laneFrosting: {
        min: number("LANE_FROSTING_MIN_PERCENT"),
        max: number("LANE_FROSTING_MAX_PERCENT"),
        step: number("LANE_FROSTING_STEP_PERCENT"),
      },
      uiSounds: {
        min: 0,
        max: 100,
        step: number("UI_SOUNDS_STEP_PERCENT"),
      },
    });
  });
});
