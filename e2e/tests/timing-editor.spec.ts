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
  await expect(
    page.getByRole("textbox", { name: "#VIDEOGAP (s)" }),
  ).toHaveCount(0);

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
  await expect(
    page.getByRole("textbox", { name: "#VIDEOGAP (s)" }),
  ).toHaveValue("-1.5");
  // The muted video that follows the audio.
  await expect(page.locator("video")).toHaveJSProperty("muted", true);
  await context.close();
});

// Fine-tuning by hand (#221) in real Chromium: a whole-Song drag on empty
// space and a Line shift, each committed as one edit on release; the save
// preview asks for exactly their operations. Nothing is saved.
test("dragging empty space moves the whole Song and dragging a Line shifts it", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await context.newPage();
  const previews: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/timing/preview"))
      previews.push(request.postDataJSON());
  });
  await page.goto("/admin/songs");
  await page.getByRole("link", { name: "Timing of Sine Melody" }).click();
  const detail = page.getByRole("img", { name: /detail view/ });
  await expect(detail).toHaveAttribute("data-pitch-track", "ready", {
    timeout: 60_000,
  });
  const box = await detail.boundingBox();
  if (!box) throw new Error("the detail view has no box");
  const gap = page.getByRole("textbox", { name: "#GAP (ms)" });
  const edits = page.getByRole("list", { name: "Edits" }).locator("li");

  // #GAP 1500, #BPM 300 (a Beat is 0.05 s), 110 px a second: the first Line
  // starts at 1.5 s, so 0.5 s (55 px) is empty space.
  await page.mouse.move(box.x + 55, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 200);
  await page.mouse.move(box.x + 110, box.y + 200);
  await expect(
    page.getByText("Whole Song 0.5 s later · GAP 1,500 → 2,000 ms"),
  ).toBeVisible();
  await expect(gap).toHaveValue("2000");
  await expect(edits).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("timing-drag.png") });
  await page.mouse.up();
  await expect(edits).toHaveText(["Whole Song moved: GAP 1,500 → 2,000 ms"]);

  // The first Line now spans 2–4.7 s: grab it at 3 s and drag 2 Beats later.
  await page.mouse.move(box.x + 330, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 336, box.y + 200);
  await page.mouse.move(box.x + 341, box.y + 200);
  await expect(
    page.getByText("+2 beats (0.1 s) · whole beats only"),
  ).toBeVisible();
  await page.mouse.up();
  await expect(detail).toHaveAttribute("data-selection", "0:0-0");
  await expect(edits).toHaveCount(2);
  await expect
    .poll(() => previews.at(-1))
    .toEqual({
      operations: [
        { op: "setGap", seconds: 2 },
        { op: "setNoteStart", line: 6, start: 2 },
        { op: "setNoteStart", line: 7, start: 16 },
        { op: "setNoteStart", line: 8, start: 30 },
        { op: "setNoteStart", line: 9, start: 44 },
      ],
    });
  await context.close();
});
