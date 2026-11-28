// The Phone's own mic check and diagnostics, on the mic takeover.
//
// `ThresholdMeter`: the live level against this Phone's effective Mic
// threshold (the line the Stage scores with), and a slider that sets the
// threshold by hand, as a Local mic's meter on the Stage does. Sung notes
// should push the bar past the line; the Song alone, with nobody singing,
// should stay under it.
//
// `MicDiagnostics`: behind a toggle, everything needed to tell why a Phone
// misses singing or lags: the level against the threshold, the share of the
// last two seconds' readings that were gated, unvoiced or voiced, the pitch
// and its clarity, readings per second sent and received by the Stage, the
// clock sync, the latency split into its steps, the audio context and what
// the browser applied to the mic, and a switch for the voice processing to
// compare. "Copy" puts a JSON snapshot (`diagnosticsSnapshot`) on the
// clipboard to paste back.

import { useEffect, useRef, useState, type CSSProperties } from "react";

import { t, type MessageKey } from "../../i18n/t";
import type { ThresholdSource } from "../../mics/micSettings";
import { METER_RANGE_DBFS } from "../../mics/micSettingsQuery";
import {
  MIC_PROCESSINGS,
  isMicProcessing,
  type MicProcessing,
} from "../../pitch/capture/micDiagnostics";
import { Button } from "../../ui/Button";
import {
  diagnosticsSnapshot,
  type DiagnosticsSnapshot,
} from "../mic/diagnosticsSnapshot";
import { storeMicProcessing } from "../mic/micProcessing";
import type { PhoneMic } from "../mic/phoneMic";
import type { PhoneMicSettings } from "../mic/usePhoneMicSettings";

const { floor: FLOOR, top: TOP } = METER_RANGE_DBFS;

/** Where `dbfs` sits along the meter, 0 to 1. */
function along(dbfs: number): number {
  return (Math.max(FLOOR, Math.min(TOP, dbfs)) - FLOOR) / (TOP - FLOOR);
}

const SOURCE_TEXT = {
  default: "micCheck.source.default",
  calibration: "micCheck.source.calibration",
  hand: "micCheck.source.hand",
} as const satisfies Record<ThresholdSource, MessageKey>;

const PROCESSING_TEXT = {
  standard: "micDiagnostics.processing.standard",
  echoOnly: "micDiagnostics.processing.echoOnly",
  all: "micDiagnostics.processing.all",
  none: "micDiagnostics.processing.none",
} as const satisfies Record<MicProcessing, MessageKey>;

/** A whole dB, as the slider moves. */
const wholeDb = (dbfs: number) => Math.round(dbfs);

/**
 * The level bar with the threshold line, and the slider under it. The bar is
 * written outside React, many times a second.
 */
export function ThresholdMeter({
  mic,
  settings,
  started,
}: {
  mic: PhoneMic;
  settings: PhoneMicSettings;
  /** A Song is playing: a new threshold counts from the next one. */
  started: boolean;
}) {
  const fill = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      mic.onLevel((dbfs) => {
        fill.current?.style.setProperty("--level", String(along(dbfs)));
      }),
    [mic],
  );
  const threshold = settings.effectiveThresholdDbfs;
  useEffect(() => {
    mic.setThreshold(threshold);
  }, [mic, threshold]);
  const shown = wholeDb(threshold);
  return (
    <div className="flex w-full flex-col gap-2" data-testid="threshold-meter">
      <div
        ref={fill}
        role="img"
        aria-label={t("phoneTakeover.level")}
        className="relative h-5 w-full rounded-full bg-white/25"
        style={{ "--level": "0" } as CSSProperties}
      >
        <div
          className="h-full origin-left rounded-full bg-white transition-transform duration-75 motion-reduce:transition-none"
          style={{ transform: "scaleX(var(--level))" }}
        />
        <span
          aria-hidden="true"
          data-threshold-dbfs={threshold}
          className="absolute -top-1.5 -bottom-1.5 w-1.5 -translate-x-1/2 rounded-full bg-ink shadow-[0_0_0_2px_white]"
          style={{ left: `${String(along(threshold) * 100)}%` }}
        />
      </div>
      <label className="flex flex-col gap-1 text-left">
        <span className="flex justify-between text-base font-semibold">
          <span>{t("micCheck.threshold")}</span>
          <span className="tabular-nums">
            {t("micCheck.dbfs", { value: shown })}
          </span>
        </span>
        <input
          type="range"
          min={FLOOR}
          max={TOP}
          step={1}
          value={shown}
          disabled={!settings.ready}
          aria-valuetext={t("micCheck.dbfs", { value: shown })}
          onChange={(event) => {
            settings.setByHand(Number(event.currentTarget.value));
          }}
          className="w-full accent-white disabled:opacity-45"
        />
        <span className="text-sm text-white/80">
          {t(SOURCE_TEXT[settings.thresholdSource])}
        </span>
        {started && (
          <span className="text-sm text-white/80">
            {t("micCheck.nextSong")}
          </span>
        )}
      </label>
      <p className="text-sm text-white/80">{t("micCheck.hint")}</p>
    </div>
  );
}

