// The one place the app calls `fetch` (ESLint refuses it anywhere else). Every
// HTTP+JSON endpoint is a row of `Endpoints`, typed with the generated
// request and response types, so a wrong body or a misread response field
// fails `tsc` at the call site.

import type { ApiError } from "../generated/ApiError";
import type { ApiErrorCode } from "../generated/ApiErrorCode";
import type { JobList } from "../generated/JobList";
import type { LibraryProblem } from "../generated/LibraryProblem";
import type { LocalMic } from "../generated/LocalMic";
import type { MicBridges } from "../generated/MicBridges";
import type { NewProfile } from "../generated/NewProfile";
import type { PitchTrackStart } from "../generated/PitchTrackStart";
import type { Profile } from "../generated/Profile";
import type { ProfileEdit } from "../generated/ProfileEdit";
import type { RoundOutcome } from "../generated/RoundOutcome";
import type { ScanStatus } from "../generated/ScanStatus";
import type { ServerInfo } from "../generated/ServerInfo";
import type { SongDetail } from "../generated/SongDetail";
import type { SongHighScores } from "../generated/SongHighScores";
import type { SongId } from "../generated/SongId";
import type { SongList } from "../generated/SongList";
import type { SongQuery } from "../generated/SongQuery";
import type { RoundStored } from "../generated/RoundStored";
import type { StageTrustRequest } from "../generated/StageTrustRequest";
import type { StageTrustStatus } from "../generated/StageTrustStatus";
import type { TimingEdit } from "../generated/TimingEdit";
import type { TimingPreview } from "../generated/TimingPreview";
import type { TimingSave } from "../generated/TimingSave";
import type { TxtVersion } from "../generated/TxtVersion";
import type { UnlockRequest } from "../generated/UnlockRequest";
import type { UnlockStatus } from "../generated/UnlockStatus";
import type { UsdbMirrorStatus } from "../generated/UsdbMirrorStatus";
import type { UserMessage } from "../generated/UserMessage";

/**
 * Every HTTP+JSON endpoint, keyed `"METHOD /path"` as `endpoints.rs` mounts
 * it. `body` is the request body (absent: none is sent), `query` the URL
 * query (always optional; absent fields are left out), `response` the body
 * of a 2xx answer. A path parameter is written `{name}`, as in `endpoints.rs`;
 * the call then needs `params: { name }`.
 */
export interface Endpoints {
  "GET /api/server-info": { response: ServerInfo };
  "GET /api/local-mics": { response: LocalMic[] };
  "GET /api/mic-bridges": { response: MicBridges };
  "GET /api/unlock": { response: UnlockStatus };
  "POST /api/unlock": { body: UnlockRequest; response: UnlockStatus };
  "POST /api/unlock/heartbeat": { response: UnlockStatus };
  "POST /api/lock": { response: UnlockStatus };
  "POST /api/stage/trust": {
    body: StageTrustRequest;
    response: StageTrustStatus;
  };
  "GET /api/profiles": { response: Profile[] };
  "POST /api/profiles": { body: NewProfile; response: Profile };
  "GET /api/profiles/{id}": { response: Profile };
  "PATCH /api/profiles/{id}": { body: ProfileEdit; response: Profile };
  /** Guarded: deletes the Profile and its Score records; `204`, no body. */
  "DELETE /api/profiles/{id}": { response: null };
  "GET /api/jobs": { response: JobList };
  "GET /api/songs": { query: SongQuery; response: SongList };
  "GET /api/songs/{id}": { response: SongDetail };
  "GET /api/songs/{id}/high-scores": { response: SongHighScores };
  "POST /api/songs/{id}/pitch-track": { response: PitchTrackStart };
  "POST /api/songs/{id}/timing/preview": {
    body: TimingEdit;
    response: TimingPreview;
  };
  "POST /api/songs/{id}/timing": { body: TimingSave; response: TimingPreview };
  "POST /api/songs/{id}/restore-original": { response: TxtVersion };
  "GET /api/library/originals": { response: SongId[] };
  "GET /api/library/problems": { response: LibraryProblem[] };
  "GET /api/library/scan": { response: ScanStatus };
  "POST /api/library/rescan": { response: ScanStatus };
  "POST /api/rounds": { body: RoundOutcome; response: RoundStored };
  "GET /api/usdb/mirror": { response: UsdbMirrorStatus };
  "POST /api/usdb/mirror/refresh": { response: UsdbMirrorStatus };
  "POST /api/usdb/mirror/refetch": { response: UsdbMirrorStatus };
}

