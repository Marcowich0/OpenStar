import type { Page } from "@playwright/test";

import { expect, FAKE_MIC, FIXTURE_SONGS, test } from "../fixtures";

// The Library `just e2e` serves is the fixture Library with generated audio,
// and the fake mic WAVs reach a Phone's microphone. The singing flows build
// on both.

/** The loudest level and frequency a Phone's microphone hears, over a moment. */
async function hear(phone: Page): Promise<{ peak: number; hz: number }> {
  return phone.evaluate(async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const wave = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(wave);
    const bins = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(bins);
    let best = 1;
    for (let i = 1; i < bins.length; i += 1)
      if ((bins[i] ?? -Infinity) > (bins[best] ?? -Infinity)) best = i;
    return {
      peak: wave.reduce((max, s) => Math.max(max, Math.abs(s)), 0),
      hz: (best * audio.sampleRate) / analyser.fftSize,
    };
  });
}

test("the Library is the fixture Library, with one rejected file", async ({
  request,
}) => {
  const { songs } = (await (await request.get("/api/songs")).json()) as {
    songs: { path: string }[];
  };
  expect(songs.map((s) => s.path).sort()).toEqual(
    [
      FIXTURE_SONGS.steadyTone,
      FIXTURE_SONGS.sineMelody,
      FIXTURE_SONGS.duet,
      FIXTURE_SONGS.separateVideo,
    ].sort(),
  );
  const problems = (await (
    await request.get("/api/library/problems")
  ).json()) as {
    path: string;
    severity: string;
  }[];
  expect(problems).toEqual([
    expect.objectContaining({
      path: FIXTURE_SONGS.rejected,
      severity: "rejection",
    }),
  ]);
});

test("a Phone hears the steady tone, and silence as silence", async ({
  openPhone,
}) => {
  const tone = await openPhone({ wav: FAKE_MIC.steadyTone });
  const silent = await openPhone({ wav: FAKE_MIC.silence });
  for (const phone of [tone, silent]) await phone.goto("/");
  // 440 Hz, within a few FFT bins (about 6 Hz each).
  const heard = await hear(tone);
  expect(Math.abs(heard.hz - 440)).toBeLessThan(20);
  expect(heard.peak).toBeGreaterThan(0.1);
  expect((await hear(silent)).peak).toBe(0);
});
