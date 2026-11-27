import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TrashedSong } from "../generated/TrashedSong";
import { HOLD_DURATION_MS } from "../ui/hold";
import { fakeLibraryServer, renderLive, settle } from "./adminTestKit";
import { Trash } from "./Trash";

// 2026-11-20 18:30 and 2026-11-24 09:05, local time.
const OLDER = new Date(2026, 10, 20, 18, 30).getTime();
const NEWER = new Date(2026, 10, 24, 9, 5).getTime();

const TRASHED: TrashedSong[] = [
  { id: 7, originalPath: "Older/Abba - Waterloo", deletedMs: NEWER },
  { id: 3, originalPath: "Queen - Bohemian Rhapsody", deletedMs: OLDER },
];

const status = (code: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status: code,
    headers: { "Content-Type": "application/json" },
  });

/** A trash whose guarded restore answers `answer` (a `204` that empties the row by default). */
function trashServer(answer?: Response) {
  let songs = TRASHED;
  const server = fakeLibraryServer({
    "GET /api/library/trash": () => ({ songs }),
    "GET /api/unlock": { unlocked: true },
  });
  for (const s of TRASHED)
    server.answers[`POST /api/library/trash/${String(s.id)}/restore`] = () => {
      if (answer) return answer;
      songs = songs.filter((other) => other.id !== s.id);
      return status(204);
    };
  return server;
}

const list = () => screen.getByRole("list", { name: "Songs in the trash" });
const rows = () => within(list()).getAllByRole("listitem");

async function holdRestore(path: string, ms = HOLD_DURATION_MS) {
  vi.useFakeTimers();
  const button = screen.getByRole("button", { name: `Restore ${path}` });
  act(() => {
    fireEvent.pointerDown(button);
  });
  act(() => {
    vi.advanceTimersByTime(ms);
  });
  act(() => {
    fireEvent.pointerUp(button);
  });
  vi.useRealTimers();
  await settle();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the trash in the Songs section", () => {
  it("lists each trashed Song with its original path and deletion time", async () => {
    trashServer();
    await renderLive(<Trash />);

    const [waterloo, rhapsody] = rows();
    expect(waterloo).toHaveTextContent("Older/Abba - Waterloo");
    expect(waterloo).toHaveTextContent("Deleted Nov 24, 2026, 9:05 AM");
    expect(rhapsody).toHaveTextContent("Queen - Bohemian Rhapsody");
    expect(rhapsody).toHaveTextContent("Deleted Nov 20, 2026, 6:30 PM");
    expect(screen.getByText(/kept for 30 days/)).toBeVisible();
  });

  it("says when the trash is empty", async () => {
    fakeLibraryServer({ "GET /api/library/trash": { songs: [] } });
    await renderLive(<Trash />);

    expect(screen.getByText("The trash is empty")).toBeVisible();
  });

  it("does nothing on a short press", async () => {
    const server = trashServer();
    await renderLive(<Trash />);

    await holdRestore("Older/Abba - Waterloo", HOLD_DURATION_MS - 200);

    expect(server.count("POST /api/library/trash/7/restore")).toBe(0);
  });

  it("restores a Song after a press and hold; the Library notice drops its row", async () => {
    const server = trashServer();
    const live = await renderLive(<Trash />);

    await holdRestore("Older/Abba - Waterloo");
    expect(server.count("POST /api/library/trash/7/restore")).toBe(1);
    await live.changed("library");

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("Queen - Bohemian Rhapsody");
  });

  it("asks for the Admin PIN without an Unlock", async () => {
    const server = trashServer(
      status(401, { code: "unlockRequired", message: "unlock required" }),
    );
    server.answers["GET /api/unlock"] = { unlocked: false };
    await renderLive(<Trash />);

    await holdRestore("Older/Abba - Waterloo");

    expect(screen.getByRole("dialog")).toHaveTextContent("Admin PIN");
  });

  it("says why when a folder of that name exists, and keeps the row", async () => {
    trashServer(
      status(409, {
        code: "restoreFolderExists",
        params: { path: "Older/Abba - Waterloo" },
      }),
    );
    await renderLive(<Trash />);

    await holdRestore("Older/Abba - Waterloo");

    const alert = within(rows()[0] as HTMLElement).getByRole("alert");
    expect(alert).toHaveTextContent(
      "A folder named Older/Abba - Waterloo is in the Library now",
    );
    expect(rows()).toHaveLength(2);
  });
});
