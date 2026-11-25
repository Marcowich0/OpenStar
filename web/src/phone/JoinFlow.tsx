import { useEffect, useRef, useState } from "react";

import { t } from "../i18n/t";
import type { LiveState } from "../live/liveState";
import type { LiveStore } from "../live/liveStore";
import type { PhoneStorage } from "../live/phoneId";
import { useLive } from "../live/useLive";
import { NumberPad } from "../ui/NumberPad";
import { checkJoinCode } from "./joinRequests";
import { TopBar } from "./Logo";
import { WhosSinging } from "./WhosSinging";

/** Where the join flow stands. `null`: the QR link's code is being checked. */
type Step =
  { kind: "code"; refused: boolean } | { kind: "who"; joinCode: string } | null;

/** The server has said whether this Phone is in the Party. */
const selectAnswered = (state: LiveState) =>
  state.connection === "open" && state.phone !== null;

export interface JoinFlowProps {
  /** The Join code from the QR link: the pad is skipped when it is right. */
  linkCode: string | undefined;
  store: LiveStore;
  storage: PhoneStorage;
}

/**
 * The join flow (v1 spec #49, "Join flow"): the Join code on the number pad,
 * or from the QR link, then "Who's singing?". It waits for the server's
 * answer to the Phone id first, so a Phone already in the Party goes to the
 * Remote without ever showing the pad.
 */
export function JoinFlow({ linkCode, store, storage }: JoinFlowProps) {
  const answered = useLive(selectAnswered, store);
  const [step, setStep] = useState<Step>(
    linkCode === undefined ? { kind: "code", refused: false } : null,
  );
  const linkChecked = useRef(false);

  useEffect(() => {
    if (!answered || linkCode === undefined || linkChecked.current) return;
    linkChecked.current = true;
    void checkJoinCode(store, linkCode).then((answer) => {
      setStep(
        answer === "accepted"
          ? { kind: "who", joinCode: linkCode }
          : { kind: "code", refused: answer === "refused" },
      );
    });
  }, [answered, linkCode, store]);

  if (!answered || step === null)
    return (
      <main className="flex min-h-dvh flex-col">
        <TopBar />
        <p role="status" className="px-5 pt-10 text-center text-xl text-ink-2">
          {t("join.connecting")}
        </p>
      </main>
    );

  if (step.kind === "who")
    return (
      <WhosSinging
        joinCode={step.joinCode}
        store={store}
        storage={storage}
        onCodeRefused={() => {
          setStep({ kind: "code", refused: true });
        }}
      />
    );

  return (
    <main className="flex min-h-dvh flex-col">
      <TopBar />
      <div className="flex flex-col items-center gap-2 px-5 pb-6">
        <h1 className="mt-2 self-start text-4xl leading-tight font-bold">
          {t("join.title")}
        </h1>
        <p className="self-start text-lg text-ink-2">{t("join.typeCode")}</p>
        <NumberPad
          form="joinCode"
          className="mt-6"
          {...(step.refused ? { message: t("numberPad.codeRefused") } : {})}
          onSubmit={async (entry) => {
            setStep({ kind: "code", refused: false });
            const answer = await checkJoinCode(store, entry);
            if (answer === "accepted")
              setStep({ kind: "who", joinCode: entry });
            return answer === "refused" ? "refused" : undefined;
          }}
        />
      </div>
    </main>
  );
}
