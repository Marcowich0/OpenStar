import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures";

// The pitch-detection worklet in a real Chromium (#105): the Stage's Local
// mic meters run on it, it and the detector's WASM come from OpenStar's own
// origin, and the very same built worklet file detects a tone on `/` and on
// `/stage`.

const WORKLET = /\/assets\/pitchProcessor-[\w-]+\.js$/;
const WASM = /\/assets\/openstar_detector-[\w-]+\.wasm$/;

interface Loaded {
  url: string;
  status: number;
  contentType: string;
}

function recordResponses(page: Page): Loaded[] {
  const loaded: Loaded[] = [];
  page.on("response", (response) => {
    loaded.push({
      url: response.url(),
      status: response.status(),
      contentType: response.headers()["content-type"] ?? "",
    });
  });
  return loaded;
}

/**
 * Runs a 440 Hz sine through the given worklet and WASM files in an
 * `OfflineAudioContext` on `page`, and returns the readings it posted.
 */
async function readingsOfA4(page: Page, workletUrl: string, wasmUrl: string) {
  return page.evaluate(
    async ({ workletUrl, wasmUrl }) => {
      const rate = 48_000;
      const context = new OfflineAudioContext(1, rate, rate);
      await context.audioWorklet.addModule(workletUrl);
      const wasm = await (await fetch(wasmUrl)).arrayBuffer();
      const node = new AudioWorkletNode(context, "openstar-pitch", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: "explicit",
        processorOptions: { wasm },
      });
      const readings: {
        pitch: number | null;
        loudness: number;
        endFrame: number;
        sampleRate: number;
      }[] = [];
      node.port.onmessage = (event: MessageEvent) => {
        readings.push(event.data as (typeof readings)[number]);
      };
      const tone = new OscillatorNode(context, { frequency: 440 });
      tone.connect(node);
      tone.start();
      await context.startRendering();
      // The last messages arrive after the render ends.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return readings;
    },
    { workletUrl, wasmUrl },
  );
}

test("the Stage's meters run on the pitch worklet, loaded from OpenStar itself", async ({
  micStage: stage,
}) => {
  const loaded = recordResponses(stage);
  await stage.goto("/stage");
  await stage.getByRole("button", { name: "Setup" }).click();
  await stage.getByRole("menuitem", { name: "Mics", exact: true }).click();
  const group = stage
    .getByRole("dialog", { name: "Mics" })
    .getByRole("group", { name: "This browser" });

  // Chromium's fake microphone beeps: the meters show the readings' loudness.
  await expect
    .poll(
      async () =>
        Math.max(
          ...(await group
            .getByRole("meter")
            .evaluateAll((all) =>
              all.map((m) => Number(m.getAttribute("aria-valuenow"))),
            )),
        ),
      { timeout: 15_000, intervals: [50] },
    )
    .toBeGreaterThan(-60);

  const origin = new URL(stage.url()).origin;
  const worklets = loaded.filter((r) => WORKLET.test(r.url));
  const wasm = loaded.filter((r) => WASM.test(r.url));
  expect(worklets.map((r) => r.status)).toEqual([200]);
  expect(wasm.map((r) => [r.status, r.contentType])).toEqual([
    [200, "application/wasm"],
  ]);
  // Nothing the Stage loaded came from another origin.
  expect(
    loaded.filter((r) => !r.url.startsWith(`${origin}/`)).map((r) => r.url),
  ).toEqual([]);
});

test("the one built worklet file detects a 440 Hz tone on / and on /stage", async ({
  micStage: stage,
}) => {
  const loaded = recordResponses(stage);
  await stage.goto("/stage");
  await stage.getByRole("button", { name: "Setup" }).click();
  await stage.getByRole("menuitem", { name: "Mics", exact: true }).click();
  await expect.poll(() => loaded.some((r) => WASM.test(r.url))).toBe(true);
  const workletUrl = loaded.find((r) => WORKLET.test(r.url))?.url ?? "";
  const wasmUrl = loaded.find((r) => WASM.test(r.url))?.url ?? "";
  expect(workletUrl).toMatch(WORKLET);

  for (const route of ["/stage", "/"]) {
    await stage.goto(route);
    const readings = await readingsOfA4(stage, workletUrl, wasmUrl);
    // 1 s at 48 kHz: the first reading at 2048 frames, then one every 512.
    expect(readings.length, route).toBeGreaterThan(85);
    expect(readings[0]?.endFrame, route).toBe(2048);
    expect(readings.every((r) => r.sampleRate === 48_000)).toBe(true);
    const voiced = readings.filter((r) => r.pitch !== null);
    expect(voiced.length, route).toBe(readings.length);
    for (const r of voiced) expect(r.pitch ?? 0).toBeCloseTo(69, 1);
  }
});
