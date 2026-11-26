import { expect, type APIRequestContext } from "@playwright/test";

/**
 * The Mic bridge launcher `scripts/e2e.sh` runs on the host
 * (`openstar-harness bridge-launcher`). The Playwright image's glibc is
 * older than the one the bridge binary is built against, so a spec cannot
 * run the bridge in its container: it asks the launcher, which starts the
 * built `openstar-mic-bridge --wav` on the generated multichannel WAV,
 * against the server under test, each with its own config folder (so each
 * waits for its own approval).
 */
export const BRIDGE_LAUNCHER_URL = launcherUrl();

function launcherUrl(): string {
  const url = process.env.OPENSTAR_E2E_BRIDGE_LAUNCHER_URL;
  if (url === undefined || url === "")
    throw new Error(
      "OPENSTAR_E2E_BRIDGE_LAUNCHER_URL is not set: run the suite with `just e2e`",
    );
  return url;
}

/** What the headless bridge prints while it waits for the Stage. */
const WAITING = /Waiting for approval on the Stage: code (\d{4})/;

/** A Mic bridge process the launcher started for one spec. */
export interface LaunchedBridge {
  /** The file name the WAV is given: the bridge's interface name. */
  wavName: string;
  /** Everything the bridge printed so far (stdout and stderr). */
  output: () => Promise<string>;
  /** The approval code it shows, once it waits for approval. */
  approvalCode: () => Promise<string>;
  /** Ends the process and returns its whole output. Safe to call twice. */
  stop: () => Promise<string>;
}

/**
 * Starts a Mic bridge on the generated multichannel WAV, given the file
 * name `wavName` (its interface's name on the Mics screen, so a spec tells
 * its bridge from the shared one `scripts/e2e.sh` starts). Stop it in a
 * `finally`.
 */
export async function startMicBridge(
  request: APIRequestContext,
  wavName: string,
): Promise<LaunchedBridge> {
  const started = await request.post(`${BRIDGE_LAUNCHER_URL}/bridges`, {
    data: { wavName },
  });
  expect(started.status()).toBe(201);
  const { id } = (await started.json()) as { id: number };
  const url = `${BRIDGE_LAUNCHER_URL}/bridges/${String(id)}`;
  let stopped: string | undefined;
  const output = async () =>
    stopped ?? (await (await request.get(`${url}/output`)).text());
  return {
    wavName,
    output,
    approvalCode: async () => {
      let code = "";
      await expect
        .poll(
          async () => {
            code = WAITING.exec(await output())?.[1] ?? "";
            return code;
          },
          { message: "the Mic bridge waits for approval", timeout: 20_000 },
        )
        .not.toBe("");
      return code;
    },
    stop: async () => {
      if (stopped === undefined) {
        const response = await request.delete(url);
        expect(response.status()).toBe(200);
        stopped = await response.text();
      }
      return stopped;
    },
  };
}
