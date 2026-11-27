import { QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../api/queryClient";
import { ADMIN_PIN, fakeServer } from "../guarded/fakeServer";
import { HEARTBEAT_MS } from "../guarded/useUnlockHeartbeat";
import { AdminArea } from "./AdminArea";
import { AdminHome } from "./AdminHome";
import { Downloads } from "./Downloads";
import { LibraryProblems } from "./LibraryProblems";
import { Profiles } from "./Profiles";
import { Songs } from "./Songs";
import { setAdminTestSlot } from "./adminTestSlot";
import { TestGuardedAction } from "../adminTest/TestGuardedAction";

/** The Admin area's routes as `router.tsx` has them, without lazy loading. */
async function renderAdmin(url = "/admin") {
  const root = createRootRoute();
  const admin = createRoute({
    getParentRoute: () => root,
    path: "/admin",
    component: AdminArea,
  });
  const section = (path: string, component: () => React.ReactNode) =>
    createRoute({ getParentRoute: () => admin, path, component });
  const home = createRoute({
    getParentRoute: () => admin,
    path: "/",
    component: AdminHome,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      admin.addChildren([
        home,
        section("/downloads", Downloads),
        section("/songs", Songs),
        section("/library-problems", LibraryProblems),
        section("/profiles", Profiles),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await settle();
  return router;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function press(name: string | RegExp) {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

async function enterPin(pin: string) {
  for (const digit of pin) press(digit);
  const ok = screen.getByRole("button", { name: "OK" });
  act(() => {
    fireEvent.pointerDown(ok, { pointerType: "mouse" });
    fireEvent.pointerUp(ok, { pointerType: "mouse" });
    fireEvent.click(ok);
  });
  await settle();
}

const pad = () => screen.queryByRole("dialog", { name: "Admin PIN" });
const lockButton = () => screen.queryByRole("button", { name: "Lock" });
const SECTIONS = ["Downloads", "Songs", "Library problems", "Profiles"];

beforeEach(() => {
  // The router restores the scroll position, which jsdom does not implement.
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
});

afterEach(() => {
  setAdminTestSlot(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the Admin area", () => {
  it("opens without a PIN and links to its four sections", async () => {
    fakeServer();
    await renderAdmin();

    const nav = screen.getByRole("navigation", { name: "Admin sections" });
    for (const name of SECTIONS)
      expect(
        Array.from(nav.querySelectorAll("a")).some(
          (link) => link.textContent === name,
        ),
      ).toBe(true);
    expect(pad()).toBeNull();
  });

  it.each([
    ["/admin/downloads", "Downloads"],
    ["/admin/songs", "Songs"],
    ["/admin/library-problems", "Library problems"],
    ["/admin/profiles", "Profiles"],
  ])("shows %s as the %s section, with no PIN pad", async (url, name) => {
    fakeServer();
    await renderAdmin(url);

    expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    expect(pad()).toBeNull();
  });

  it("shows no Lock button without an Unlock", async () => {
    fakeServer();
    await renderAdmin();
    expect(lockButton()).toBeNull();
  });

  it("shows the Lock button while the browser holds an Unlock, and Lock ends it", async () => {
    const server = fakeServer({ unlocked: true });
    await renderAdmin();
    expect(lockButton()).toBeInTheDocument();

    press("Lock");
    await settle();

    expect(server.count("POST /api/lock")).toBe(1);
    expect(server.unlocked).toBe(false);
    expect(lockButton()).toBeNull();
  });

  it("asks for the PIN on the next guarded action after Lock", async () => {
    fakeServer({ unlocked: true });
    setAdminTestSlot(<TestGuardedAction />);
    await renderAdmin();

    press("Lock");
    await settle();
    press("Test guarded action");
    await settle();
    expect(pad()).toBeInTheDocument();
  });

  it("completes the test-only guarded action after the PIN and shows Lock", async () => {
    const server = fakeServer();
    setAdminTestSlot(<TestGuardedAction />);
    await renderAdmin();

    press("Test guarded action");
    await settle();
    expect(pad()).toBeInTheDocument();
    await enterPin(ADMIN_PIN);

    expect(screen.getByRole("status")).toHaveTextContent(
      "The guarded action is done",
    );
    expect(server.count("POST /api/unlock/heartbeat")).toBe(2);
    expect(lockButton()).toBeInTheDocument();
  });

  it("has no test-only guarded action unless a test build adds it", async () => {
    fakeServer();
    await renderAdmin();
    expect(
      screen.queryByRole("button", { name: "Test guarded action" }),
    ).toBeNull();
  });

  it("drops the Lock button when the server reports the Unlock gone", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const server = fakeServer({ unlocked: true });
    await renderAdmin();
    expect(lockButton()).toBeInTheDocument();

    server.unlocked = false; // idle expiry, or Lock in another tab
    act(() => {
      vi.advanceTimersByTime(HEARTBEAT_MS);
    });
    await settle();
    expect(lockButton()).toBeNull();
  });

  it("sends the heartbeat while it is visible", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const server = fakeServer({ unlocked: true });
    await renderAdmin("/admin/profiles");

    act(() => {
      vi.advanceTimersByTime(HEARTBEAT_MS * 2);
    });
    await settle();
    expect(server.count("POST /api/unlock/heartbeat")).toBe(2);
  });

  it.each([
    ["/admin/downloads", true],
    ["/admin/songs", true],
    ["/admin/library-problems", false],
    ["/admin/profiles", false],
  ])(
    "%s says why when the Library is read-only: %s",
    async (url, writesLibrary) => {
      fakeServer({
        libraryReadOnly: { code: "songsFolderMissing", songsDir: "/songs" },
      });
      await renderAdmin(url);

      const notice = screen.queryByText(
        "The songs folder /songs does not exist, so the Library is read-only",
      );
      if (writesLibrary) expect(notice).toBeInTheDocument();
      else expect(notice).toBeNull();
    },
  );

  it("shows no read-only notice while the Library can be written", async () => {
    fakeServer();
    await renderAdmin("/admin/songs");
    expect(screen.queryByText(/read-only/)).toBeNull();
  });
});
