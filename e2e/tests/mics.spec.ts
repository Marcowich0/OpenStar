import { expect, test } from "../fixtures";

// The Mics screen with the Stage browser's own Local mics: opened from the
// Setup pill, it lists Chromium's fake input devices (never the `default`
// alias) with a live meter each, and a channel switched on and off with the
// keyboard is saved on the server at once. The Stage is on http://localhost,
// without HTTPS.

test("the Stage lists, meters and switches on its own Local mics on the Mics screen", async ({
  micStage: stage,
}) => {
  await stage.goto("/stage");
  await expect(stage.locator("[data-stage-frame]")).toHaveAttribute(
    "data-scene",
    "songBrowser",
  );
  expect(new URL(stage.url()).hostname).toBe("localhost");

  // Setup › Mics, by keyboard once the menu is open.
  await stage.getByRole("button", { name: "Setup" }).click();
  await stage.getByRole("menuitem", { name: "Mics", exact: true }).focus();
  await stage.keyboard.press("Enter");
  const mics = stage.getByRole("dialog", { name: "Mics" });
  const group = mics.getByRole("group", { name: "This browser" });
  await expect(group).toBeVisible();
  await expect(
    group.getByText("More than 2 inputs? Use a Mic bridge."),
  ).toBeVisible();

  const switches = group.getByRole("switch");
  await expect(switches.first()).toBeVisible();
  const names = await switches.evaluateAll((all) =>
    all.map((s) => s.getAttribute("aria-label") ?? ""),
  );
  expect(names.length).toBeGreaterThan(0);
  expect(names.some((n) => /default/i.test(n))).toBe(false);
  // New channels start switched off.
  for (const s of await switches.all())
    await expect(s).toHaveAttribute("aria-checked", "false");

  // Chromium's fake microphone beeps: the meters move off the floor.
  await expect
    .poll(
      async () =>
        Math.max(
          ...(await group
            .getByRole("meter")
            .evaluateAll((all) =>
              all.map((m) => Number(m.getAttribute("aria-valuenow"))),
            )),
        ),
      { timeout: 15_000, intervals: [50] },
    )
    .toBeGreaterThan(-60);

  // Switch the first channel on with Enter: no PIN, saved at once.
  const first = switches.first();
  await first.focus();
  await stage.keyboard.press("Enter");
  await expect(first).toHaveAttribute("aria-checked", "true");

  // Saved at once on the server (kept across restarts: server tests).
  const switchedOn = async () => {
    const response = await stage.request.get("/api/local-mics");
    const kept = (await response.json()) as {
      localMicId: string;
      switchedOn: boolean;
    }[];
    return kept.filter((m) => m.switchedOn).map((m) => m.localMicId);
  };
  const firstId = await first.evaluate(
    (s) => s.closest("[data-local-mic]")?.getAttribute("data-local-mic") ?? "",
  );
  await expect.poll(switchedOn).toEqual([firstId]);

  // And off again (also leaves nothing on for the tests after this one).
  await stage.keyboard.press("Enter");
  await expect(first).toHaveAttribute("aria-checked", "false");
  await expect.poll(switchedOn).toEqual([]);
});
