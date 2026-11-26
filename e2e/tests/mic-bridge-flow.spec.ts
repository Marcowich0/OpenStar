import type { Page } from "@playwright/test";

import { ADMIN_PIN, expect, newParty, test } from "../fixtures";
import { startMicBridge } from "../bridge";
import {
  createProfile,
  joinByPad,
  liveParty,
  sendFromPhone,
  stageWithPin,
  startSong,
} from "../flows";

// Flow 5 of the end-to-end suite (spec #58, ticket #232): Local mics through
// a Mic bridge, without hardware. The test becomes the Stage with the Admin
// PIN and starts its own `openstar-mic-bridge --wav` on the generated
// 4-channel WAV (the steady tone on channel 0, silence on the rest), through
// the launcher `scripts/e2e.sh` runs on the host (`e2e/bridge.ts`). On the
// Stage's Mics screen the bridge waits for approval, is approved, lists one
// channel per WAV channel, and its tone channel is switched on. A Phone
// joins and queues Steady Tone; the Line-up seats its Player on that Local
// mic (a free Local mic comes before the Phone), and the Song plays to the
// results with the Player's Score inside BRIDGE_BAND. Flow 1's Stage, Queue
// and singing steps are shared (`e2e/flows.ts`).
//
// At the end the bridge is stopped and forgotten, pass or fail, so no Local
// mic of it is left switched on and the Mics screen shows only the shared
// bridge to the specs after this one (`e2e/tests/mic-bridge.spec.ts`).

/**
 * The bridge Player's Score. The WAV's tone never breathes, so a pipeline
 * that works hits every Beat: 10000 in 6 of 7 runs on perseus (debug
 * bridge, load average 40 to 50 on 20 cores), and 6927 once under the
 * heaviest load, when the bridge's first readings came late. The floor
 * needs most Beats hit: readings that never arrive, read the wrong pitch
 * (the tone three semitones off scores 0, see flow 1) or stop partway fall
 * below it. Flow 1's ceiling, not this one, catches a scorer that counts
 * every Beat as hit.
 */
const BRIDGE_BAND = { min: 6000, max: 10000 } as const;

/** The WAV's file name for this flow's bridge: its interface's name. */
const WAV_NAME = "flow-5.wav";

interface MicBridges {
  bridges: {
    bridgeId: string;
    open: boolean;
    channels: { source: { deviceName?: string } }[];
  }[];
}

