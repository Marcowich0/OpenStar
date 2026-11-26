import type { Browser, Page } from "@playwright/test";

import {
  E2E_USDB_IN_LIBRARY_ID,
  FAKE_USDB_URL,
  expect,
  test,
} from "../fixtures";

// The Admin area's Downloads section (#193) against the real server and the
// fake USDB (never the real one), at Phone width and with no Unlock: the
// full refetch, the search over the mirror, the sort, the "In Library"
// badge and the covers ask for no Admin PIN, and a search sends USDB
// nothing.

const PHONE_WIDTH = { width: 375, height: 740 };

/** The fake's song list, in its `FakeSong` JSON shape. */
function fakeSong(
  id: number,
  artist: string,
  title: string,
  halfStars: number,
  views: number,
) {
  return {
    id,
    artist,
    title,
    genre: "Pop",
    year: 2001,
    edition: "",
    golden: false,
    language: "English",
    creator: "placeholder-creator",
    halfStars,
    views,
    lastChange: 1_700_000_000 - id,
  };
}

const SONGS = [
  fakeSong(E2E_USDB_IN_LIBRARY_ID, "Placeholder Artist", "Sine Melody", 8, 420),
  fakeSong(900002, "Placeholder Band", "Downloadable Tune", 10, 150),
  fakeSong(900003, "Another Placeholder", "Second Tune", 5, 980),
];

interface FakeRequest {
  path: string;
  query: string;
}

async function fakeRequests(page: Page): Promise<FakeRequest[]> {
  const response = await page.request.get(`${FAKE_USDB_URL}/__fake/requests`);
  return (await response.json()) as FakeRequest[];
}

async function openPhoneBrowser(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    viewport: PHONE_WIDTH,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  return context.newPage();
}

async function expectNoSideways(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

/** A small JPEG drawn by the browser itself: a placeholder cover. */
async function placeholderJpeg(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2D canvas");
    const gradient = context.createLinearGradient(0, 0, 64, 64);
    gradient.addColorStop(0, "orange");
    gradient.addColorStop(1, "purple");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
    return canvas.toDataURL("image/jpeg");
  });
  return Buffer.from(dataUrl.split(",")[1] ?? "", "base64");
}

test("Downloads searches the USDB mirror at Phone width without a PIN", async ({
  browser,
}) => {
  const page = await openPhoneBrowser(browser);
  await page.request.post(`${FAKE_USDB_URL}/__fake/songs`, { data: SONGS });
  await page.request.put(`${FAKE_USDB_URL}/__fake/covers/900002`, {
    data: await placeholderJpeg(page),
  });

  await page.goto("/admin/downloads");
  // The start-up fill read the fake's saved list page; a full refetch by
  // hand (no PIN) brings in the songs given above.
  await page
    .getByRole("button", { name: "Fetch the whole list again" })
    .click();
  const results = page.getByRole("list", { name: "USDB songs" });
  await expect(results).toContainText("Downloadable Tune", { timeout: 20_000 });
  await expect(page.getByText("3 USDB songs, up to date")).toBeVisible({
    timeout: 20_000,
  });

  // Most views first.
  const rows = results.getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Second Tune");
  await expect(rows.nth(0)).toContainText("980 views");

  // The fixture Song with this USDB id is in the Library; the others not.
  const inLibrary = rows.filter({ hasText: "Sine Melody" });
  await expect(inLibrary).toContainText("In Library");
  await expect(rows.filter({ hasText: "In Library" })).toHaveCount(1);

  // The cover came through the server and shows as an image; the song
  // without one shows its tile.
  const cover = rows.filter({ hasText: "Downloadable Tune" }).locator("img");
  await expect(cover).toHaveAttribute("src", "/api/usdb/songs/900002/cover");
  await expect
    .poll(() => cover.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(64);
  await expect(
    rows.filter({ hasText: "Second Tune" }).locator("img"),
  ).toHaveCount(0);

  await page.getByRole("radio", { name: "Rating" }).click();
  await expect(rows.nth(0)).toContainText("Downloadable Tune");

  // Each shown cover was asked of USDB once (paced, one a second). The
  // fake is shared by the whole run, so count this test's songs only.
  const ourCovers = new Set(
    SONGS.map((song) => `/data/cover/${String(song.id)}.jpg`),
  );
  const coverRequests = async () =>
    (await fakeRequests(page)).filter((r) => ourCovers.has(r.path)).length;
  await expect.poll(coverRequests, { timeout: 10_000 }).toBe(3);

  // A search answers from the mirror and sends USDB nothing.
  const before = (await fakeRequests(page)).length;
  await page
    .getByRole("searchbox", { name: "Search USDB by artist or title" })
    .fill("sine");
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("Sine Melody");
  expect((await fakeRequests(page)).length).toBe(before);

  await expectNoSideways(page);
  await expect(page.getByRole("dialog", { name: "Admin PIN" })).toHaveCount(0);
  await page.context().close();
});
