import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Locator,
  Page,
  Response,
} from "@playwright/test";

import { becomeStageWithPin, expect, STAGE_VIEWPORT } from "./fixtures";

// The Stage, Queue and singing steps the end-to-end flows share (spec #58):
// flow 1 (`tests/phone-flows.spec.ts`) sings on a Phone, flow 5
// (`tests/mic-bridge-flow.spec.ts`) on a Mic bridge's Local mic.

/** How long the Steady Tone Song takes to its results, with a slow machine's margin. */
export const SONG_TO_RESULTS_MS = 60_000;

/** Makes a desktop browser the Stage through the Admin PIN pad. */
export async function stageWithPin(
  browser: Browser,
  baseURL: string | undefined,
): Promise<{ context: BrowserContext; stage: Page }> {
  const context = await browser.newContext({
    viewport: STAGE_VIEWPORT,
    ...(baseURL === undefined ? {} : { baseURL }),
  });
  const stage = await context.newPage();
  await becomeStageWithPin(stage);
  return { context, stage };
}

/** A Profile with a name no other test uses (Profiles outlive a test). */
export async function createProfile(
  request: APIRequestContext,
  prefix: string,
  favouriteColour: string,
): Promise<string> {
  const name = `${prefix} ${String(Date.now() % 100000)}`;
  const response = await request.post("/api/profiles", {
    data: { name, avatar: { kind: "builtIn", key: "star" }, favouriteColour },
  });
  expect(response.ok()).toBe(true);
  return name;
}

/**
 * Joins on `/` by typing the Join code on the pad, as the Profile `name`.
 * `search` is added to the address (`"?perf"`: the mic takeover's readout).
 */
export async function joinByPad(
  phone: Page,
  code: string,
  name: string,
  search = "",
) {
  await phone.goto(`/${search}`);
  await expect(
    phone.getByRole("heading", { name: "Join the Party" }),
  ).toBeVisible();
  for (const digit of code)
    await phone.getByRole("button", { name: digit, exact: true }).click();
  await expect(
    phone.getByRole("heading", { name: "Who's singing?" }),
  ).toBeVisible();
  await phone.getByRole("button", { name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();
}

export interface Member {
  memberId: number;
  colour: string;
  identity: {
    kind: string;
    name?: string;
    avatar?: { kind: string; key: string };
  };
}

/** The Party as a new connection of `page` is told it (`liveState`). */
export async function liveParty(
  page: Page,
): Promise<{ members: Member[]; queue: { requestId: number }[] }> {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const socket = new WebSocket(`ws://${location.host}/ws`);
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as {
            type: string;
            party?: { members: Member[]; queue: { requestId: number }[] };
          };
          if (message.type === "liveState" && message.party) {
            socket.close();
            resolve(message.party);
          }
        };
      }),
  );
}

/** Sends `message` as the Phone, over a second socket of its page (clean-up only). */
export async function sendFromPhone(
  phone: Page,
  message: object,
): Promise<void> {
  await phone.evaluate(
    (message) =>
      new Promise<void>((resolve, reject) => {
        const phoneId = localStorage.getItem("openstar.phoneId");
        const socket = new WebSocket(`ws://${location.host}/ws`);
        socket.onopen = () => {
          socket.send(JSON.stringify({ type: "hello", phoneId }));
        };
        socket.onmessage = (event) => {
          const reply = JSON.parse(String(event.data)) as { type: string };
          if (reply.type === "phoneStatus")
            socket.send(JSON.stringify(message));
          if (reply.type === "rejected") reject(new Error(String(event.data)));
          if (reply.type === "partyChanged") {
            socket.close();
            resolve();
          }
        };
      }),
    message,
  );
}

/** The Round the Stage stored when the Song ended (`POST /api/rounds`). */
export interface StoredRound {
  round: { ended: string };
  results: { players: { name: string; total: number; place: number }[] };
}

/**
 * Presses Start on the Stage's Line-up (Space, the Line-up's key) once it
 * can start, waits for the sing screen, and returns the Round the Stage
 * stores when the Song ends.
 */
export async function startSong(stage: Page): Promise<{
  /** The stored Round, once the Song played to its results. */
  stored: Promise<StoredRound>;
}> {
  const start = stage.getByRole("button", { name: "Start" });
  await expect(start).not.toHaveAttribute("aria-disabled", "true");
  const round = stage.waitForResponse(
    (r) => r.url().endsWith("/api/rounds") && r.request().method() === "POST",
    { timeout: SONG_TO_RESULTS_MS },
  );
  const stored = round.then(storedRound);
  // Awaited by the caller; never an unhandled rejection if a step below fails.
  stored.catch(() => undefined);
  await stage.keyboard.press(" ");
  await expect(stage.locator("[data-stage-frame]")).toHaveAttribute(
    "data-scene",
    "sing",
  );
  return { stored };
}

async function storedRound(response: Response): Promise<StoredRound> {
  expect(response.status()).toBe(201);
  return (await response.json()) as StoredRound;
}

/**
 * A press and hold is 700 ms (`HOLD_DURATION_MS` in `web/src/ui/hold.ts`);
 * the helpers hold a little longer. A hold is a time by definition, so this
 * is the one wait in the suite that is not a poll.
 */
const HOLD_MS = 1000;

/**
 * Presses and holds `button` past the hold: with the Enter key on it focused
 * (the Stage's keyboard, or a Phone's), or with the mouse over it.
 */
export async function holdToConfirm(
  button: Locator,
  { with: by = "keyboard" }: { with?: "keyboard" | "pointer" } = {},
) {
  const page = button.page();
  if (by === "keyboard") {
    await button.focus();
    await page.keyboard.down("Enter");
    await page.waitForTimeout(HOLD_MS);
    await page.keyboard.up("Enter");
  } else {
    await button.hover();
    await page.mouse.down();
    await page.waitForTimeout(HOLD_MS);
    await page.mouse.up();
  }
}
