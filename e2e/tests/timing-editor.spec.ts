import { expect, test } from "../fixtures";

// The desktop Timing editor (#218) against the real server, its real Pitch
// track job (ffmpeg on the fixture Library's generated audio) and no Unlock:
// a desktop browser opens a Song's timing from the Songs section, the heard
// pitch arrives, and nothing is written.

const DESKTOP = { width: 1600, height: 1000 };

test("a desktop browser opens a Song's Timing editor and sees the singing, without a PIN", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await context.newPage();
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET")
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });

  await page.goto("/admin/songs");
  await page.getByRole("link", { name: "Timing of Sine Melody" }).click();

  await expect(
    page.getByRole("heading", {
      name: "Timing: Placeholder Artist – Sine Melody",
    }),
  ).toBeVisible();
  const detail = page.getByRole("img", { name: /detail view/ });
  // The job computes the track (or the cache has it); the dots and the share follow.
  await expect(detail).toHaveAttribute("data-pitch-track", "ready", {
    timeout: 60_000,
  });
  const share = page.getByRole("meter", { name: "Notes on the singing" });
  await expect(share).toBeVisible();
  // The fixture's audio is its own Notes, sung exactly.
  expect(Number(await share.getAttribute("aria-valuenow"))).toBeGreaterThan(80);

  // The wheel moves in time; dragging on the ruler moves the playhead.
  const box = await detail.boundingBox();
  if (!box) throw new Error("the detail view has no box");
  await page.mouse.move(box.x + 300, box.y + 200);
  await page.mouse.wheel(0, 220);
  await expect(detail).toHaveAttribute("data-view-start", "2");
  await page.mouse.move(box.x + 110, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 220, box.y + 12);
  await page.mouse.up();
  await expect(detail).toHaveAttribute("data-playhead", "4");

  await expect(page.getByRole("dialog", { name: "Admin PIN" })).toHaveCount(0);
  // Opening asked for the Pitch track and nothing else that changes anything.
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatch(/^POST \/api\/songs\/\d+\/pitch-track$/);
  await context.close();
});

// Checking by ear (#220): the editor plays the Song through the page's one
// AudioContext in real Chromium; the drawn playhead follows Song time, the
// speeds keep the pitch, L loops the Line at the playhead.
test("the Timing editor plays the Song, slows it and loops a Line", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await context.newPage();
  await page.goto("/admin/songs");
  await page.getByRole("link", { name: "Timing of Sine Melody" }).click();
  const detail = page.getByRole("img", { name: /detail view/ });
  await expect(detail).toHaveAttribute("data-playing", "false");
  // No #VIDEOGAP field: this Song's video is no separate file.
  await expect(page.getByRole("textbox", { name: "#VIDEOGAP (s)" })).toHaveCount(
    0,
  );

  await page.keyboard.press("Space");
  await expect(detail).toHaveAttribute("data-playing", "true");
  // Song time runs, and the drawing with it.
  await expect
    .poll(async () => Number(await detail.getAttribute("data-playhead")), {
      timeout: 10_000,
    })
    .toBeGreaterThan(1);

  await page.keyboard.press("3");
  await expect(detail).toHaveAttribute("data-rate", "0.5");
  expect(
    await page.evaluate(() => {
      const audio = document.querySelector("audio");
      return audio && [audio.playbackRate, audio.preservesPitch];
    }),
  ).toEqual([0.5, true]);

  await page.keyboard.press("l");
  const loop = await detail.getAttribute("data-loop");
  expect(loop).toMatch(/^[\d.]+-[\d.]+$/);
  const [start, end] = (loop ?? "").split("-").map(Number);
  // It plays inside the loop.
  await expect
    .poll(async () => {
      const at = Number(await detail.getAttribute("data-playhead"));
      return at >= (start ?? 0) - 0.3 && at <= (end ?? 0) + 0.3;
    })
    .toBe(true);

  await page.keyboard.press("p");
  await expect(detail).toHaveAttribute("data-playing", "false");
  await context.close();
});

test("the #VIDEOGAP field shows for a Song whose video is a separate file", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await context.newPage();
  await page.goto("/admin/songs");
  await page.getByRole("link", { name: "Timing of Separate Video" }).click();
  await expect(page.getByRole("textbox", { name: "#VIDEOGAP (s)" })).toHaveValue(
    "-1.5",
  );
  // The muted video that follows the audio.
  await expect(page.locator("video")).toHaveJSProperty("muted", true);
  await context.close();
});