export type Route = keyof Endpoints;

/** The typed body of a 2xx answer on `R`. */
export type ResponseOf<R extends Route> = Endpoints[R]["response"];

/** The names of the `{name}` parameters in a route's path. */
export type PathParamNames<P extends string> =
  P extends `${string}{${infer Name}}${infer Rest}`
    ? Name | PathParamNames<Rest>
    : never;

type BodyOption<E> = E extends { body: infer B }
  ? { body: B }
  : { body?: never };

type QueryOption<E> = E extends { query: infer Q }
  ? { query?: Q }
  : { query?: never };

type ParamsOption<R extends string> = [PathParamNames<R>] extends [never]
  ? { params?: never }
  : { params: Record<PathParamNames<R>, string> };

export type RequestOptions<R extends Route> = {
  signal?: AbortSignal;
} & BodyOption<Endpoints[R]> &
  QueryOption<Endpoints[R]> &
  ParamsOption<R>;

/** The options argument is optional exactly when no option is required. */
type RequestArgs<R extends Route> =
  object extends RequestOptions<R>
    ? [options?: RequestOptions<R>]
    : [options: RequestOptions<R>];

/**
 * A refusal's body: an `ApiError` (the guard, the Admin PIN) or a
 * `UserMessage` (an area's own refusals, such as `profileNameTaken`). Their
 * codes do not overlap, so `switch (refusal.code)` tells them apart.
 */
export type Refusal = ApiError | UserMessage;

/**
 * Why a call failed, without any English from the server:
 * - `refused`: the server answered with a `Refusal`, a code plus its
 *   parameters; render it with `apiErrorText` or `userMessageText` from
 *   `i18n/serverText`.
 * - `unexpected`: an error answer that is not a `Refusal` (a 500 with no
 *   body, a body the server's JSON extractor refused, a code this build does
 *   not know). Only its status is kept.
 * - `network`: the request never got an answer (server down, Wi-Fi gone).
 */
export type ApiFailureReason =
  | { kind: "refused"; status: number; error: Refusal }
  | { kind: "unexpected"; status: number }
  | { kind: "network" };

/** What every failed call rejects with (except an abort, which stays an abort). */
export class ApiFailure extends Error {
  readonly failure: ApiFailureReason;

  constructor(failure: ApiFailureReason) {
    super(`API call failed: ${failure.kind}`);
    this.name = "ApiFailure";
    this.failure = failure;
  }
}

// Every code a refusal may carry. `satisfies` makes a new Rust code fail tsc
// here until it is listed, so an unknown code is never passed off as typed.
const REFUSAL_CODES = {
  wrongPin: true,
  unlockRequired: true,
  libraryReadOnly: true,
  stagePinRequired: true,
  invalidMessage: true,
  notTheStage: true,
  serverError: true,
  profileNameEmpty: true,
  profileNameTooLong: true,
  profileNameTaken: true,
  profileNotFound: true,
  joinCodeWrong: true,
  partyFull: true,
  notInParty: true,
  nameTakenTonight: true,
  colourTaken: true,
  memberNotFound: true,
  jobCancelled: true,
  jobInterrupted: true,
  toolNotFound: true,
  toolFailed: true,
  songNotInLibrary: true,
  songPreparing: true,
  requestNotFound: true,
  requestCannotMove: true,
  tooManyPlayers: true,
  playerNotInParty: true,
  playerTwice: true,
  memberSinging: true,
  profileSinging: true,
  useLeaveParty: true,
  lineUpNotWaiting: true,
  seatNotFound: true,
  micInUse: true,
  micNotAvailable: true,
  localMicNotFound: true,
  channelAlreadyLocalMic: true,
  notADuet: true,
  lineUpNotReady: true,
  noStage: true,
  noSongPlaying: true,
  requestPlaying: true,
  difficultyLocked: true,
  noResults: true,
  notABridge: true,
  bridgeRequestNotFound: true,
  adminPinWait: true,
  usdbCredentialsMissing: true,
  usdbLoginFailed: true,
  usdbNotLoggedIn: true,
  usdbUnreachable: true,
  usdbGaveUp: true,
  usdbUnexpectedStatus: true,
  pitchTrackFailed: true,
  songFileChanged: true,
  songPlaying: true,
  noOriginal: true,
} as const satisfies Record<ApiErrorCode | UserMessage["code"], true>;

