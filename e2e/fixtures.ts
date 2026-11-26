import {
  test as base,
  chromium,
  expect,
  devices,
  type Browser,
  type BrowserContext,
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

const JOIN_CODE = /^\d{4}$/;

/** The Admin PIN `scripts/e2e.sh` gives the server under test. */
export const ADMIN_PIN = adminPin();

function adminPin(): string {
  const pin = process.env.OPENSTAR_E2E_ADMIN_PIN;
  if (pin === undefined || pin === "")
    throw new Error(
      "OPENSTAR_E2E_ADMIN_PIN is not set: run the suite with `just e2e`",
    );
  return pin;
}

/**
 * Makes every page of `context` a remembered Stage browser: gives the Admin
 * PIN at `POST /api/stage/trust`, as the pad on `/stage` does, and the Stage
 * cookie lands in the context's cookie jar. The `stage` and `micStage`
 * fixtures already do this, so specs just open `/stage`. A correct PIN
 * resets the shared wrong-guess count.
 */
export async function trustStageBrowser(context: BrowserContext): Promise<void> {
  const response = await context.request.post("/api/stage/trust", {
    data: { pin: ADMIN_PIN },
  });
  expect(response.status()).toBe(200);
}

/**
 * The Admin PIN step on `/stage`, through the pad, for a browser that is not
 * remembered yet: opens `/stage`, enters the PIN and waits for the Stage frame.
 */
export async function becomeStageWithPin(page: Page): Promise<void> {
  await page.goto("/stage");
  const pad = page.getByRole("dialog", { name: "Admin PIN" });
  await expect(pad).toBeVisible();
  for (const digit of ADMIN_PIN)
    await pad.getByRole("button", { name: digit, exact: true }).click();
  await pad.getByRole("button", { name: "OK" }).click();
  await expect(pad).toHaveCount(0);
  await expect(page.locator("[data-stage-frame]")).toHaveAttribute(
    "data-scene",
    /.+/,
  );
}

/**
 * Opens `/stage` on `stage`, a remembered Stage browser (so it is the active Stage), starts a New party
 * from its People overlay and returns the new Party's Join code, with the
 * Stage back on the song browser.
 *
 * Every test shares one server and its Party, and Party members stay in a
 * Party. Call this before a test joins the Party: the test then starts with
 * no members and an empty Queue, whatever earlier tests left, so its
 * Profiles' favourite colours are free.
 */
export async function newParty(stage: Page): Promise<string> {
  await stage.goto("/stage");
  const frame = stage.locator("[data-stage-frame]");
  await expect(frame).toHaveAttribute("data-scene", /.+/);
  // P opens People; New party needs a hold of Enter.
  await stage.keyboard.press("p");
  const people = stage.getByRole("dialog", { name: "Tonight's Party" });
  await expect(people).toBeVisible();
  const peopleCode = people.getByTestId("people-join-code");
  await expect(peopleCode).toHaveText(/^Join with \d{4}$/);
  const old = ((await peopleCode.textContent()) ?? "").slice(-4);
  await people.getByRole("button", { name: "New party" }).focus();
  await stage.keyboard.down("Enter");
  await stage.waitForTimeout(900);
  await stage.keyboard.up("Enter");
  await expect(peopleCode).not.toHaveText(`Join with ${old}`);
  await stage.keyboard.press("Escape");
  await expect(people).toHaveCount(0);

  await expect(frame).toHaveAttribute("data-scene", "songBrowser");
  const code = stage.getByTestId("party-join-code");
  await expect(code).toHaveText(JOIN_CODE);
  await expect(code).not.toHaveText(old);
  return (await code.textContent()) ?? "";
}

export interface PhoneOptions {
  /**
   * A WAV file the Phone's microphone hears, looped. Without one, Chromium's
   * fake microphone plays its default beep.
   */
  wav?: string;
}

interface Fixtures {
  /**
   * A Stage page: desktop viewport, sharing the test's browser, in a
   * remembered Stage browser ({@link trustStageBrowser}), so `/stage` shows
   * no Admin PIN pad.
   */
  stage: Page;
  /**
   * Opens a Phone page: Chromium's mobile emulation with the microphone granted.
   * Each Phone gets its own browser, because the fake microphone's WAV is a
   * browser launch flag.
   */
  openPhone: (options?: PhoneOptions) => Promise<Page>;
  /**
   * A Stage page whose browser has Chromium's fake input devices and may use
   * the microphone, opened on `http://localhost` (not 127.0.0.1): a Stage
   * there is a secure context without HTTPS. Its own browser, because fake
   * devices are a launch flag. Chromium gives its fake devices new
   * `deviceId`s on every page load here, so a reload shows them as new.
   */
  micStage: Page;
}

export const test = base.extend<Fixtures>({
  stage: async ({ browser, baseURL }, use) => {
    const context = await browser.newContext({
      viewport: STAGE_VIEWPORT,
      ...(baseURL === undefined ? {} : { baseURL }),
    });
    await trustStageBrowser(context);
    await use(await context.newPage());
    await context.close();
  },

  micStage: async ({ baseURL }, use) => {
    const browser = await chromium.launch({
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    const context = await browser.newContext({
      viewport: STAGE_VIEWPORT,
      permissions: ["microphone"],
      ...(baseURL === undefined
        ? {}
        : { baseURL: baseURL.replace("//127.0.0.1:", "//localhost:") }),
    });
    await trustStageBrowser(context);
    await use(await context.newPage());
    await browser.close();
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

export { expect };
