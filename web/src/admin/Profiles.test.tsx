import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Profile } from "../generated/Profile";
import { STATS_ADA } from "../profile/profileStatsFixture";
import { HOLD_DURATION_MS } from "../ui/hold";
import { fakeLibraryServer, renderLive, settle } from "./adminTestKit";
import { Profiles } from "./Profiles";

const PIN = "1234";

function profile(id: number, name: string, lastSungAt: number | null) {
  return {
    id,
    name,
    avatar: { kind: "builtIn", key: "star" },
    favouriteColour: "sky",
    lastDifficulty: "medium",
    createdAt: 1_700_000_000_000,
    lastSungAt,
  } satisfies Profile;
}

// 14 March 2024, noon UTC: the same calendar day in every time zone CI runs in.
const SUNG = Date.UTC(2024, 2, 14, 12);
const ADA = profile(1, "Ada", SUNG);
const BO = profile(2, "Bo", null);

const status = (code: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status: code,
    headers: { "Content-Type": "application/json" },
  });

/**
 * A server with `profiles` and a guarded delete: `401 unlockRequired` until
 * the PIN is given, then `answer` (a `204` that drops the Profile by default).
 */
function profilesServer(
  profiles: Profile[],
  { unlocked = true, answer }: { unlocked?: boolean; answer?: Response } = {},
) {
  let list = profiles;
  let hasUnlock = unlocked;
  const server = fakeLibraryServer({
    "GET /api/profiles": () => list,
    "POST /api/unlock": (_url: URL, init: RequestInit) => {
      const { pin } = JSON.parse(init.body as string) as { pin: string };
      if (pin !== PIN) return status(403, { code: "wrongPin" });
      hasUnlock = true;
      return { unlocked: true };
    },
  });
  const deleteAnswer = (url: URL) => {
    if (!hasUnlock) return status(401, { code: "unlockRequired" });
    if (answer) return answer;
    const id = Number(url.pathname.split("/").pop());
    list = list.filter((p) => p.id !== id);
    return status(204);
  };
  for (const p of profiles)
    server.answers[`DELETE /api/profiles/${String(p.id)}`] = deleteAnswer;
  return server;
}

const list = () => screen.getByRole("list", { name: "Profiles" });
const rows = () => within(list()).getAllByRole("listitem");
const deleteButton = (name: string) =>
  screen.getByRole("button", { name: `Delete ${name}` });
const pad = () => screen.queryByRole("dialog", { name: "Admin PIN" });

/** Presses Delete for `name` for `ms`, then lets go. */
async function holdDelete(name: string, ms = HOLD_DURATION_MS) {
  vi.useFakeTimers();
  const button = deleteButton(name);
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

async function enterPin(pin: string) {
  for (const digit of pin)
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    });
  const ok = screen.getByRole("button", { name: "OK" });
  act(() => {
    fireEvent.click(ok);
  });
  await settle();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the Profiles section", () => {
  it("lists every Profile with its avatar, name and last sung", async () => {
    profilesServer([ADA, BO]);
    await renderLive(<Profiles />);

    const [ada, bo] = rows();
    expect(ada?.querySelector('[role="img"]')).toHaveAttribute(
      "aria-label",
      "Ada",
    );
    expect(ada).toHaveTextContent("Ada");
    expect(ada).toHaveTextContent("Last sung Mar 14, 2024");
    expect(bo?.querySelector('[role="img"]')).toHaveAttribute(
      "aria-label",
      "Bo",
    );
    expect(bo).toHaveTextContent("Never sung");
  });

  it("says so when there are no Profiles", async () => {
    profilesServer([]);
    await renderLive(<Profiles />);

    expect(screen.getByText("No Profiles yet")).toBeVisible();
  });

  it("refreshes on the Profiles change notice", async () => {
    const server = profilesServer([ADA]);
    const live = await renderLive(<Profiles />);
    expect(rows()).toHaveLength(1);

    server.answers["GET /api/profiles"] = [ADA, BO];
    await live.changed("profiles");

    expect(rows()).toHaveLength(2);
  });

  it("does nothing on a short press of Delete", async () => {
    const server = profilesServer([ADA, BO]);
    await renderLive(<Profiles />);

    await holdDelete("Ada", HOLD_DURATION_MS - 200);

    expect(server.count("DELETE /api/profiles/1")).toBe(0);
    expect(rows()).toHaveLength(2);
  });

  it("deletes a Profile after a press and hold", async () => {
    const server = profilesServer([ADA, BO]);
    const live = await renderLive(<Profiles />);

    await holdDelete("Ada");
    expect(server.count("DELETE /api/profiles/1")).toBe(1);
    await live.changed("profiles");

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("Bo");
  });

  it("asks for the Admin PIN first without an Unlock, then deletes", async () => {
    const server = profilesServer([ADA, BO], { unlocked: false });
    await renderLive(<Profiles />);

    await holdDelete("Ada");
    expect(pad()).not.toBeNull();
    expect(server.count("DELETE /api/profiles/1")).toBe(1);

    await enterPin(PIN);

    expect(pad()).toBeNull();
    expect(server.count("DELETE /api/profiles/1")).toBe(2);
    expect(rows()).toHaveLength(1);
  });

  it("shows the refusal while the Profile sings, and keeps it", async () => {
    profilesServer([ADA, BO], {
      answer: status(409, { code: "profileSinging" }),
    });
    await renderLive(<Profiles />);

    await holdDelete("Ada");

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "This Profile is singing in the Song that plays",
    );
    expect(rows()[0]).toContainElement(alert);
    expect(rows()).toHaveLength(2);
  });

  it("shows a Profile's page inline under its row", async () => {
    const server = profilesServer([ADA, BO]);
    server.answers["GET /api/profiles/1/stats"] = STATS_ADA;
    await renderLive(<Profiles />);
    const [ada] = rows();
    const toggle = screen.getByRole("button", { name: "Stats for Ada" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(server.count("GET /api/profiles/1/stats")).toBe(0);

    act(() => {
      fireEvent.click(toggle);
    });
    await settle();

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const page = within(ada as HTMLElement);
    expect(page.getByRole("heading", { name: "Ada" })).toBeInTheDocument();
    expect(page.getByText("Songs sung")).toBeInTheDocument();
    expect(page.getByRole("list", { name: "Most sung" })).toBeInTheDocument();

    act(() => {
      fireEvent.click(toggle);
    });
    expect(page.queryByText("Songs sung")).toBeNull();
  });
});
