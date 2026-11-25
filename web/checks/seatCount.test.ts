// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SEATS } from "../src/live/seats";

describe("the seat count", () => {
  it("is the server's one seat-count constant, `SEATS` in crates/protocol", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL("../../crates/protocol/src/party.rs", import.meta.url),
      ),
      "utf8",
    );
    const rust = /pub const SEATS: usize = (\d+);/.exec(source);
    expect(rust).not.toBeNull();
    expect(SEATS).toBe(Number(rust?.[1]));
  });
});
