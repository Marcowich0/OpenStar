// Getting a Song's Pitch track into the browser (v1 spec #57): ask the server
// for it (`POST /api/songs/{id}/pitch-track`), which answers at once for a
// cached track or names the job computing it; follow that job's progress over
// the WebSocket's job updates, then download the frames. The desktop Timing
// editor runs it when a Song is opened; a Phone's Fit to the singing (#223)
// runs it on the button.

import { api } from "../api/api";
import type { Job } from "../generated/Job";
import type { JobId } from "../generated/JobId";
import type { SongId } from "../generated/SongId";
import type { UserMessage } from "../generated/UserMessage";
import { downloadPitchTrack, type PitchTrack } from "./pitchTrackFile";

/** Where a Pitch track stands for the screen that waits for it. */
export type PitchTrackLoad =
  /** The job is queued (`percent: null`) or running. */
  | { state: "listening"; percent: number | null }
  | { state: "ready"; track: PitchTrack }
  /** The job failed or timed out, or the track could not be fetched. */
  | { state: "failed"; reason: UserMessage };

export interface PitchTrackLoadOptions {
  /** The live store's job updates. */
  onJobChanged: (listener: (job: Job) => void) => () => void;
  /** Aborting stops listening; nothing is reported afterwards. */
  signal: AbortSignal;
}

const COULD_NOT_LISTEN: UserMessage = { code: "pitchTrackFailed" };

/**
 * Loads the Song's Pitch track, reporting each step to `report`: listening
 * (with the job's percentage) until the track is ready or has failed.
 */
export function loadPitchTrack(
  song: SongId,
  { onJobChanged, signal }: PitchTrackLoadOptions,
  report: (load: PitchTrackLoad) => void,
): void {
  let finished = false;
  const say = (load: PitchTrackLoad) => {
    if (!signal.aborted && !finished) report(load);
  };
  const finish = (load: PitchTrackLoad) => {
    say(load);
    finished = true;
    stop();
  };

  // Listen before asking, so a job that finishes before the answer arrives is
  // not missed: updates for jobs not known yet are kept by id.
  let waitingFor: JobId | null = null;
  const seen = new Map<JobId, Job>();
  const stop = onJobChanged((job) => {
    if (waitingFor === null) seen.set(job.id, job);
    else if (job.id === waitingFor) follow(job);
  });
  signal.addEventListener("abort", stop, { once: true });

  const download = () => {
    downloadPitchTrack(song, signal).then(
      (track) => {
        finish({ state: "ready", track });
      },
      () => {
        finish({ state: "failed", reason: COULD_NOT_LISTEN });
      },
    );
  };

  function follow(job: Job) {
    switch (job.state.type) {
      case "queued":
        say({ state: "listening", percent: null });
        return;
      case "running":
        say({ state: "listening", percent: job.state.percent });
        return;
      case "done":
        stop();
        download();
        return;
      case "failed":
        finish({ state: "failed", reason: job.state.reason });
        return;
    }
  }

  api("POST /api/songs/{id}/pitch-track", {
    params: { id: String(song) },
    signal,
  }).then(
    (start) => {
      if (start.state === "ready") {
        stop();
        download();
        return;
      }
      waitingFor = start.job;
      say({ state: "listening", percent: null });
      const earlier = seen.get(start.job);
      seen.clear();
      if (earlier) follow(earlier);
    },
    () => {
      finish({ state: "failed", reason: COULD_NOT_LISTEN });
    },
  );
}
