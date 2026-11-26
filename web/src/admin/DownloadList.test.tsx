import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Job } from "../generated/Job";
import type { JobState } from "../generated/JobState";
import { fakeLibraryServer, renderLive, settle } from "./adminTestKit";
import { DownloadList } from "./DownloadList";

function download(
  id: number,
  state: JobState,
  {
    title = `Tune ${String(id)}`,
    rate = null,
  }: {
    title?: string | null;
    rate?: { bytesPerSecond: number | null; etaSeconds: number | null } | null;
  } = {},
): Job {
  return {
    id,
    kind: "download",
    state,
    download: {
      usdbId: 100 + id,
      artist: title === null ? null : "Placeholder Band",
      title,
      videoUrl: "https://www.youtube.com/watch?v=AAAAAAAAAAA",
      browser: "some-phone",
      rate,
    },
  };
}

const MIB = 1024 * 1024;

const list = () => screen.getByRole("list", { name: "Started Downloads" });
const rows = () => within(list()).getAllByRole("listitem");
const row = (text: string) =>
  rows().find((item) => item.textContent.includes(text)) ??
  expect.unreachable(`no row with ${text}`);

describe("DownloadList", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists waiting, running, finished, failed and cancelled Downloads, newest first", async () => {
    fakeLibraryServer({
      "GET /api/jobs": {
        jobs: [
          download(1, { type: "done" }),
          download(2, {
            type: "failed",
            reason: { code: "videoDownloadFailed" },
          }),
          download(3, { type: "failed", reason: { code: "jobCancelled" } }),
          { id: 4, kind: "loudness", state: { type: "done" } },
          download(
            5,
            { type: "running", percent: 50 },
            { rate: { bytesPerSecond: 2.5 * MIB, etaSeconds: 75 } },
          ),
          download(6, { type: "queued" }, { title: null }),
        ],
      },
    });
    await renderLive((store) => <DownloadList store={store} />);

    expect(rows().map((item) => item.querySelector("h3")?.textContent)).toEqual(
      ["USDB song 106", "Tune 5", "Tune 3", "Tune 2", "Tune 1"],
    );
    expect(row("USDB song 106")).toHaveTextContent("Waiting for a free slot");
    const running = row("Tune 5");
    expect(running).toHaveTextContent("50%");
    expect(running).toHaveTextContent("2.5 MiB/s");
    expect(running).toHaveTextContent("1:15 left");
    expect(within(running).getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    expect(row("Tune 3")).toHaveTextContent("Cancelled");
    expect(row("Tune 2")).toHaveTextContent(
      "Failed: The video couldn't be downloaded",
    );
    expect(row("Tune 1")).toHaveTextContent("In the Library");
    // Only waiting and running Downloads can be cancelled.
    expect(
      within(row("USDB song 106")).getByRole("button", { name: "Cancel" }),
    ).toBeVisible();
    expect(
      within(running).getByRole("button", { name: "Cancel" }),
    ).toBeVisible();
    for (const ended of ["Tune 1", "Tune 2", "Tune 3"])
      expect(within(row(ended)).queryByRole("button")).toBeNull();
  });

  it("follows every Download live over the WebSocket", async () => {
    fakeLibraryServer({
      "GET /api/jobs": { jobs: [download(1, { type: "queued" })] },
    });
    const live = await renderLive((store) => <DownloadList store={store} />);
    expect(row("Tune 1")).toHaveTextContent("Waiting for a free slot");

    await live.receive({
      type: "jobChanged",
      job: download(
        1,
        { type: "running", percent: 42 },
        { rate: { bytesPerSecond: 512 * 1024, etaSeconds: null } },
      ),
    });
    expect(row("Tune 1")).toHaveTextContent("42%");
    expect(row("Tune 1")).toHaveTextContent("512 KiB/s");

    // A Download another browser started appears at once.
    await live.receive({
      type: "jobChanged",
      job: download(2, { type: "queued" }),
    });
    expect(rows()).toHaveLength(2);

    await live.receive({
      type: "jobChanged",
      job: download(1, { type: "done" }),
    });
    expect(row("Tune 1")).toHaveTextContent("In the Library");
    expect(row("Tune 1")).not.toHaveTextContent("KiB/s");
  });

  it("cancels a Download without asking for the PIN", async () => {
    const server = fakeLibraryServer({
      "GET /api/jobs": {
        jobs: [download(7, { type: "running", percent: null })],
      },
      "POST /api/downloads/7/cancel": () => new Response(null, { status: 204 }),
    });
    await renderLive((store) => <DownloadList store={store} />);
    expect(row("Tune 7")).toHaveTextContent("Starting…");

    act(() => {
      fireEvent.click(
        within(row("Tune 7")).getByRole("button", { name: "Cancel" }),
      );
    });
    await settle();
    expect(server.count("POST /api/downloads/7/cancel")).toBe(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says when a cancel did not reach the server", async () => {
    fakeLibraryServer({
      "GET /api/jobs": { jobs: [download(8, { type: "queued" })] },
      "POST /api/downloads/8/cancel": () => new Response(null, { status: 404 }),
    });
    await renderLive((store) => <DownloadList store={store} />);
    act(() => {
      fireEvent.click(
        within(row("Tune 8")).getByRole("button", { name: "Cancel" }),
      );
    });
    await settle();
    expect(within(row("Tune 8")).getByRole("alert")).toHaveTextContent(
      "The Download could not be cancelled",
    );
  });

  it("shows nothing before the first Download", async () => {
    fakeLibraryServer({ "GET /api/jobs": { jobs: [] } });
    await renderLive((store) => <DownloadList store={store} />);
    expect(
      screen.queryByRole("list", { name: "Started Downloads" }),
    ).toBeNull();
  });
});