/** A body with a code this build knows; its parameters are the server's. */
function isRefusal(body: unknown): body is Refusal {
  return (
    typeof body === "object" &&
    body !== null &&
    "code" in body &&
    typeof body.code === "string" &&
    Object.hasOwn(REFUSAL_CODES, body.code)
  );
}

function pathOf(path: string, params: Record<string, string> | undefined) {
  return path.replace(/\{(\w+)\}/g, (_, name: string) =>
    encodeURIComponent(params?.[name] ?? ""),
  );
}

type QueryValue = string | number | boolean | null | undefined;

/** `?a=1&b=true` from a query's fields, leaving out absent ones. */
function queryOf(query: Record<string, QueryValue> | undefined): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null)
      search.append(name, String(value));
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

// Checked by name: a `DOMException` need not be an instance of this realm's
// class (TanStack Query's own cancellation relies on the abort coming through).
function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

async function errorBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Calls one endpoint and returns its typed answer. Rejects with an
 * `ApiFailure` on any failure, or with the `AbortError` when `signal` aborts.
 */
export async function api<R extends Route>(
  route: R,
  ...[options]: RequestArgs<R>
): Promise<ResponseOf<R>> {
  // The call site is checked against `Endpoints`; from here on the options
  // are handled the same for every route.
  const response = await send(route, "application/json", options);
  // `204 No Content` has no body: such routes declare `response: null`.
  if (response.status === 204) return null;
  return (await response.json()) as ResponseOf<R>;
}

/**
 * Every endpoint whose 2xx body is bytes rather than JSON, keyed as
 * `endpoints.rs` mounts it. None takes a body or a query.
 */
export interface ByteEndpoints {
  /** The cached Pitch track's frames as stored (`fit/pitchTrackFile.ts`). */
  "GET /api/songs/{id}/pitch-track": object;
}

export type ByteRoute = keyof ByteEndpoints;

type ByteArgs<R extends ByteRoute> = [PathParamNames<R>] extends [never]
  ? [options?: { signal?: AbortSignal }]
  : [options: { signal?: AbortSignal } & ParamsOption<R>];

/**
 * Calls one byte endpoint and returns its body. Fails like `api`; a refusal
 * still comes as a JSON code.
 */
export async function apiBytes<R extends ByteRoute>(
  route: R,
  ...[options]: ByteArgs<R>
): Promise<ArrayBuffer> {
  const response = await send(
    route,
    "application/octet-stream, application/json",
    options,
  );
  return await response.arrayBuffer();
}

type Given =
  | {
      signal?: AbortSignal;
      body?: unknown;
      params?: Record<string, string>;
      query?: Record<string, QueryValue>;
    }
  | undefined;

/** Sends `route` and returns its 2xx answer, unread. */
async function send(
  route: string,
  accept: string,
  given: Given,
): Promise<Response> {
  const space = route.indexOf(" ");
  const method = route.slice(0, space);
  const path =
    pathOf(route.slice(space + 1), given?.params) + queryOf(given?.query);
  const init: RequestInit = { method, headers: { accept } };
  if (given?.signal) init.signal = given.signal;
  if (given?.body !== undefined) {
    init.body = JSON.stringify(given.body);
    init.headers = { accept, "content-type": "application/json" };
  }

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiFailure({ kind: "network" });
  }

  if (!response.ok) {
    const body = await errorBody(response);
    throw new ApiFailure(
      isRefusal(body)
        ? { kind: "refused", status: response.status, error: body }
        : { kind: "unexpected", status: response.status },
    );
  }
  return response;
}