test("flow 5: a Mic bridge in WAV-file mode is approved on the Mics screen, its tone channel sings Steady Tone, and the results show its Score in its band", async ({
  browser,
  baseURL,
  openPhone,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const { context, stage } = await stageWithPin(browser, baseURL);
  const code = await newParty(stage);
  // Started once the Stage page has settled (newParty reloads it).
  const bridge = await startMicBridge(request, WAV_NAME);
  let bridgeId: string | undefined;
  let phone: Page | undefined;
  let playing = false;
  let requestId = -1;
  try {
    const frame = stage.locator("[data-stage-frame]");

    // Setup › Mics: the bridge waits for approval with the code it shows.
    await stage.getByRole("button", { name: "Setup" }).click();
    await stage.getByRole("menuitem", { name: "Mics", exact: true }).click();
    const mics = stage.getByRole("dialog", { name: "Mics" });
    const approvalCode = await bridge.approvalCode();
    const approve = mics
      .getByRole("group", { name: "New bridges" })
      .getByRole("button", {
        name: new RegExp(`^Approve mic bridge .+, code ${approvalCode}$`),
      });
    await expect(approve).toBeVisible({ timeout: 15_000 });
    await approve.click();

    // Approved and open: one row per WAV channel, named after the file.
    const toneName = `${WAV_NAME} · Input 1`;
    const group = mics.getByTestId("mics-bridge").filter({
      has: stage.getByRole("switch", { name: `${toneName} switched on` }),
    });
    await expect(group).toBeVisible();
    await expect(group.getByText("Open", { exact: true })).toBeVisible();
    const switches = group.getByRole("switch");
    await expect(switches).toHaveCount(4);
    expect(
      await switches.evaluateAll((all) =>
        all.map((s) => s.getAttribute("aria-label")),
      ),
    ).toEqual(
      [1, 2, 3, 4].map((n) => `${WAV_NAME} · Input ${String(n)} switched on`),
    );
    const bridges = (await (
      await request.get("/api/mic-bridges")
    ).json()) as MicBridges;
    bridgeId = bridges.bridges.find((b) =>
      b.channels.some((c) => c.source.deviceName === WAV_NAME),
    )?.bridgeId;
    expect(bridgeId).toBeDefined();

    // The tone channel is switched on; the silent ones stay off.
    const tone = switches.first();
    await tone.click();
    await expect(tone).toHaveAttribute("aria-checked", "true");
    for (const silent of (await switches.all()).slice(1))
      await expect(silent).toHaveAttribute("aria-checked", "false");
    await stage.keyboard.press("Escape");
    await expect(mics).toHaveCount(0);

    // A Phone joins and queues Steady Tone from its Songs tab.
    const singer = await createProfile(request, "Bridge", "teal");
    phone = await openPhone();
    await joinByPad(phone, code, singer);
    await phone.getByRole("button", { name: "Add Steady Tone" }).click();
    const sheet = phone.getByRole("dialog", { name: "Steady Tone" });
    await sheet.getByRole("button", { name: "Add to the Queue" }).click();
    await expect(sheet).toHaveCount(0);

    // The Line-up seats the Player on the bridge's tone channel: prefill
    // takes the first free Local mic. Should an earlier spec have left
    // another Local mic switched on ahead of it, the seat's Mic list picks it.
    await expect(frame).toHaveAttribute("data-scene", "lineUp");
    requestId = (await liveParty(stage)).queue[0]?.requestId ?? -1;
    const card = stage.getByRole("group", { name: singer });
    await expect(card).toBeVisible();
    const mic = card.getByRole("button", { name: /^Mic/ });
    await expect(mic).toContainText(/\S/);
    if (!((await mic.textContent()) ?? "").includes(toneName)) {
      await mic.click();
      await stage
        .getByRole("menu", { name: `Mic for ${singer}` })
        .getByRole("menuitem", { name: toneName })
        .click();
    }
    await expect(mic).toContainText(toneName);

    playing = true;
    const { stored: ended } = await startSong(stage);
    const stored = await ended;
    playing = false;
    expect(stored.round.ended).toBe("played");
    const total =
      stored.results.players.find((p) => p.name === singer)?.total ?? -1;
    testInfo.annotations.push({
      type: "bridge Score",
      description: String(total),
    });
    expect(total).toBeGreaterThanOrEqual(BRIDGE_BAND.min);
    expect(total).toBeLessThanOrEqual(BRIDGE_BAND.max);

    // The Stage's results screen shows the Player and that Score.
    await expect(frame).toHaveAttribute("data-scene", "results");
    const bars = stage.getByTestId("results-players").getByRole("listitem");
    await expect(bars).toHaveCount(1);
    await expect(bars.nth(0)).toContainText(singer);
    await expect(bars.nth(0)).toContainText(String(total));
    await expect(stage.getByRole("button", { name: "Done" })).toBeFocused();
    await stage.keyboard.press("Enter");
    await expect(frame).toHaveAttribute("data-scene", "songBrowser");
  } finally {
    if (playing && phone)
      await sendFromPhone(phone, {
        type: "controlSong",
        requestId,
        control: "skip",
      }).catch(() => undefined);
    const output = await bridge.stop();
    await testInfo.attach("mic-bridge output", {
      body: output,
      contentType: "text/plain",
    });
    if (bridgeId !== undefined) {
      // Forget is guarded: the Unlock, then the bridge and its Local mics go.
      const unlock = await context.request.post("/api/unlock", {
        data: { pin: ADMIN_PIN },
      });
      expect(unlock.status()).toBe(200);
      const forgot = await context.request.delete(
        `/api/mic-bridges/${bridgeId}`,
      );
      expect(forgot.status()).toBe(204);
    }
    await context.close();
  }
});
