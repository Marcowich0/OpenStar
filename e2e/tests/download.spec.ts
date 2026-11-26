import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { APIRequestContext, Page } from "@playwright/test";

import {
  ADMIN_PIN,
  FAKE_USDB_URL,
  STAGE_VIEWPORT,
  becomeStageWithPin,
  expect,
  fixtureLibraryFile,
  test,
} from "../fixtures";

// E2E flow 4 (#231): a Download from start to finish against the fake USDB
// and the yt-dlp stub, never the real USDB or a video site. `just e2e`
// starts the fake as its own process, gives the server its URL and fake
// credentials (the server logs in with them at start: USDB credentials are
// settings, not a form), and puts the yt-dlp stub first on the server's
// PATH.
//
// The suite shares one server and one Library, and other specs count the
// fixture Songs, so the test deletes the Song it downloaded (to the trash),
// even when it fails part-way.

/** The USDB song the fake has a text and a detail page for. */
const USDB_ID = 1;
const ARTIST = "Placeholder Artist";
const TITLE = "Re: Stacks";

/** USDB's pacing: no two requests closer than this. */
const USDB_GAP_MS = 1000;

/** Generous: the machine is shared with other builds. */
const SLOW = { timeout: 60_000 };

interface FakeRequest {
  method: string;
  path: string;
  query: string;
  body: string;
  arrivedMs: number;
}

async function fakeRequests(
  request: APIRequestContext,
): Promise<FakeRequest[]> {
  const response = await request.get(`${FAKE_USDB_URL}/__fake/requests`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as FakeRequest[];
}

interface DownloadJob {
  id: number;
  state: { type: string };
  download?: { usdbId: number; song: number | null };
}

async function downloadsOfOurSong(
  request: APIRequestContext,
): Promise<DownloadJob[]> {
  const response = await request.get("/api/jobs");
  expect(response.ok()).toBe(true);
  const { jobs } = (await response.json()) as { jobs: DownloadJob[] };
  return jobs.filter((job) => job.download?.usdbId === USDB_ID);
}

interface LibrarySong {
  id: number;
  path: string;
  title: string;
  identity: { kind: string; usdbId?: number };
}

async function librarySongsOfOurSong(
  request: APIRequestContext,
): Promise<LibrarySong[]> {
  const response = await request.get("/api/songs", {
    params: { search: "Stacks" },
  });
  expect(response.ok()).toBe(true);
  const { songs } = (await response.json()) as { songs: LibrarySong[] };
  return songs.filter(
    (song) => song.identity.kind === "usdb" && song.identity.usdbId === USDB_ID,
  );
}

/** A small JPEG drawn by the browser itself: a placeholder cover. */
async function placeholderJpeg(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2D canvas");
    context.fillStyle = "teal";
    context.fillRect(0, 0, 32, 32);
    return canvas.toDataURL("image/jpeg");
  });
  return Buffer.from(dataUrl.split(",")[1] ?? "", "base64");
}

/**
 * Leaves the Library as the fixtures made it: waits for any Download of our
 * song to end, then deletes the Songs it made (an Unlock through the API,
 * in case the test failed before its own).
 */
async function removeOurSong(request: APIRequestContext): Promise<void> {
  await expect
    .poll(
      async () =>
        (await downloadsOfOurSong(request)).filter((job) =>
          ["queued", "running"].includes(job.state.type),
        ).length,
      { timeout: 120_000 },
    )
    .toBe(0);
  const unlock = await request.post("/api/unlock", {
    data: { pin: ADMIN_PIN },
  });
  expect(unlock.status()).toBe(200);
  for (const song of await librarySongsOfOurSong(request)) {
    const response = await request.delete(`/api/songs/${String(song.id)}`);
    expect(response.status()).toBe(204);
  }
  await expect
    .poll(async () => (await librarySongsOfOurSong(request)).length, SLOW)
    .toBe(0);
}

