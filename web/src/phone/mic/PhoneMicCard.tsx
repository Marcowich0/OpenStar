// The Phone's mic strip (ticket #128): while this Phone is the Mic of a seat
// in the Line-up, "Turn on my mic" opens it with one tap, and the small
// diagnostics readout shows readings per second and the detector's cost per
// window. After the page was hidden (a lost mic, #166) it says "Your mic
// stopped" and offers Sing again. The full-screen mic takeover (#167)
// replaces this strip.

import { useSyncExternalStore } from "react";

import type { PhoneId } from "../../generated/PhoneId";
import { t } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { useLive } from "../../live/useLive";
import { Button } from "../../ui/Button";
import type { PhoneMic } from "./phoneMic";

/** Whether the Phone `phoneId` is the Mic of a seat in the Line-up. */
export function isSeatedMic(state: LiveState, phoneId: PhoneId): boolean {
  return (
    state.stage?.party?.lineUp?.seats.some(
      (seat) => seat.mic?.kind === "phone" && seat.mic.phoneId === phoneId,
    ) ?? false
  );
}

const hundredths = (ms: number) => Math.round(ms * 100) / 100;

export function PhoneMicCard({
  store,
  myPhoneId,
  mic,
}: {
  store: LiveStore;
  myPhoneId: PhoneId;
  mic: PhoneMic;
}) {
  const seated = useLive((state) => isSeatedMic(state, myPhoneId), store);
  const snapshot = useSyncExternalStore(mic.subscribe, mic.getSnapshot);
  // A mic that is on stays shown, so it can still be read.
  if (!seated && snapshot.state === "off") return null;

  const { state, readingsPerSecond, detector } = snapshot;
  return (
    <section
      aria-label={t("phoneMic.seated")}
      className="mx-5 mb-3 flex flex-col gap-2 rounded-card bg-ink p-4 text-white shadow-ledge"
    >
      <p className="text-xl font-bold">
        {state === "on"
          ? t("phoneMic.on")
          : state === "opening"
            ? t("phoneMic.opening")
            : state === "failed"
              ? t("phoneMic.failed")
              : state === "lost"
                ? t("phoneMic.stopped")
                : t("phoneMic.seated")}
      </p>
      {state === "lost" && (
        <>
          <p className="text-sm text-white/80">{t("phoneMic.stoppedBody")}</p>
          <Button
            fill="green"
            onPress={() => {
              mic.singAgain();
            }}
          >
            {t("phoneMic.singAgain")}
          </Button>
        </>
      )}
      {(state === "off" || state === "failed") && (
        <Button
          fill="green"
          onPress={() => {
            mic.turnOn();
          }}
        >
          {state === "failed" ? t("phoneMic.tryAgain") : t("phoneMic.turnOn")}
        </Button>
      )}
      {state === "on" && (
        <p
          aria-label={t("phoneMic.diagnostics")}
          data-testid="phone-mic-diagnostics"
          className="flex flex-wrap gap-x-3 text-sm text-white/80 tabular-nums"
        >
          <span data-readings-per-second={readingsPerSecond}>
            {t("phoneMic.readingsPerSecond", { count: readingsPerSecond })}
          </span>
          <span>
            {detector
              ? t("phoneMic.detectorCost", {
                  p50: hundredths(detector.p50Ms),
                  p95: hundredths(detector.p95Ms),
                })
              : t("phoneMic.detectorMeasuring")}
          </span>
        </p>
      )}
    </section>
  );
}
