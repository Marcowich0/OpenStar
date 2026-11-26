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

// Chromium gives its fake input devices new deviceIds on every page load, so
// a reload is the case the exact label + channel fallback is for: the named,
// switched-on Local mic is found again and re-keyed to the new id.
test("a named Local mic keeps its name and switch across a reload that changes its deviceId", async ({
  micStage: stage,
}) => {
  const openMics = async () => {
    await stage.getByRole("button", { name: "Setup" }).click();
    await stage.getByRole("menuitem", { name: "Mics", exact: true }).click();
    return stage
      .getByRole("dialog", { name: "Mics" })
      .getByRole("group", { name: "This browser" });
  };
  const kept = async () => {
    const response = await stage.request.get("/api/local-mics");
    return (await response.json()) as {
      localMicId: string;
      name: string;
      switchedOn: boolean;
    }[];
  };

  await stage.goto("/stage");
  let group = await openMics();
  const row = group.locator("li", { has: stage.getByRole("switch") }).first();
  await expect(row).toBeVisible();
  const before = (await row.getAttribute("data-local-mic")) ?? "";

  // Named with no PIN; Enter saves it.
  const name = row.getByRole("textbox");
  await name.fill("Red mic");
  await name.press("Enter");
  await row.getByRole("switch").click();
  await expect(row.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(kept)
    .toContainEqual(
      expect.objectContaining({ localMicId: before, name: "Red mic" }),
    );

  await stage.reload();
  group = await openMics();
  const redMic = group.getByRole("switch", { name: "Red mic switched on" });
  await expect(redMic).toHaveAttribute("aria-checked", "true");
  await expect(group.getByText("Red mic · not found")).toHaveCount(0);
  // Re-keyed: the one Red mic now has the id of the channel as listed now.
  const after =
    (await group
      .locator("li", {
        has: stage.getByRole("switch", { name: "Red mic switched on" }),
      })
      .getAttribute("data-local-mic")) ?? "";
  const ours = async () =>
    (await kept()).filter((m) => m.name === "Red mic").map((m) => m.localMicId);
  await expect.poll(ours).toEqual([after]);
  expect(after).not.toBe(before);

  // Leave nothing on and nothing named for the tests after this one.
  const again = group.locator(`li[data-local-mic="${after}"]`);
  await again.getByRole("switch").click();
  await expect(again.getByRole("switch")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await again.getByRole("textbox").fill("");
  await again.getByRole("textbox").press("Enter");
  await expect.poll(ours).toEqual([]);
});

test("a Local mic's Mic threshold line moves 1 dB with the arrows, saved at once as set by hand", async ({
  micStage: stage,
}) => {
  // The Stage output the Stage reports: the values are kept per output.
  const outputs: string[] = [];
  stage.on("websocket", (ws) => {
    ws.on("framesent", (frame) => {
      const message = JSON.parse(String(frame.payload)) as {
        type: string;
        stageOutput?: string;
      };
      if (message.type === "reportStageOutput" && message.stageOutput)
        outputs.push(message.stageOutput);
    });
  });
  await stage.goto("/stage");
  await stage.getByRole("button", { name: "Setup" }).click();
  await stage.getByRole("menuitem", { name: "Mics", exact: true }).click();
  const mics = stage.getByRole("dialog", { name: "Mics" });
  // The first row with a meter, and its line. Rows keep arriving as the
  // browser's inputs and the bridge's channels are listed, so "the first row"
  // is pinned to its Local mic once chosen: a locator is looked up again on
  // every use, and would otherwise move to a row that turned up above it.
  const firstRow = mics
    .locator("li")
    .filter({ has: stage.getByRole("slider") })
    .first();
  await expect(firstRow).toBeVisible();
  const pinned = (await firstRow.getAttribute("data-local-mic")) ?? "";
  expect(pinned).not.toBe("");
  const row = mics.locator(`li[data-local-mic="${pinned}"]`);
  const line = row.getByRole("slider");
  await expect(line).toBeVisible();
  await expect.poll(() => outputs.length).toBeGreaterThan(0);
  const before = Number(await line.getAttribute("data-threshold-dbfs"));

  // A hand setting is dropped until the stored values for this output have
  // loaded, and nothing on the screen says when that is: press again while
  // the line has not moved. A press that is dropped never lands later.
  await line.focus();
  await expect(async () => {
    await stage.keyboard.press("ArrowRight");
    await expect
      .poll(
        async () => Number(await line.getAttribute("data-threshold-dbfs")),
        { timeout: 3_000 },
      )
      .toBeCloseTo(before + 1);
  }).toPass();
  await expect(row.getByText("set by hand")).toBeVisible();

  // Kept on the server at once, at the current Stage output, set by hand.
  const localMicId = pinned;
  const stored = async () => {
    const response = await stage.request.get("/api/mic-settings", {
      params: { stageOutput: outputs.at(-1) ?? "" },
    });
    const body = (await response.json()) as {
      mics: {
        mic: { localMicId?: string };
        settings: { micThreshold?: { setBy: string } };
      }[];
    };
    return body.mics.find((m) => m.mic.localMicId === localMicId)?.settings
      .micThreshold?.setBy;
  };
  await expect.poll(stored).toBe("hand");

  // Back where it was, so later tests keep the same threshold.
  await stage.keyboard.press("ArrowLeft");
  await expect
    .poll(async () => Number(await line.getAttribute("data-threshold-dbfs")))
    .toBeCloseTo(before);
});
