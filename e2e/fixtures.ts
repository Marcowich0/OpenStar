import {
  test as base,
  chromium,
  devices,
  type Browser,
  type Page,
} from "@playwright/test";
import { join } from "node:path";

/**
 * The fake microphone WAVs `just e2e` generates from `fixtures/mic/fake-mic.json`
 * before the suite runs, for `openPhone({ wav })`.
 */
export const FAKE_MIC = {
  /** A steady tone on the pitch class of every scored Note of {@link FIXTURE_SONGS.steadyTone}. */
  steadyTone: join(import.meta.dirname, "generated/mic/steady-tone.wav"),
  /** Digital silence: a Phone that hears it scores 0. */
  silence: join(import.meta.dirname, "generated/mic/silence.wav"),
  /** The steady tone on channel 0 and silence on the other three, for the Mic bridge. */
  multichannel: join(import.meta.dirname, "generated/mic/multichannel.wav"),
} as const;

/** The fixture Library's `.txt` files (`fixtures/library/`), relative to the Library. */
export const FIXTURE_SONGS = {
  steadyTone: "Placeholder Artist - Steady Tone/steady-tone.txt",
  sineMelody: "Placeholder Artist - Sine Melody/sine-melody.txt",
  duet: "Placeholder Duo - Two Voices/duet.txt",
  /** Rejected by the parser (`#VERSION:2.0.0`): a Library problem. */
  rejected: "Placeholder Artist - Rejected/rejected.txt",
} as const;

/** The Stage's screen: a desktop browser on a TV-sized viewport. */
export const STAGE_VIEWPORT = { width: 1920, height: 1080 };

/** The phone Chromium emulates for every Phone. */
export const PHONE_DEVICE = devices["Pixel 7"];

export interface PhoneOptions {
  /**
   * A WAV file the Phone's microphone hears, looped. Without one, Chromium's
   * fake microphone plays its default beep.
   */
  wav?: string;
}

interface Fixtures {
  /** A Stage page: desktop viewport, sharing the test's browser. */
  stage: Page;
  /**
   * Opens a Phone page: Chromium's mobile emulation with the microphone granted.
   * Each Phone gets its own browser, because the fake microphone's WAV is a
   * browser launch flag.
   */
  openPhone: (options?: PhoneOptions) => Promise<Page>;
}

export const test = base.extend<Fixtures>({
  stage: async ({ browser, baseURL }, use) => {
    const context = await browser.newContext({
      viewport: STAGE_VIEWPORT,
      ...(baseURL === undefined ? {} : { baseURL }),
    });
    await use(await context.newPage());
    await context.close();
  },

  openPhone: async ({ baseURL }, use) => {
    const browsers: Browser[] = [];
    await use(async (options = {}) => {
      const args = [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        // A Phone starts its audio after a tap; tests skip that gesture.
        "--autoplay-policy=no-user-gesture-required",
      ];
      if (options.wav !== undefined)
        args.push(`--use-file-for-fake-audio-capture=${options.wav}`);
      const browser = await chromium.launch({ args });
      browsers.push(browser);
      const context = await browser.newContext({
        ...PHONE_DEVICE,
        permissions: ["microphone"],
        ...(baseURL === undefined ? {} : { baseURL }),
      });
      // Playwright's `trace` option records these contexts too.
      return context.newPage();
    });
    for (const browser of browsers) await browser.close();
  },
});

export { expect } from "@playwright/test";
