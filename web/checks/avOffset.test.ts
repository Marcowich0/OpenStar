// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AV_OFFSET, clampAvOffset } from "../src/avOffset/avOffset";
import { en } from "../src/i18n/en";

describe("the A/V offset", () => {
  it("has the server's range, step and default (crates/protocol/src/av_offset.rs)", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL("../../crates/protocol/src/av_offset.rs", import.meta.url),
      ),
      "utf8",
    );
    const constant = (name: string) => {
      const found = new RegExp(`pub const ${name}: i32 = (-?\\d+);`).exec(
        source,
      );
      expect(found, name).not.toBeNull();
      return Number(found?.[1]);
    };
    expect(AV_OFFSET).toEqual({
      minMs: constant("AV_OFFSET_MIN_MS"),
      maxMs: constant("AV_OFFSET_MAX_MS"),
      stepMs: constant("AV_OFFSET_STEP_MS"),
      defaultMs: constant("AV_OFFSET_DEFAULT_MS"),
    });
    expect(AV_OFFSET).toEqual({
      minMs: -300,
      maxMs: 500,
      stepMs: 10,
      defaultMs: 0,
    });
  });

  it("is brought within -300..+500 ms and onto the 10 ms grid", () => {
    expect(clampAvOffset(120)).toBe(120);
    expect(clampAvOffset(124)).toBe(120);
    expect(clampAvOffset(125)).toBe(130);
    expect(clampAvOffset(-4)).toBe(0);
    expect(Object.is(clampAvOffset(-4), 0)).toBe(true);
    expect(clampAvOffset(501)).toBe(500);
    expect(clampAvOffset(-301)).toBe(-300);
    expect(clampAvOffset(Number.NaN)).toBe(0);
  });

  it("is not mentioned by the output-changed toast: 0 is right for most outputs", () => {
    expect(en["toast.soundOutputChanged"]).not.toMatch(/A\/V|offset|sync/i);
  });
});
