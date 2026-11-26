import { afterEach, describe, expect, it, vi } from "vitest";

import { createStageTrust } from "./stageTrust";

const ADMIN_PIN = "4321";

/**
 * A fake server for `POST /api/stage/trust`: a remembered browser (after a
 * correct PIN) is answered with no PIN; otherwise no PIN is
 * `403 stagePinRequired` and a wrong one `403 wrongPin`.
 */
function fakeServer() {
  const server = { remembered: false, bodies: [] as unknown[], down: false };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      expect(url).toBe("/api/stage/trust");
      expect(init.method).toBe("POST");
      if (server.down) return Promise.reject(new TypeError("offline"));
      const body = JSON.parse(init.body as string) as { pin?: string };
      server.bodies.push(body);
      if (server.remembered)
        return Promise.resolve(json(200, { trusted: true }));
      if (body.pin === undefined)
        return Promise.resolve(json(403, { code: "stagePinRequired" }));
      if (body.pin !== ADMIN_PIN)
        return Promise.resolve(json(403, { code: "wrongPin" }));
      server.remembered = true;
      return Promise.resolve(json(200, { trusted: true }));
    }),
  );
  return server;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Stage trust", () => {
  it("lets a remembered browser connect with no PIN", async () => {
    const server = fakeServer();
    server.remembered = true;
    const trust = createStageTrust();
    expect(trust.getSnapshot()).toBe("checking");
    await trust.whenTrusted();
    expect(trust.getSnapshot()).toBe("trusted");
    expect(server.bodies).toEqual([{}]);
  });

  it("waits for the Admin PIN when the server asks for it", async () => {
    fakeServer();
    const trust = createStageTrust();
    const seen: string[] = [];
    trust.subscribe(() => seen.push(trust.getSnapshot()));
    let connected = false;
    const waiting = trust.whenTrusted().then(() => {
      connected = true;
    });
    await vi.waitFor(() => {
      expect(trust.getSnapshot()).toBe("pinNeeded");
    });

    await expect(trust.giveAdminPin("0000")).rejects.toMatchObject({
      failure: { kind: "refused", error: { code: "wrongPin" } },
    });
    await Promise.resolve();
    expect(connected).toBe(false);
    expect(trust.getSnapshot()).toBe("pinNeeded");

    await trust.giveAdminPin(ADMIN_PIN);
    await waiting;
    expect(connected).toBe(true);
    expect(seen).toEqual(["pinNeeded", "trusted"]);
  });

  it("asks again before every connection, so a changed PIN brings the pad back", async () => {
    const server = fakeServer();
    server.remembered = true;
    const trust = createStageTrust();
    await trust.whenTrusted();
    server.remembered = false;
    void trust.whenTrusted();
    await vi.waitFor(() => {
      expect(trust.getSnapshot()).toBe("pinNeeded");
    });
  });

  it("lets the socket try when the server cannot be reached", async () => {
    const server = fakeServer();
    server.down = true;
    const trust = createStageTrust();
    await trust.whenTrusted();
    expect(trust.getSnapshot()).toBe("checking");
  });
});