const DIAGNOSTICS_KEY = "openstar.phoneMicDiagnostics";

function storedOpen(): boolean {
  try {
    return localStorage.getItem(DIAGNOSTICS_KEY) === "open";
  } catch {
    return false;
  }
}

function storeOpen(open: boolean) {
  try {
    if (open) localStorage.setItem(DIAGNOSTICS_KEY, "open");
    else localStorage.removeItem(DIAGNOSTICS_KEY);
  } catch {
    // A per-browser convenience only.
  }
}

/** How often the panel reads the mic's figures. */
const REFRESH_MS = 500;

/** The toggle, and the panel while it is open. */
export function MicDiagnostics({
  mic,
  settings,
  openAtFirst = false,
}: {
  mic: PhoneMic;
  settings: PhoneMicSettings;
  /** `?perf`: open from the start. */
  openAtFirst?: boolean;
}) {
  const [open, setOpen] = useState(() => openAtFirst || storedOpen());
  return (
    <div className="flex w-full flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          storeOpen(!open);
          setOpen(!open);
        }}
        className="mx-auto min-h-11 cursor-pointer rounded-full px-4 text-sm font-semibold text-white/80 underline outline-none focus-visible:outline-4 focus-visible:outline-yellow"
      >
        {t(open ? "micDiagnostics.hide" : "micDiagnostics.show")}
      </button>
      {open && <Panel mic={mic} settings={settings} />}
    </div>
  );
}

const userAgent = () =>
  typeof navigator === "undefined" ? "" : navigator.userAgent;

function useSnapshot(mic: PhoneMic, settings: PhoneMicSettings) {
  const latest = useRef(settings);
  useEffect(() => {
    latest.current = settings;
  });
  const take = () =>
    diagnosticsSnapshot(mic.diagnostics(), latest.current, userAgent());
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot>(() =>
    diagnosticsSnapshot(mic.diagnostics(), settings, userAgent()),
  );
  useEffect(() => {
    mic.watchStage(true);
    const timer = setInterval(() => {
      setSnapshot(take());
    }, REFRESH_MS);
    return () => {
      clearInterval(timer);
      mic.watchStage(false);
    };
    // `take` reads the newest settings through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mic]);
  return { snapshot, take };
}

const ms = (value: number | null) =>
  value === null ? "–" : t("micDiagnostics.ms", { value });
const pct = (value: number | null) =>
  value === null
    ? "–"
    : t("micDiagnostics.percent", { value: Math.round(value * 100) });
const db = (value: number | null) =>
  value === null ? "–" : t("micCheck.dbfs", { value: Math.round(value) });
const yesNo = (value: boolean | null | undefined) =>
  value === null || value === undefined
    ? "–"
    : t(value ? "micDiagnostics.yes" : "micDiagnostics.no");

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-white/70">{label}</dt>
      <dd className="text-right font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-base font-bold text-yellow">{title}</h3>
      <dl className="flex flex-col gap-0.5 text-sm">{children}</dl>
    </section>
  );
}

