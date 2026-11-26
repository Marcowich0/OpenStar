// The Downloads section's list of Downloads (v1 spec #47, #196): every
// Download, newest first, waiting for a slot, running with its percent,
// speed and time left, in the Library, failed with the reason, or
// cancelled. It reads `GET /api/jobs` once and then follows the
// `jobChanged` messages, which the server sends to every browser. Anyone
// may cancel a waiting or running Download: no PIN. Once a Download is in
// the Library, the browser that started it (#197) offers "Add to Queue" for
// the new Song, also with no PIN.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button as AriaButton, ProgressBar } from "react-aria-components";

import { api } from "../api/api";
import { jobsQuery } from "../api/queries";
import type { DownloadDetails } from "../generated/DownloadDetails";
import type { DownloadRate } from "../generated/DownloadRate";
import type { Job } from "../generated/Job";
import type { JobList } from "../generated/JobList";
import { userMessageText } from "../i18n/serverText";
import { t } from "../i18n/t";
import type { SongId } from "../generated/SongId";
import type { UserMessage } from "../generated/UserMessage";
import { browserStorage, liveStore } from "../live/browserLive";
import type { LiveStore } from "../live/liveStore";
import { phoneId } from "../live/phoneId";
import { request } from "../phone/joinRequests";

type Download = Job & { download: DownloadDetails };

function isDownload(job: Job): job is Download {
  return job.kind === "download" && job.download !== undefined;
}

/** `list` with `job` in its place (or added at the end), oldest first. */
function upsert(list: JobList | undefined, job: Job): JobList | undefined {
  if (list === undefined) return list;
  const jobs = list.jobs.some((kept) => kept.id === job.id)
    ? list.jobs.map((kept) => (kept.id === job.id ? job : kept))
    : [...list.jobs, job];
  return { jobs };
}

export function DownloadList({
  store,
}: {
  /** The browser's own live store by default. */
  store?: LiveStore | undefined;
}) {
  const live = store ?? liveStore();
  const queryClient = useQueryClient();
  const jobs = useQuery(jobsQuery).data?.jobs;
  useEffect(
    () =>
      live.onJobChanged((job) => {
        queryClient.setQueryData(jobsQuery.queryKey, (list) =>
          upsert(list, job),
        );
      }),
    [live, queryClient],
  );
  const thisBrowser = phoneId(browserStorage());

  const downloads = (jobs ?? []).filter(isDownload).reverse();
  if (downloads.length === 0) return null;
  return (
    <ul
      aria-label={t("admin.downloads.jobs")}
      className="flex flex-col gap-3 rounded-card-sm bg-white p-4 shadow-ledge-sm"
    >
      {downloads.map((job) => (
        <DownloadRow
          key={job.id}
          job={job}
          store={live}
          startedHere={job.download.browser === thisBrowser}
        />
      ))}
    </ul>
  );
}

function songName(details: DownloadDetails): string {
  if (details.title === null)
    return t("admin.downloads.job.unknownSong", {
      id: String(details.usdbId),
    });
  return details.title;
}

function speedText(bytesPerSecond: number): string {
  const kib = bytesPerSecond / 1024;
  if (kib < 1024)
    return t("admin.downloads.job.speedKiB", { speed: Math.round(kib) });
  return t("admin.downloads.job.speedMiB", {
    speed: Math.round((kib / 1024) * 10) / 10,
  });
}

function etaText(seconds: number): string {
  return t("admin.downloads.job.eta", {
    minutes: Math.floor(seconds / 60),
    seconds: String(seconds % 60).padStart(2, "0"),
  });
}

function rateText(rate: DownloadRate | null): string[] {
  if (rate === null) return [];
  return [
    ...(rate.bytesPerSecond === null ? [] : [speedText(rate.bytesPerSecond)]),
    ...(rate.etaSeconds === null ? [] : [etaText(rate.etaSeconds)]),
  ];
}

function stateText(job: Download): string {
  switch (job.state.type) {
    case "queued":
      return t("admin.downloads.job.waiting");
    case "running":
      return job.state.percent === null
        ? t("admin.downloads.job.starting")
        : [
            t("admin.downloads.job.percent", { percent: job.state.percent }),
            ...rateText(job.download.rate),
          ].join(" · ");
    case "done":
      return t("admin.downloads.job.done");
    case "failed":
      return job.state.reason.code === "jobCancelled"
        ? t("admin.downloads.job.cancelled")
        : t("admin.downloads.job.failed", {
            reason: userMessageText(job.state.reason),
          });
  }
}

/** `reason` is `null` when the socket dropped before the answer. */
type QueueResult = { ok: true } | { ok: false; reason: UserMessage | null };

/**
 * Adds a Request for `songId` at the end of the Queue, with this browser's
 * Party member as its adder and Player (the server's default). Succeeds once
 * the Queue holds a new Request for the Song (Request ids only grow).
 */
