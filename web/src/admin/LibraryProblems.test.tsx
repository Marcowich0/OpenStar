import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LibraryProblem } from "../generated/LibraryProblem";
import type { ScanStatus } from "../generated/ScanStatus";
import { fakeLibraryServer, renderLive, settle } from "./adminTestKit";
import { LibraryProblems } from "./LibraryProblems";

const idle = (finished: number): ScanStatus => ({
  running: false,
  finished,
  last: { read: 3, unchanged: 0, removed: 0, probed: 0 },
});

const PROBLEMS: LibraryProblem[] = [
  {
    path: "Readme/readme.txt",
    severity: "rejection",
    reason: { code: "missingBpm" },
  },
  {
    path: "Band - Song/Band - Song.txt",
    severity: "warning",
    reason: { code: "duplicateHeader", line: 3, header: "TITLE" },
  },
  {
    path: "Other/other.txt",
    severity: "warning",
    reason: { code: "mediaNotFound", header: "COVER", reference: "co.jpg" },
  },
];

const list = () => screen.getByRole("list", { name: "Library problems" });
const rows = () => within(list()).getAllByRole("listitem");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Library problems section", () => {
  it("lists every problem with its path and its reason", async () => {
    fakeLibraryServer({
      "GET /api/library/problems": PROBLEMS,
      "GET /api/library/scan": idle(1),
    });
    await renderLive(<LibraryProblems />);

    const [rejection, warning, media] = rows();
    expect(rejection).toHaveTextContent("Readme/readme.txt");
    expect(rejection).toHaveTextContent("Rejected");
    expect(rejection).toHaveTextContent("The file has no #BPM");
    expect(warning).toHaveTextContent("Band - Song/Band - Song.txt");
    expect(warning).toHaveTextContent("Warning");
    expect(warning).toHaveTextContent("Line 3: #TITLE appears more than once");
    expect(media).toHaveTextContent("#COVER names co.jpg, which is not found");
  });

  it("lists a hidden duplicate with the preferred copy's path", async () => {
    fakeLibraryServer({
      "GET /api/library/problems": [
        {
          path: "Copy/song.txt",
          severity: "hidden",
          reason: {
            code: "hiddenDuplicate",
            preferred: "Band - Song/song.txt",
          },
        },
      ] satisfies LibraryProblem[],
      "GET /api/library/scan": idle(1),
    });
    await renderLive(<LibraryProblems />);

    const [hidden] = rows();
    expect(hidden).toHaveTextContent("Copy/song.txt");
    expect(hidden).toHaveTextContent("Hidden");
    expect(hidden).toHaveTextContent(
      "Hidden duplicate of Band - Song/song.txt",
    );
  });

  it("says so when the Library has no problems", async () => {
    fakeLibraryServer({
      "GET /api/library/problems": [],
      "GET /api/library/scan": idle(1),
    });
    await renderLive(<LibraryProblems />);

    expect(screen.getByText("The Library has no problems")).toBeVisible();
  });

  it("starts a Rescan with no PIN, shows it running, and refreshes on the scan's notice", async () => {
    let problems: LibraryProblem[] = PROBLEMS;
    let scan = idle(1);
    const server = fakeLibraryServer({
      "GET /api/library/problems": () => problems,
      "GET /api/library/scan": () => scan,
      "POST /api/library/rescan": () => {
        scan = { ...scan, running: true };
        return scan;
      },
    });
    const live = await renderLive(<LibraryProblems />);
    expect(rows()).toHaveLength(3);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    });
    await settle();

    expect(server.count("POST /api/library/rescan")).toBe(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Scanning the Library…",
    );
    expect(screen.getByRole("button", { name: "Rescan" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(server.calls.some((call) => call.includes("unlock"))).toBe(false);

    // Nothing polls while the scan runs.
    await settle();
    expect(server.count("GET /api/library/problems")).toBe(1);
    expect(server.count("GET /api/library/scan")).toBe(1);

    problems = PROBLEMS.slice(0, 1);
    scan = idle(2);
    await live.changed("library");

    expect(rows()).toHaveLength(1);
    expect(screen.getByRole("status")).not.toHaveTextContent(
      "Scanning the Library…",
    );
    expect(screen.getByRole("button", { name: "Rescan" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("keeps the finished state when the scan's notice beats the Rescan's answer", async () => {
    let scan = idle(1);
    let answerRescan = () => {};
    fakeLibraryServer({
      "GET /api/library/problems": [],
      "GET /api/library/scan": () => scan,
      "POST /api/library/rescan": () =>
        new Promise((resolve) => {
          answerRescan = () => {
            resolve({ ...idle(1), running: true });
          };
        }),
    });
    const live = await renderLive(<LibraryProblems />);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    });
    scan = idle(2);
    await live.changed("library");
    answerRescan();
    await settle();

    expect(screen.getByRole("status")).not.toHaveTextContent(
      "Scanning the Library…",
    );
  });

  it("shows a scan already running when it opens", async () => {
    fakeLibraryServer({
      "GET /api/library/problems": [],
      "GET /api/library/scan": { running: true, finished: 0, last: null },
    });
    await renderLive(<LibraryProblems />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Scanning the Library…",
    );
  });
});
