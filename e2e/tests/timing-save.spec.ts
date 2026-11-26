import { readFile } from "node:fs/promises";

import {
  ADMIN_PIN,
  FIXTURE_SONGS,
  STAGE_VIEWPORT,
  becomeStageWithPin,
  expect,
  fixtureLibraryFile,
  test,
} from "../fixtures";

// E2E flow 3 (#230): a Timing edit made in the browser lands in the Library
// as intended. A browser becomes the Stage with the Admin PIN, looks at the
// Library problems, changes a fixture Song's #GAP in the Timing editor,
// Unlocks when Save asks and saves. The Song's `.txt` is then read from the
// server's songs folder (mounted read-only at OPENSTAR_E2E_SONGS_DIR): only
// the #GAP line differs, and the Original beside it holds the old bytes.
//
// Every spec shares this Library, so the test puts the Original back at the
// end (Restore Original), and does so through the API if a step failed.

const SONG = FIXTURE_SONGS.steadyTone;
const ORIGINAL = `${SONG}.orig`;

/** The file's bytes, or `null` when it does not exist. */
async function bytesOf(relative: string): Promise<Buffer | null> {
  try {
    return await readFile(fixtureLibraryFile(relative));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The file's lines, byte for byte (`latin1` maps each byte to one char), endings kept. */
function linesOf(bytes: Buffer): string[] {
  return bytes.toString("latin1").split(/(?<=\n)/);
}

test("a Timing edit is saved from the browser and only its line changes on disk", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    viewport: STAGE_VIEWPORT,
    ...(baseURL === undefined ? {} : { baseURL }),
  });
  const page = await context.newPage();
  const before = await bytesOf(SONG);
  if (before === null) throw new Error(`${SONG} is not in the Library`);
  expect(await bytesOf(ORIGINAL)).toBeNull();
  let songId: string | null = null;

  try {
    // 1. This browser becomes the Stage with the Admin PIN.
    await becomeStageWithPin(page);

    // 2. The Library problems list the fixture Library's rejected file and why.
    await page.goto("/admin/library-problems");
    const rejected = page
      .getByRole("list", { name: "Library problems" })
      .getByRole("listitem")
      .filter({ hasText: FIXTURE_SONGS.rejected });
    await expect(rejected).toHaveCount(1);
    await expect(rejected).toContainText("#VERSION");

    // 3. The Timing editor on the fixture Song; #GAP 2000 → 2250.
    await page.goto("/admin/songs");
    await page.getByRole("link", { name: "Timing of Steady Tone" }).click();
    await expect(
      page.getByRole("heading", {
        name: "Timing: Placeholder Artist – Steady Tone",
      }),
    ).toBeVisible();
    songId = /\/admin\/songs\/(\d+)\/timing/.exec(page.url())?.[1] ?? null;
    const gap = page.getByRole("textbox", { name: "#GAP (ms)" });
    await expect(gap).toHaveValue("2000");
    await gap.fill("2250");
    await gap.press("Enter");

    const section = page.getByRole("region", { name: "What Save changes" });
    await expect(section.getByRole("row")).toHaveCount(2);
    await expect(section.getByRole("row").nth(1)).toContainText("#GAP:2250");

    // 4. Save asks for the Admin PIN (no Unlock yet); the Unlock comes
    // first, then the save is sent again and written.
    const saves: number[] = [];
    page.on("response", (response) => {
      if (
        response.request().method() === "POST" &&
        /^\/api\/songs\/\d+\/timing$/.test(new URL(response.url()).pathname)
      )
        saves.push(response.status());
    });
    await section.getByRole("button", { name: "Save" }).click();
    const pad = page.getByRole("dialog", { name: "Admin PIN" });
    await expect(pad).toBeVisible();
    for (const digit of ADMIN_PIN)
      await pad.getByRole("button", { name: digit, exact: true }).click();
    await pad.getByRole("button", { name: "OK" }).click();
    await expect(pad).toHaveCount(0);
    await expect(section.getByRole("status", { name: "Saved" })).toBeVisible();
    expect(saves).toEqual([401, 200]);
    await expect(page.getByRole("button", { name: "Lock" })).toBeVisible();

    // 5. On disk: only the #GAP line differs; the Original holds the old bytes.
    const after = await bytesOf(SONG);
    if (after === null) throw new Error(`${SONG} is gone after the save`);
    const old = linesOf(before);
    const now = linesOf(after);
    expect(now).toHaveLength(old.length);
    const changed = now.flatMap((line, i) =>
      line === old[i] ? [] : [{ line: i + 1, old: old[i], now: line }],
    );
    expect(changed).toEqual([
      { line: 5, old: "#GAP:2000\n", now: "#GAP:2250\n" },
    ]);
    expect(await bytesOf(ORIGINAL)).toEqual(before);

    // 6. Restore Original puts the fixture Song back as it was.
    await page.goto("/admin/songs");
    const row = page
      .getByRole("list", { name: "Songs in the Library" })
      .getByRole("listitem")
      .filter({ hasText: "Steady Tone" });
    await row.getByRole("button", { name: "Restore Original" }).click();
    await expect(
      row.getByRole("button", { name: "Restore Original" }),
    ).toHaveCount(0);
    await expect.poll(() => bytesOf(ORIGINAL)).toBeNull();
    expect(await bytesOf(SONG)).toEqual(before);
  } finally {
    // A step failed after the save: leave the shared Library as it was.
    if (songId !== null && (await bytesOf(ORIGINAL)) !== null) {
      const unlock = await context.request.post("/api/unlock", {
        data: { pin: ADMIN_PIN },
      });
      expect(unlock.status()).toBe(200);
      const restore = await context.request.post(
        `/api/songs/${songId}/restore-original`,
      );
      expect(restore.status()).toBe(200);
    }
    await context.close();
  }
});
