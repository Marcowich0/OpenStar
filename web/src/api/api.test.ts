import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerInfo } from "../generated/ServerInfo";
import { api, ApiFailure } from "./api";

const SERVER_INFO: ServerInfo = {
  version: "dev",
  schemaVersion: 3,
  libraryReadOnly: null,
  publicUrl: null,
};

function answer(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Stubs the browser's `fetch` with one answer and returns the mock. */
function serverAnswers(response: Response | Error | DOMException) {
  const fetchMock = vi.fn<
    (url: string, init?: RequestInit) => Promise<Response>
  >(() =>
    response instanceof Response
      ? Promise.resolve(response)
      : Promise.reject(response),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The failure `promise` rejects with. */
async function failureOf(promise: Promise<unknown>) {
  const error: unknown = await promise.catch((caught: unknown) => caught);
  if (!(error instanceof ApiFailure)) throw new Error("expected an ApiFailure");
  return error.failure;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the typed fetch wrapper", () => {
  it("GETs a route and returns its typed body", async () => {
    const fetchMock = serverAnswers(answer(200, SERVER_INFO));

    const info = await api("GET /api/server-info");

    expect(info).toEqual(SERVER_INFO);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/server-info");
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
  });

  it("sends a route's body as JSON", async () => {
    const fetchMock = serverAnswers(answer(200, { unlocked: true }));

    const status = await api("POST /api/unlock", { body: { pin: "1234" } });

    expect(status).toEqual({ unlocked: true });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/unlock");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ pin: "1234" }));
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it("passes the abort signal on", async () => {
    const fetchMock = serverAnswers(answer(200, SERVER_INFO));
    const controller = new AbortController();

    await api("GET /api/server-info", { signal: controller.signal });

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("surfaces an error answer as the server's code, ready for t()", async () => {
    serverAnswers(answer(403, { code: "wrongPin" }));

    const failure = await failureOf(
      api("POST /api/unlock", { body: { pin: "0000" } }),
    );

    expect(failure).toEqual({
      kind: "refused",
      status: 403,
      error: { code: "wrongPin" },
    });
  });

  it.each([
    ["an empty body", answer(500)],
    [
      "a body that is not JSON",
      new Response("Internal error", { status: 500 }),
    ],
    ["JSON that is not an ApiError", answer(422, { message: "bad" })],
    ["a code the app does not know", answer(409, { code: "newerCode" })],
  ])(
    "reports an error answer with %s by its status, never its text",
    async (_, response) => {
      serverAnswers(response);

      const failure = await failureOf(api("GET /api/server-info"));

      expect(failure).toEqual({ kind: "unexpected", status: response.status });
    },
  );

  it("reports a request that never reached the server", async () => {
    serverAnswers(new TypeError("Failed to fetch"));

    const failure = await failureOf(api("GET /api/server-info"));

    expect(failure).toEqual({ kind: "network" });
  });

  it("lets an abort through as the abort it is", async () => {
    const abort = new DOMException("aborted", "AbortError");
    serverAnswers(abort);

    await expect(api("GET /api/server-info")).rejects.toBe(abort);
  });
});
