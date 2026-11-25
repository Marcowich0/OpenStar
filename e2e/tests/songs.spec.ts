import type { APIRequestContext, Page } from "@playwright/test";

import { expect, test } from "../fixtures";

// The Songs tab and the Request sheet (#148): a Phone finds a Song by search
// and chip, opens the Request sheet, toggles who sings and adds it to the
// Queue; both Phones see it as a toast.

/** The Stage's current Join code. */
async function stageJoinCode(stage: Page): Promise<string> {
  await stage.goto("/stage");
  const code = stage.getByTestId("party-join-code");
  await expect(code).toHaveText(/^\d{4}$/);
  return (await code.textContent()) ?? "";
}

/**
 * A Profile with a name no other test uses, and a favourite colour no other
 * test's Profile holds (the server and its Party are shared).
 */
async function createProfile(
  request: APIRequestContext,
  prefix: string,
  favouriteColour: string,
): Promise<string> {
  const name = `${prefix} ${String(Date.now() % 100000)}`;
  const response = await request.post("/api/profiles", {
    data: {
      name,
      avatar: { kind: "builtIn", key: "rocket" },
      favouriteColour,
    },
  });
  expect(response.ok()).toBe(true);
  return name;
}

/** A Phone joins from the QR link as the Profile `name`. */
async function joinAs(phone: Page, code: string, name: string) {
  await phone.goto(`/?join=${code}`);
  await phone.getByRole("button", { name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();
}

/**
 * Removes every Request in the Queue over a second socket of the Phone, so
 * the shared Party's Queue is empty again for the other tests.
 */
async function emptyQueue(phone: Page) {
  await phone.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const phoneId = localStorage.getItem("openstar.phoneId");
        const socket = new WebSocket(`ws://${location.host}/ws`);
        let left: number[] | null = null;
        const next = () => {
          const requestId = left?.shift();
          if (requestId === undefined) {
            socket.close();
            resolve();
          } else
            socket.send(JSON.stringify({ type: "removeRequest", requestId }));
        };
        socket.onopen = () => {
          socket.send(JSON.stringify({ type: "hello", phoneId }));
        };
        socket.onmessage = (event) => {
          const reply = JSON.parse(String(event.data)) as {
            type: string;
            party?: { queue: { requestId: number }[] } | null;
          };
          if (reply.type === "rejected") reject(new Error(String(event.data)));
          if (reply.type === "liveState" && left === null)
            left = (reply.party?.queue ?? []).map((r) => r.requestId);
          if (reply.type === "phoneStatus" || reply.type === "partyChanged")
            next();
        };
      }),
  );
}

test("a Phone finds a Song on the Songs tab and adds it with the Request sheet", async ({
  stage,
  openPhone,
  request,
}) => {
  const code = await stageJoinCode(stage);
  const picker = await createProfile(request, "Picker", "mint");
  const partner = await createProfile(request, "Partner", "navy");

  const mine = await openPhone();
  await joinAs(mine, code, picker);
  const theirs = await openPhone();
  await joinAs(theirs, code, partner);

  try {
    // Every listed Song, with its tags; the duet is tagged.
    const songs = mine.getByRole("list", { name: "Songs" });
    await expect(songs.getByRole("listitem")).toHaveText([
      /Sine Melody.*Placeholder Artist/,
      /Steady Tone.*Placeholder Artist/,
      /Two Voices.*Placeholder Duo.*Duet/,
    ]);

    // Search by artist.
    const search = mine.getByRole("searchbox", {
      name: "Search songs or artists",
    });
    await search.fill("duo");
    await expect(songs.getByRole("listitem")).toHaveText([/Two Voices/]);
    await search.fill("");
    await expect(songs.getByRole("listitem")).toHaveCount(3);

    // The Duets chip.
    const chips = mine.getByRole("group", { name: "Filters" });
    await chips.getByRole("button", { name: "Duets" }).click();
    await expect(songs.getByRole("listitem")).toHaveText([/Two Voices/]);

    // The + button opens the Request sheet, this Phone's Profile preselected.
    await mine.getByRole("button", { name: "Add Two Voices" }).click();
    const sheet = mine.getByRole("dialog", { name: "Two Voices" });
    await expect(sheet).toContainText("a duet needs two");
    await expect(sheet).toContainText("0 Requests ahead");
    const who = sheet.getByRole("group", { name: /Who sings it\?/ });
    await expect(
      who.getByRole("button", { name: new RegExp(`^${picker}`) }),
    ).toHaveAttribute("aria-pressed", "true");
    const partnerToggle = who.getByRole("button", {
      name: new RegExp(`^${partner}`),
    });
    await expect(partnerToggle).toHaveAttribute("aria-pressed", "false");
    await partnerToggle.click();
    await expect(partnerToggle).toHaveAttribute("aria-pressed", "true");

    await sheet.getByRole("button", { name: "Add to the Queue" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(
      mine.getByRole("status", { name: "Party changes" }),
    ).toContainText("Two Voices added, number 1");
    await expect(
      theirs.getByRole("status", { name: "Party changes" }),
    ).toContainText(`${picker} added Two Voices`);
    await expect(
      theirs.getByRole("tab", { name: "Queue, 1 Request" }),
    ).toBeVisible();
  } finally {
    await emptyQueue(mine);
  }
});
