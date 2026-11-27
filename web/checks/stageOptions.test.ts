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
    const difficulty = constant(
      "STARTING_DIFFICULTY_DEFAULT",
      "Difficulty",
    ).replace("Difficulty::", "");
    expect(STAGE_OPTIONS).toEqual({
      defaults: {
        startingDifficulty: difficulty.toLowerCase(),
        resumeCountdownSeconds: number("RESUME_COUNTDOWN_DEFAULT_SECONDS"),
        lineRatings: bool("LINE_RATINGS_DEFAULT"),
        effects: variant("EFFECTS_DEFAULT", "Effects"),
        songVideo: bool("SONG_VIDEO_DEFAULT"),
        previewVolumePercent: number("PREVIEW_VOLUME_DEFAULT_PERCENT"),
        skipIntros: bool("SKIP_INTROS_DEFAULT"),
      },
      resumeCountdownMaxSeconds: number("RESUME_COUNTDOWN_MAX_SECONDS"),
      previewVolumeStepPercent: number("PREVIEW_VOLUME_STEP_PERCENT"),
    });
  });
});