/** A setting the browser applied, next to what was asked for. */
function applied(
  snapshot: DiagnosticsSnapshot,
  key: "echoCancellation" | "noiseSuppression" | "autoGainControl",
): string {
  const asked = snapshot.constraints;
  const wanted =
    typeof asked === "object" && asked !== null ? asked[key] : undefined;
  const got = snapshot.trackSettings?.[key];
  return t("micDiagnostics.askedGot", {
    asked: yesNo(typeof wanted === "boolean" ? wanted : null),
    got: yesNo(typeof got === "boolean" ? got : null),
  });
}

function Panel({
  mic,
  settings,
}: {
  mic: PhoneMic;
  settings: PhoneMicSettings;
}) {
  const { snapshot, take } = useSnapshot(mic, settings);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const [text, setText] = useState<string | null>(null);
  const s = snapshot;
  const l = s.latency;
  const frames = s.frames;

  function copy() {
    const json = JSON.stringify(take(), null, 2);
    setText(json);
    const clipboard =
      typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard) {
      setCopied("failed");
      return;
    }
    clipboard.writeText(json).then(
      () => {
        setCopied("copied");
      },
      () => {
        setCopied("failed");
      },
    );
  }

  return (
    <div
      role="region"
      data-testid="phone-mic-diagnostics-panel"
      aria-label={t("phoneMic.diagnostics")}
      className="flex w-full flex-col gap-3 rounded-card bg-ink-fill/85 p-4 text-left text-white"
    >
      <Section title={t("micDiagnostics.heard")}>
        <Row
          label={t("micDiagnostics.level")}
          value={t("micDiagnostics.levelValue", {
            now: db(s.level.nowDbfs),
            p95: db(s.level.p95Dbfs),
          })}
        />
        <Row
          label={t("micDiagnostics.threshold")}
          value={`${db(s.threshold.effectiveDbfs)} · ${t(SOURCE_TEXT[s.threshold.source])}`}
        />
        <FrameBar
          gated={frames.gated}
          unvoiced={frames.unvoiced}
          voiced={frames.voiced}
        />
        <Row label={t("micDiagnostics.gated")} value={pct(frames.gated)} />
        <Row
          label={t("micDiagnostics.unvoiced")}
          value={pct(frames.unvoiced)}
        />
        <Row label={t("micDiagnostics.voiced")} value={pct(frames.voiced)} />
        <Row
          label={t("micDiagnostics.pitch")}
          value={
            s.pitch.midi === null
              ? "–"
              : t("micDiagnostics.pitchValue", {
                  midi: s.pitch.midi,
                  clarity: Math.round((s.pitch.clarity ?? 0) * 100) / 100,
                })
          }
        />
      </Section>

      <Section title={t("micDiagnostics.readings")}>
        <Row
          label={t("micDiagnostics.made")}
          value={t("micDiagnostics.perSecond", {
            count: s.rates.madePerSecond,
          })}
        />
        <Row
          label={t("micDiagnostics.sent")}
          value={t("micDiagnostics.perSecond", {
            count: s.rates.sentPerSecond,
          })}
        />
        <Row
          label={t("micDiagnostics.received")}
          value={
            s.rates.stageReceivedPerSecond === null
              ? t("micDiagnostics.noStageReport")
              : t("micDiagnostics.perSecond", {
                  count: s.rates.stageReceivedPerSecond,
                })
          }
        />
        <Row
          label={t("micDiagnostics.largestGap")}
          value={ms(l.largestGapMs)}
        />
        <Row label={t("micDiagnostics.late")} value={pct(l.lateShare)} />
      </Section>

      <Section title={t("micDiagnostics.latency")}>
        <Row
          label={t("micDiagnostics.input")}
          value={t("micDiagnostics.inMicDelay")}
        />
        <Row
          label={t("micDiagnostics.halfWindow")}
          value={ms(l.halfWindowMs)}
        />
        <Row
          label={t("micDiagnostics.workletWait")}
          value={`${ms(l.workletWaitP50Ms)} / ${ms(l.workletWaitP95Ms)}`}
        />
        <Row
          label={t("micDiagnostics.detector")}
          value={`${ms(l.detectorP50Ms)} / ${ms(l.detectorP95Ms)}`}
        />
        <Row
          label={t("micDiagnostics.network")}
          value={ms(l.networkAndRelayP50Ms)}
        />
        <Row
          label={t("micDiagnostics.toStage")}
          value={`${ms(l.captureToStageP50Ms)} / ${ms(l.captureToStageP95Ms)} / ${ms(l.captureToStageMaxMs)}`}
        />
        <Row
          label={t("micDiagnostics.stageBuffer")}
          value={ms(l.stageFrameMs)}
        />
        <Row label={t("micDiagnostics.micDelay")} value={ms(l.micDelayMs)} />
        <Row
          label={t("micDiagnostics.scoredAfter")}
          value={ms(l.scoredAfterBeatEndMs)}
        />
        <Row
          label={t("micDiagnostics.clock")}
          value={t("micDiagnostics.clockValue", {
            offset: ms(s.clock.offsetMs),
            best: ms(s.clock.bestRoundTripMs),
            p95: ms(s.clock.roundTripP95Ms),
          })}
        />
      </Section>

      <Section title={t("micDiagnostics.audio")}>
        <Row
          label={t("micDiagnostics.sampleRate")}
          value={
            s.audio.sampleRate === null
              ? "–"
              : t("micDiagnostics.hz", { value: s.audio.sampleRate })
          }
        />
        <Row
          label={t("micDiagnostics.baseLatency")}
          value={ms(s.audio.baseLatencyMs)}
        />
        <Row
          label={t("micDiagnostics.outputLatency")}
          value={ms(s.audio.outputLatencyMs)}
        />
        <Row
          label={t("micDiagnostics.echoCancellation")}
          value={applied(s, "echoCancellation")}
        />
        <Row
          label={t("micDiagnostics.noiseSuppression")}
          value={applied(s, "noiseSuppression")}
        />
        <Row
          label={t("micDiagnostics.autoGainControl")}
          value={applied(s, "autoGainControl")}
        />
        <Row
          label={t("micDiagnostics.trackMuted")}
          value={yesNo(s.track.muted)}
        />
        <Row label={t("micDiagnostics.wakeLock")} value={yesNo(s.wakeLock)} />
      </Section>

      <Processing mic={mic} current={s.processing} />

      <Button fill="white" className="w-full" onPress={copy}>
        {t("micDiagnostics.copy")}
      </Button>
      {copied && (
        <p role="status" className="text-sm text-white/80">
          {t(
            copied === "copied"
              ? "micDiagnostics.copied"
              : "micDiagnostics.copyFailed",
          )}
        </p>
      )}
      {text !== null && (
        <textarea
          readOnly
          aria-label={t("micDiagnostics.snapshot")}
          value={text}
          rows={8}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
          className="w-full rounded-card-sm bg-surface p-2 font-mono text-xs text-ink"
        />
      )}
    </div>
  );
}