function queueSong(store: LiveStore, songId: SongId): Promise<QueueResult> {
  const before = store.getSnapshot().stage?.party?.queue ?? [];
  const newest = Math.max(0, ...before.map((r) => r.requestId));
  return request<QueueResult>(
    store,
    { type: "addRequest", songId, requestedPlayers: null },
    (state) =>
      state.stage?.party?.queue.some(
        (r) => r.requestId > newest && r.songId === songId,
      )
        ? { ok: true }
        : undefined,
    (reason) => ({ ok: false, reason }),
    { ok: false, reason: null },
  );
}

function DownloadRow({
  job,
  store,
  startedHere,
}: {
  job: Download;
  store: LiveStore;
  /** Whether this browser started it: only it may offer "Add to Queue". */
  startedHere: boolean;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [cancelFailed, setCancelFailed] = useState(false);
  const details = job.download;
  const running = job.state.type === "running";
  const cancellable = job.state.type === "queued" || running;
  const percent = job.state.type === "running" ? job.state.percent : null;
  const newSong =
    startedHere && job.state.type === "done" ? details.song : null;
  const [queueing, setQueueing] = useState(false);
  const [queued, setQueued] = useState(false);
  const [queueFailed, setQueueFailed] = useState<QueueResult | null>(null);

  const addToQueue = async (songId: SongId) => {
    setQueueing(true);
    setQueueFailed(null);
    const result = await queueSong(store, songId);
    setQueueing(false);
    if (result.ok) setQueued(true);
    else setQueueFailed(result);
  };

  const cancel = async () => {
    setCancelling(true);
    setCancelFailed(false);
    try {
      await api("POST /api/downloads/{id}/cancel", {
        params: { id: String(job.id) },
      });
    } catch {
      setCancelFailed(true);
    } finally {
      setCancelling(false);
    }
  };

  return (
    <li className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 grow flex-col gap-0.5">
          <h3 className="truncate text-lg leading-tight font-semibold text-ink">
            {songName(details)}
          </h3>
          {details.artist === null ? null : (
            <span className="truncate text-sm text-ink-2">
              {details.artist}
            </span>
          )}
          <span
            className={`text-sm font-semibold ${job.state.type === "failed" && job.state.reason.code !== "jobCancelled" ? "text-warn-fg" : "text-ink-2"}`}
          >
            {stateText(job)}
          </span>
        </div>
        {cancellable ? (
          <AriaButton
            isDisabled={cancelling}
            onPress={() => {
              void cancel();
            }}
            className="inline-flex min-h-12 shrink-0 cursor-pointer items-center rounded-full bg-white px-5 text-lg font-semibold text-ink shadow-ledge outline-none transition-transform duration-200 data-disabled:cursor-default data-disabled:opacity-50 data-focus-visible:outline-6 data-focus-visible:outline-yellow data-pressed:scale-95"
          >
            {t("admin.downloads.job.cancel")}
          </AriaButton>
        ) : null}
        {newSong !== null && !queued ? (
          <AriaButton
            isDisabled={queueing}
            onPress={() => {
              void addToQueue(newSong);
            }}
            className="inline-flex min-h-12 shrink-0 cursor-pointer items-center rounded-full bg-green px-5 text-lg font-semibold text-white shadow-ledge-green outline-none transition-transform duration-200 data-disabled:cursor-default data-disabled:opacity-50 data-focus-visible:outline-6 data-focus-visible:outline-yellow data-pressed:scale-95"
          >
            {t("admin.downloads.job.addToQueue")}
          </AriaButton>
        ) : null}
      </div>
      {queued ? (
        <p role="status" className="text-sm font-semibold text-ink-2">
          {t("admin.downloads.job.addedToQueue")}
        </p>
      ) : null}
      {queueFailed !== null && !queueFailed.ok ? (
        <p role="alert" className="text-sm font-semibold text-warn-fg">
          {queueFailed.reason === null
            ? t("request.noAnswer")
            : userMessageText(queueFailed.reason)}
        </p>
      ) : null}
      {running ? (
        <ProgressBar
          aria-label={songName(details)}
          value={percent ?? 0}
          isIndeterminate={percent === null}
          className="h-2 w-full overflow-hidden rounded-full bg-passed"
        >
          {({ percentage }) => (
            <div
              className="h-full rounded-full bg-green transition-[width] duration-300"
              style={{ width: `${String(percentage ?? 0)}%` }}
            />
          )}
        </ProgressBar>
      ) : null}
      {cancelFailed ? (
        <p role="alert" className="text-sm font-semibold text-warn-fg">
          {t("admin.downloads.job.cancelFailed")}
        </p>
      ) : null}
    </li>
  );
}