test("a Download runs against the fake USDB and the yt-dlp stub", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  // A browser the server has never seen: no Stage trust, no Unlock.
  const context = await browser.newContext({ viewport: STAGE_VIEWPORT });
  const request = context.request;
  const stage = await context.newPage();
  try {
    expect(await librarySongsOfOurSong(request)).toEqual([]);
    // Jobs are kept, so a Download from an earlier run may be listed.
    const earlierJobs = new Set(
      (await downloadsOfOurSong(request)).map((job) => job.id),
    );
    const newDownloads = async () =>
      (await downloadsOfOurSong(request)).filter(
        (job) => !earlierJobs.has(job.id),
      );
    const firstRequest = (await fakeRequests(request)).length;

    // The server logged in to the fake with the fake credentials.
    const logins = (await fakeRequests(request)).filter(
      (r) => r.method === "POST" && r.query.includes("link=login"),
    );
    expect(logins.length).toBeGreaterThan(0);

    // The fake's list holds our song, with a cover.
    const songsSet = await request.post(`${FAKE_USDB_URL}/__fake/songs`, {
      data: [
        {
          id: USDB_ID,
          artist: ARTIST,
          title: TITLE,
          genre: "Pop",
          year: 2001,
          edition: "",
          golden: false,
          language: "English",
          creator: "placeholder-creator",
          halfStars: 8,
          views: 77,
          lastChange: 1_700_000_000,
        },
      ],
    });
    expect(songsSet.ok()).toBe(true);

    // 1. Become the Stage with the Admin PIN.
    await becomeStageWithPin(stage);
    const cover = await placeholderJpeg(stage);
    const coverSet = await request.put(
      `${FAKE_USDB_URL}/__fake/covers/${String(USDB_ID)}`,
      { data: cover },
    );
    expect(coverSet.ok()).toBe(true);

    // 2. The Admin area's Downloads screen: refetch the list, search it.
    const admin = await context.newPage();
    await admin.goto("/admin/downloads");
    await expect(admin.getByRole("button", { name: "Lock" })).toHaveCount(0);
    await admin
      .getByRole("button", { name: "Fetch the whole list again" })
      .click();
    // The refetch read the fake's list and is over: the list then holds
    // our one song.
    await expect
      .poll(
        async () =>
          (await fakeRequests(request))
            .slice(firstRequest)
            .some((r) => r.method === "POST" && r.query.includes("link=list")),
        SLOW,
      )
      .toBe(true);
    await expect(admin.getByText("1 USDB song, up to date")).toBeVisible(SLOW);
    await admin
      .getByRole("searchbox", { name: "Search USDB by artist or title" })
      .fill("stacks");
    const results = admin.getByRole("list", { name: "USDB songs" });
    await expect(results.getByRole("listitem")).toHaveCount(1, SLOW);
    await expect(results).toContainText(TITLE);
    await expect(results).not.toContainText("In Library");

    // 3. Pick a video candidate: the first search hit from the stub.
    await results.getByRole("button", { name: /Re: Stacks/ }).click();
    const picker = admin.getByRole("dialog", {
      name: `Choose the video for ${TITLE}`,
    });
    await expect(picker).toBeVisible();
    const hit = picker
      .locator("label")
      .filter({ hasText: `${ARTIST} - ${TITLE} (stub hit 1)` });
    await expect(hit).toBeVisible(SLOW);
    await hit.click();
    await expect(hit.getByRole("radio")).toBeChecked();

    // 4. Download: the guarded action asks for the PIN, which Unlocks,
    // and only then starts the Download.
    await picker.getByRole("button", { name: "Download" }).click();
    const pad = admin.getByRole("dialog", { name: "Admin PIN" });
    await expect(pad).toBeVisible();
    expect(await newDownloads()).toEqual([]);
    for (const digit of ADMIN_PIN)
      await pad.getByRole("button", { name: digit, exact: true }).click();
    await pad.getByRole("button", { name: "OK" }).click();
    await expect(pad).toHaveCount(0);
    await expect(picker).toHaveCount(0, SLOW);
    await expect(admin.getByRole("button", { name: "Lock" })).toBeVisible();

    // 5. It finishes.
    const started = admin.getByRole("list", { name: "Started Downloads" });
    const rows = started.getByRole("listitem").filter({ hasText: TITLE });
    await expect(rows).toHaveCount(earlierJobs.size + 1, SLOW);
    await expect(rows.filter({ hasText: "In the Library" })).toHaveCount(
      earlierJobs.size + 1,
      { timeout: 120_000 },
    );
    const [job, ...more] = await newDownloads();
    expect(more).toEqual([]);
    expect(job?.state.type).toBe("done");

    // 6. The new Song is listed in the Library.
    await admin
      .getByRole("navigation", { name: "Admin sections" })
      .getByRole("link", { name: "Songs", exact: true })
      .click();
    await admin
      .getByRole("searchbox", { name: "Search by artist or title" })
      .fill("stacks");
    await expect(
      admin.getByRole("list", { name: "Songs in the Library" }),
    ).toContainText(TITLE, SLOW);
    const [song, ...others] = await librarySongsOfOurSong(request);
    expect(others).toEqual([]);
    expect(song?.id).toBe(job?.download?.song);

    // 7. Its folder holds the text, the cover and the media the Download
    // wrote.
    const folder = dirname(fixtureLibraryFile(song?.path ?? ""));
    expect((await readdir(folder)).sort()).toEqual(
      ["cover.jpg", "metadata.json", "song.txt", "video.mp4"].sort(),
    );
    const text = await readFile(join(folder, "song.txt"), "latin1");
    expect(text).toContain(`#ARTIST:${ARTIST}`);
    expect(text).toContain(`#TITLE:${TITLE}`);
    expect(text).toContain("#VIDEO:video.mp4");
    expect(text).toContain("#COVER:cover.jpg");
    expect(await readFile(join(folder, "cover.jpg"))).toEqual(cover);
    const video = await readFile(join(folder, "video.mp4"));
    expect(video.subarray(4, 8).toString("latin1")).toBe("ftyp");
    expect((await stat(join(folder, "video.mp4"))).size).toBeGreaterThan(0);
    expect(
      JSON.parse(await readFile(join(folder, "metadata.json"), "utf8")),
    ).toMatchObject({
      apiId: USDB_ID,
      video: "https://www.youtube.com/watch?v=stubsearch1",
    });

    // 8. USDB was paced: no two requests closer than 1 s. The fake serves
    // the whole run, so read this test's requests, and the one before them.
    const requests = (await fakeRequests(request)).slice(
      Math.max(0, firstRequest - 1),
    );
    expect(requests.length).toBeGreaterThan(3);
    const ours = requests.map((r) => `${r.method} ${r.path}?${r.query}`);
    expect(
      ours.some((r) => r.includes(`/data/cover/${String(USDB_ID)}.jpg`)),
    ).toBe(true);
    expect(ours.some((r) => r.includes("gettxt"))).toBe(true);
    for (let i = 1; i < requests.length; i += 1) {
      const gap =
        (requests[i]?.arrivedMs ?? 0) - (requests[i - 1]?.arrivedMs ?? 0);
      expect(
        gap,
        `${ours[i - 1] ?? ""} → ${ours[i] ?? ""}`,
      ).toBeGreaterThanOrEqual(USDB_GAP_MS);
    }
  } finally {
    await removeOurSong(request);
    await context.close();
  }
});