/** Gated, unvoiced and voiced shares as one stacked bar. */
function FrameBar({
  gated,
  unvoiced,
  voiced,
}: {
  gated: number | null;
  unvoiced: number | null;
  voiced: number | null;
}) {
  if (gated === null || unvoiced === null || voiced === null) return null;
  const width = (v: number) => `${String(v * 100)}%`;
  return (
    <div
      aria-hidden="true"
      className="my-1 flex h-3 w-full overflow-hidden rounded-full bg-white/15"
    >
      <span className="h-full bg-white/35" style={{ width: width(gated) }} />
      <span className="h-full bg-yellow" style={{ width: width(unvoiced) }} />
      <span className="h-full bg-green" style={{ width: width(voiced) }} />
    </div>
  );
}

/** The voice processing switch: kept for this browser, used on reopening. */
function Processing({
  mic,
  current,
}: {
  mic: PhoneMic;
  current: MicProcessing;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-bold text-yellow">
        {t("micDiagnostics.processing")}
      </span>
      <select
        value={current}
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (!isMicProcessing(value)) return;
          storeMicProcessing(value);
          // The change is the tap: reopen the mic with the new processing.
          mic.reopen();
        }}
        className="min-h-11 rounded-card-sm bg-surface px-3 text-base text-ink"
      >
        {MIC_PROCESSINGS.map((p) => (
          <option key={p} value={p}>
            {t(PROCESSING_TEXT[p])}
          </option>
        ))}
      </select>
      <span className="text-white/70">
        {t("micDiagnostics.processingHint")}
      </span>
    </label>
  );
}
