// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { OPENSTAR_VOLUME } from "../src/playback/gain";

describe("the OpenStar volume", () => {
  it("has the server's range, step and default (crates/protocol/src/volume.rs)", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL("../../crates/protocol/src/volume.rs", import.meta.url),
      ),
      "utf8",
    );
    const constant = (name: string) => {
      const found = new RegExp(`pub const ${name}: u8 = (\\d+);`).exec(source);
      expect(found, name).not.toBeNull();
      return Number(found?.[1]);
    };
    expect(OPENSTAR_VOLUME).toEqual({
      min: constant("VOLUME_MIN"),
      max: constant("VOLUME_MAX"),
      step: constant("VOLUME_STEP"),
      default: constant("VOLUME_DEFAULT"),
    });
  });
});
