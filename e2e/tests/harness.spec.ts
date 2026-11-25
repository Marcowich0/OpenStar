import type { Page } from "@playwright/test";

import { expect, PHONE_DEVICE, STAGE_VIEWPORT, test } from "../fixtures";
import { writeToneWav } from "../wav";

// The harness itself: the Stage is a desktop browser, and each Phone is an
// emulated phone whose microphone is granted and hears its own WAV. Later flows
// (singing, scoring) rely on this.

/** Opens the Phone's microphone and starts measuring its loudest frequency. */
async function listen(phone: Page): Promise<void> {
  await phone.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const audio = new AudioContext();
    await audio.resume();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 8192;
    audio.createMediaStreamSource(stream).connect(analyser);
    const bins = new Float32Array(analyser.frequencyBinCount);
    Object.assign(window, {
      loudestHz: () => {
        analyser.getFloatFrequencyData(bins);
        let best = 0;
        for (let i = 1; i < bins.length; i += 1)
          if ((bins[i] ?? -Infinity) > (bins[best] ?? -Infinity)) best = i;
        return (best * audio.sampleRate) / analyser.fftSize;
      },
    });
  });
}

function loudestHz(phone: Page): Promise<number> {
  return phone.evaluate(() =>
    (window as unknown as { loudestHz: () => number }).loudestHz(),
  );
}

test("the Stage is a desktop browser", async ({ stage }) => {
  await stage.goto("/stage");
  expect(stage.viewportSize()).toEqual(STAGE_VIEWPORT);
  expect(await stage.evaluate(() => navigator.maxTouchPoints)).toBe(0);
});

test("a Phone is an emulated phone with the microphone granted", async ({
  openPhone,
}) => {
  const phone = await openPhone();
  await phone.goto("/");
  expect(phone.viewportSize()).toEqual(PHONE_DEVICE.viewport);
  expect(await phone.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(
    0,
  );
  const permission = await phone.evaluate(
    async () =>
      (await navigator.permissions.query({ name: "microphone" })).state,
  );
  expect(permission).toBe("granted");
});

test("each Phone's microphone hears its own WAV", async ({
  openPhone,
}, testInfo) => {
  const low = await writeToneWav(testInfo.outputPath("440.wav"), 440, 2);
  const high = await writeToneWav(testInfo.outputPath("880.wav"), 880, 2);
  const first = await openPhone({ wav: low });
  const second = await openPhone({ wav: high });
  for (const phone of [first, second]) {
    await phone.goto("/");
    await listen(phone);
  }
  // Within a few FFT bins (about 6 Hz each) of each Phone's own tone.
  await expect
    .poll(async () => Math.abs((await loudestHz(first)) - 440))
    .toBeLessThan(20);
  await expect
    .poll(async () => Math.abs((await loudestHz(second)) - 880))
    .toBeLessThan(20);
});
