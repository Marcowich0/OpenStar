import { act } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeLibraryServer, renderLive, settle } from "../admin/adminTestKit";
import type { StoredMicSettings } from "../generated/StoredMicSettings";
import { StageMicSettingsLoader } from "./StageMicSettings";
import { createStageMicSettings } from "./stageMicSettings";

const MIA = { kind: "phone", phoneId: "phone-mia" } as const;

/** What the server keeps for Mia's Phone, by Stage output. */
function micSettingsServer(
  byOutput: Record<string, StoredMicSettings>,
  fail = false,
) {
  return fakeLibraryServer({
    "GET /api/mic-settings": (url: URL) => {
      if (fail) return new Response(null, { status: 500 });
      const stageOutput = url.searchParams.get("stageOutput") ?? "";
      const settings = byOutput[stageOutput];
      return {
        stageOutput,
        mics: settings ? [{ mic: MIA, settings }] : [],
      };
    },
  });
}

/** The output key the Stage reads, changed from the test. */
function outputKeyStore(initial: string | null) {
  let key = initial;
  const listeners = new Set<() => void>();
  return {
    set(next: string | null) {
      key = next;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => key,
  };
}

async function setup(
  initial: string | null,
  byOutput: Record<string, StoredMicSettings>,
  fail = false,
) {
  const server = micSettingsServer(byOutput, fail);
  const settings = createStageMicSettings();
  const keys = outputKeyStore(initial);
  function Stage() {
    const outputKey = useSyncExternalStore(keys.subscribe, keys.get);
    return <StageMicSettingsLoader outputKey={outputKey} settings={settings} />;
  }
  const live = await renderLive(<Stage />);
  const delay = () => settings.storedFor(MIA)?.calibration?.micDelayMs;
  return { server, settings, keys, live, delay };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StageMicSettingsLoader", () => {
  it("loads the values of the current Stage output when the Stage opens", async () => {
    const t = await setup("Speakers", {
      Speakers: { calibration: { micDelayMs: 140, bleedLevelDbfs: -50 } },
    });
    expect(t.server.calls).toContain(
      "GET /api/mic-settings?stageOutput=Speakers",
    );
    expect(t.delay()).toBe(140);
  });

  it("loads the new output's values when the output key changes, with none in between", async () => {
    const t = await setup("Speakers", {
      Speakers: { calibration: { micDelayMs: 140, bleedLevelDbfs: -50 } },
      "HDMI (LG TV)": { calibration: { micDelayMs: 260, bleedLevelDbfs: -45 } },
    });
    expect(t.delay()).toBe(140);

    t.keys.set("HDMI (LG TV)");
    // A Start now sings on the defaults, never on the old output's values.
    expect(t.settings.values()).toBeNull();
    await settle();
    expect(t.delay()).toBe(260);
  });

  it("gives the defaults at an output nothing is stored for", async () => {
    const t = await setup("Speakers", {
      Speakers: { calibration: { micDelayMs: 140, bleedLevelDbfs: -50 } },
    });
    t.keys.set("Headphones");
    await settle();
    expect(t.settings.values()?.stageOutput).toBe("Headphones");
    expect(t.settings.storedFor(MIA)).toBeUndefined();
  });

  it("refetches after a Calibration or a hand setting is stored (the micSettings notice)", async () => {
    const byOutput: Record<string, StoredMicSettings> = {};
    const t = await setup("Speakers", byOutput);
    expect(t.settings.storedFor(MIA)).toBeUndefined();

    byOutput.Speakers = {
      calibration: { micDelayMs: 90, bleedLevelDbfs: -55 },
    };
    await t.live.changed("micSettings");
    expect(t.delay()).toBe(90);
  });

  it("holds nothing while the output is unknown or this browser is not the Stage", async () => {
    const t = await setup(null, {
      Speakers: { calibration: { micDelayMs: 140, bleedLevelDbfs: -50 } },
    });
    expect(t.server.count("GET /api/mic-settings")).toBe(0);
    expect(t.settings.values()).toBeNull();
  });

  it("leaves the defaults when the values cannot be loaded", async () => {
    const t = await setup("Speakers", {}, true);
    expect(t.settings.values()).toBeNull();
  });
});
