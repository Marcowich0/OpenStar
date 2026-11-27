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
    /** A lowercase-renamed enum constant as serde writes it (`LyricSize::Xl` → `xl`). */
    const lowercase = (name: string, type: string) =>
      constant(name, type).replace(`${type}::`, "").toLowerCase();
    const difficulty = constant(
      "STARTING_DIFFICULTY_DEFAULT",
      "Difficulty",
    ).replace("Difficulty::", "");
    expect(STAGE_OPTIONS).toEqual({
      defaults: {
        startingDifficulty: difficulty.toLowerCase(),
        resumeCountdownSeconds: number("RESUME_COUNTDOWN_DEFAULT_SECONDS"),
        lineRatings: bool("LINE_RATINGS_DEFAULT"),
        effects: bool("EFFECTS_DEFAULT"),
        songVideo: bool("SONG_VIDEO_DEFAULT"),
        previewVolumePercent: number("PREVIEW_VOLUME_DEFAULT_PERCENT"),
        skipIntros: bool("SKIP_INTROS_DEFAULT"),
        lyricSize: lowercase("LYRIC_SIZE_DEFAULT", "LyricSize"),
        showNextLine: bool("SHOW_NEXT_LINE_DEFAULT"),
        laneFrostingPercent: number("LANE_FROSTING_DEFAULT_PERCENT"),
      },
      resumeCountdownMaxSeconds: number("RESUME_COUNTDOWN_MAX_SECONDS"),
      previewVolumeStepPercent: number("PREVIEW_VOLUME_STEP_PERCENT"),
      laneFrosting: {
        min: number("LANE_FROSTING_MIN_PERCENT"),
        max: number("LANE_FROSTING_MAX_PERCENT"),
        step: number("LANE_FROSTING_STEP_PERCENT"),
      },
    });
  });
});
