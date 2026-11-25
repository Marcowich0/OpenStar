// Compile-time checks of the typed fetch wrapper. This file is never run:
// `tsc` checks it, and each `@ts-expect-error` fails the build if its line
// stops being an error.

import { api, type PathParamNames } from "./api";

export async function apiTypeChecks() {
  const info = await api("GET /api/server-info");
  const version: string = info.version;
  const schemaVersion: number = info.schemaVersion;

  // @ts-expect-error: `ServerInfo` has no `buildId` field.
  const buildId: unknown = info.buildId;

  // @ts-expect-error: `schemaVersion` is a number, not a string.
  const misread: string = info.schemaVersion;

  await api("POST /api/unlock", { body: { pin: "1234" } });

  // @ts-expect-error: `POST /api/unlock` needs its body.
  await api("POST /api/unlock");

  // @ts-expect-error: the body is an `UnlockRequest`, with `pin`.
  await api("POST /api/unlock", { body: { code: "1234" } });

  // @ts-expect-error: `pin` is a string.
  await api("POST /api/unlock", { body: { pin: 1234 } });

  // @ts-expect-error: `GET /api/server-info` takes no body.
  await api("GET /api/server-info", { body: { pin: "1234" } });

  // @ts-expect-error: there is no such endpoint.
  await api("GET /api/server-infos");

  // @ts-expect-error: the method is part of the route.
  await api("/api/server-info");

  await api("GET /api/profiles/{id}", { params: { id: "3" } });

  // @ts-expect-error: `GET /api/profiles/{id}` needs its `id`.
  await api("GET /api/profiles/{id}");

  // @ts-expect-error: the parameter is `id`, not `profileId`.
  await api("GET /api/profiles/{id}", { params: { profileId: "3" } });

  // @ts-expect-error: `GET /api/server-info` has no path parameters.
  await api("GET /api/server-info", { params: { id: "3" } });

  // A route with `{name}` path parameters needs `params` with those names.
  const both: PathParamNames<"PUT /api/profiles/{id}/avatar/{key}"> = "key";
  const none: [PathParamNames<"GET /api/server-info">] extends [never]
    ? true
    : false = true;
  // @ts-expect-error: `name` is not a parameter of this path.
  const wrong: PathParamNames<"GET /api/profiles/{id}"> = "name";

  return { version, schemaVersion, buildId, misread, both, none, wrong };
}
