// The Calibrating takeover (v1 spec #52; ticket #173): the whole screen in
// this Phone's Party colour while it takes part in a Calibration run, above
// the Remote and the mic takeover. One big "I'm listening" tap opens the mic
// as for singing and tells the server the Mic is ready; during the tones a
// bar shows the run's progress and asks the Player to stay quiet. The step
// comes from `calibrating`.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { profilesQuery } from "../../api/queries";
import type { PhoneId } from "../../generated/PhoneId";
import { t, type MessageKey } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { useLive, useLiveState } from "../../live/useLive";
import { tokenVar } from "../../theme/tokens";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { memberLook } from "../memberLook";
import type { MicBlockedReason, PhoneMic } from "../mic/phoneMic";
import { phoneMember } from "../phonePage";
import { PhoneToasts } from "../PhoneToasts";
import { calibrating, imListening, tonesProgress } from "./calibrating";

const BLOCKED_TEXT = {
  permissionRefused: "phoneMic.blocked.permissionRefused",
  noHttps: "phoneMic.blocked.noHttps",
  notOpened: "phoneMic.blocked.notOpened",
} as const satisfies Record<MicBlockedReason, MessageKey>;

const selectMember = (state: LiveState) => phoneMember(state);

export function CalibratingTakeover({
  store,
  phoneId,
  mic,
}: {
  store: LiveStore;
  phoneId: PhoneId;
  mic: PhoneMic;
}) {
  const state = useLiveState(store);
  const snapshot = useSyncExternalStore(mic.subscribe, mic.getSnapshot);
  const member = useLive(selectMember, store);
  const profiles = useQuery(profilesQuery).data;
  const pending = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      pending.current?.();
    },
    [],
  );
  const view = calibrating(state, phoneId, snapshot);
  if (!view) return null;
  const look = member ? memberLook(member, profiles) : null;

  const listen = () => {
    pending.current?.();
    pending.current = imListening(mic, (message) => {
      store.send(message);
    });
  };

  return (
    <main
      aria-label={t("phoneCalibrating.label")}
      data-testid="calibrating-takeover"
      data-step={view.step}
      className="flex min-h-dvh flex-col items-center gap-6 px-5 pt-10 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] text-center text-white"
      style={{ backgroundColor: tokenVar(view.colour) }}
    >
      <PhoneToasts store={store} />
      {look && member && (
        <Avatar
          name={look.name}
          avatar={look.avatar}
          colour={member.colour}
          size={120}
        />
      )}
      <h1 className="text-4xl font-bold">{t("phoneCalibrating.title")}</h1>
      <div className="flex w-full grow flex-col items-center gap-4">
        {view.step === "listen" && (
          <>
            <p className="text-xl">{t("phoneCalibrating.listenHint")}</p>
            <Button
              fill="green"
              size="big"
              breathing
              className="mt-auto min-h-40 w-full px-6! text-3xl"
              onPress={listen}
            >
              {t("phoneCalibrating.listen")}
            </Button>
          </>
        )}
        {view.step === "opening" && (
          <p className="text-xl" role="status">
            {t("phoneMic.opening")}
          </p>
        )}
        {view.step === "ready" && (
          <>
            <p className="text-2xl font-semibold" role="status">
              {t("phoneCalibrating.ready")}
            </p>
            <p className="text-xl">{t("phoneCalibrating.holdStill")}</p>
          </>
        )}
        {view.step === "blocked" && (
          <section
            aria-label={t("phoneMic.failed")}
            className="flex w-full grow flex-col items-center gap-4 rounded-card bg-ink-fill p-5"
          >
            <h2 className="text-3xl font-bold">{t("phoneMic.failed")}</h2>
            {view.blocked && (
              <p className="text-lg text-white/80">
                {t(BLOCKED_TEXT[view.blocked])}
              </p>
            )}
            <Button
              fill="green"
              size="big"
              className="mt-auto w-full px-6!"
              onPress={listen}
            >
              {t("phoneMic.tryAgain")}
            </Button>
          </section>
        )}
        {view.step === "tones" && <Tones />}
      </div>
    </main>
  );
}

/** The run's progress from the moment this Phone saw the tones start. */
function Tones() {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  const progress = tonesProgress(now - startedAt);
  useEffect(() => {
    if (progress >= 1) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 100);
    return () => {
      clearInterval(timer);
    };
  }, [progress]);
  const percent = Math.round(progress * 100);
  return (
    <>
      <p className="text-2xl font-semibold" role="status">
        {t("phoneCalibrating.tones")}
      </p>
      <div
        role="progressbar"
        aria-label={t("phoneCalibrating.label")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-4 w-full overflow-hidden rounded-full bg-white/25"
      >
        <div
          className="h-full rounded-full bg-white transition-[width] duration-100 ease-linear"
          style={{ width: `${String(percent)}%` }}
        />
      </div>
      <p className="mt-auto text-3xl font-bold">
        {t("phoneCalibrating.stayQuiet")}
      </p>
    </>
  );
}
