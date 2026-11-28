// The Stage's half of the Phone mic diagnostics. It counts every Pitch
// reading that arrives from each Phone (readings per second, capture to
// arrival, the longest gap, how many came later than the scoring window
// allows) and answers a Phone's `micReportRequest` with a `micReport`: those
// figures plus the Mic delay and effective Mic threshold the Stage would use
// for it now. With `?micDebug` on the Stage's address it also shows them in a
// corner, one row per Phone: the mirror of each Phone's own view.
// `StageScreen` mounts it; without `?micDebug` it renders nothing.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { profilesQuery } from "../../api/queries";
import type { MicId } from "../../generated/MicId";
import type { PhoneId } from "../../generated/PhoneId";
import type { StageMicReport } from "../../generated/StageMicReport";
import { t } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { useLive } from "../../live/useLive";
import {
  seatMicSettings,
  stageMicSettings,
  type StageMicSettings,
} from "../../mics/stageMicSettings";
import { OPENSTAR_VOLUME } from "../../playback/gain";
import {
  createArrivalStats,
  type ArrivalStats,
} from "../../pitch/capture/micDiagnostics";
import { memberLook } from "../../phone/memberLook";

export interface StageMicReporter {
  /** Every Phone's report now, by Phone id. */
  reports: () => Map<PhoneId, StageMicReport>;
  stop: () => void;
}

/**
 * Starts counting `store`'s Phone readings and answering Phones' requests.
 * `volume` and `settings` give the Mic delay and threshold each report
 * carries, as Start would take them now.
 */
export function startStageMicReports(
  store: Pick<LiveStore, "onPitchReading" | "onMicReportRequest" | "send">,
  options: {
    now?: () => number;
    volume: () => number;
    settings?: StageMicSettings;
  },
): StageMicReporter {
  const now = options.now ?? (() => performance.now());
  const settings = options.settings ?? stageMicSettings();
  const byPhone = new Map<PhoneId, ArrivalStats>();
  const statsOf = (phoneId: PhoneId) => {
    let stats = byPhone.get(phoneId);
    if (!stats) {
      stats = createArrivalStats();
      byPhone.set(phoneId, stats);
    }
    return stats;
  };
  const reportOf = (phoneId: PhoneId): StageMicReport => {
    const mic = { kind: "phone", phoneId } as const;
    const resolved = seatMicSettings(
      mic,
      settings.storedFor(mic),
      options.volume(),
    );
    return statsOf(phoneId).report(now(), {
      micDelayMs: resolved.micDelayMs,
      micThresholdDbfs: resolved.effectiveThresholdDbfs,
    });
  };
  const stopReadings = store.onPitchReading((mic, reading) => {
    if (mic.kind !== "phone") return;
    statsOf(mic.phoneId).arrived(now(), reading.captureMs, reading.loudness);
  });
  const stopRequests = store.onMicReportRequest((mic: MicId) => {
    if (mic.kind !== "phone") return;
    store.send({ type: "micReport", mic, report: reportOf(mic.phoneId) });
  });
  return {
    reports: () =>
      new Map([...byPhone.keys()].map((id) => [id, reportOf(id)] as const)),
    stop: () => {
      stopReadings();
      stopRequests();
    },
  };
}

const selectVolume = (live: LiveState) => live.volume;
const selectParty = (live: LiveState) => live.stage?.party ?? null;

/** Whether the Stage's address asks for the mirror (`?micDebug`). */
function mirrorAsked(): boolean {
  return (
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).has("micDebug")
  );
}

/** How often the mirror refreshes. */
const MIRROR_EVERY_MS = 500;

export function StageMicReports({
  store,
  mirror = mirrorAsked(),
}: {
  store: LiveStore;
  /** Tests only: show the mirror without `?micDebug`. */
  mirror?: boolean;
}) {
  const volume = useLive(selectVolume, store) ?? OPENSTAR_VOLUME.default;
  // The reporter reads the newest volume when it answers.
  const volumeRef = useRef(volume);
  useEffect(() => {
    volumeRef.current = volume;
  });
  const [reporter, setReporter] = useState<StageMicReporter | null>(null);
  useEffect(() => {
    const started = startStageMicReports(store, {
      volume: () => volumeRef.current,
    });
    setReporter(started);
    return () => {
      started.stop();
    };
  }, [store]);
  if (!mirror || reporter === null) return null;
  return <Mirror store={store} reporter={reporter} />;
}

const round = (value: number | null) =>
  value === null ? "–" : String(Math.round(value));

function Mirror({
  store,
  reporter,
}: {
  store: LiveStore;
  reporter: StageMicReporter;
}) {
  const party = useLive(selectParty, store);
  const profiles = useQuery(profilesQuery).data;
  const [reports, setReports] = useState(() => reporter.reports());
  useEffect(() => {
    const timer = setInterval(() => {
      setReports(reporter.reports());
    }, MIRROR_EVERY_MS);
    return () => {
      clearInterval(timer);
    };
  }, [reporter]);
  const nameOf = (phoneId: PhoneId) => {
    const memberId = party?.phones.find((p) => p.phoneId === phoneId)?.memberId;
    const member = party?.members.find((m) => m.memberId === memberId);
    return (member && memberLook(member, profiles)?.name) ?? phoneId;
  };
  return (
    <aside
      aria-label={t("micDebug.title")}
      data-testid="stage-mic-debug"
      className="fixed bottom-4 left-4 z-toast max-w-[50vw] rounded-card bg-ink-fill/90 p-4 font-mono text-lg text-white"
    >
      <h2 className="mb-2 font-sans text-xl font-bold">
        {t("micDebug.title")}
      </h2>
      {reports.size === 0 && <p>{t("micDebug.none")}</p>}
      <table className="tabular-nums">
        <thead>
          <tr className="text-left text-white/70">
            <th className="pr-4">{t("micDebug.phone")}</th>
            <th className="pr-4">{t("micDebug.perSecond")}</th>
            <th className="pr-4">{t("micDebug.arrival")}</th>
            <th className="pr-4">{t("micDebug.gap")}</th>
            <th className="pr-4">{t("micDebug.late")}</th>
            <th className="pr-4">{t("micDebug.level")}</th>
            <th>{t("micDebug.delay")}</th>
          </tr>
        </thead>
        <tbody>
          {[...reports].map(([phoneId, r]) => (
            <tr key={phoneId}>
              <td className="pr-4 font-sans font-semibold">
                {nameOf(phoneId)}
              </td>
              <td className="pr-4">{r.receivedPerSecond}</td>
              <td className="pr-4">
                {t("micDebug.triple", {
                  a: round(r.arrivalP50Ms),
                  b: round(r.arrivalP95Ms),
                  c: round(r.arrivalMaxMs),
                })}
              </td>
              <td className="pr-4">{round(r.largestGapMs)}</td>
              <td className="pr-4">
                {r.lateShare === null
                  ? round(null)
                  : t("micDiagnostics.percent", {
                      value: Math.round(r.lateShare * 100),
                    })}
              </td>
              <td className="pr-4">
                {t("micDebug.pair", {
                  a: round(r.loudnessDbfs),
                  b: round(r.micThresholdDbfs),
                })}
              </td>
              <td>{round(r.micDelayMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </aside>
  );
}
