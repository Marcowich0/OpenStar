import { useEffect, useRef, useState } from "react";

import type { JoinAs } from "../generated/JoinAs";
import type { UserMessage } from "../generated/UserMessage";
import { t } from "../i18n/t";
import type { LiveState } from "../live/liveState";
import type { LiveStore } from "../live/liveStore";
import { phoneId, rememberProfile, type PhoneStorage } from "../live/phoneId";
import { useLive } from "../live/useLive";
import { NumberPad } from "../ui/NumberPad";
import { JoinForm, type JoinFormKind } from "./JoinForm";
import { checkJoinCode, joinParty, type JoinResult } from "./joinRequests";
import { TopBar } from "./Logo";
import { PartyFull } from "./PartyFull";
import { LeftParty } from "./people/LeftParty";
import { switchIdentity } from "./people/memberRequests";
import { isJoinCode } from "./phoneSearch";
import { WhosSinging } from "./WhosSinging";

/** Where the join flow stands. `null`: the QR link's code is being checked. */
type Step =
  | { kind: "left" }
  | { kind: "code"; refused: boolean }
  | { kind: "who"; joinCode: string }
  | { kind: "form"; joinCode: string; form: JoinFormKind }
  | { kind: "full"; joinCode: string; joinAs: JoinAs; back: Step }
  | null;

/** The server has said whether this Phone is in the Party. */
const selectAnswered = (state: LiveState) =>
  state.connection === "open" && state.phone !== null;

export interface JoinFlowProps {
  /** The text after `?join=` from the QR link: the pad is skipped when it is right. */
  linkCode: string | undefined;
  store: LiveStore;
  storage: PhoneStorage;
  /** The form's picture source (tests pass a fixed one). */
  random?: () => number;
  /**
   * The Me sheet's "Someone else is using this phone": this joined Phone
   * picks another identity, with no Join code, starting at the full
   * "Who's singing?" grid. `onDone` runs once it has switched.
   */
  switching?: { onBack: () => void; onDone: () => void };
}

/**
 * The first step: "You left the Party" for a Phone that was just in it,
 * otherwise the QR link's code is checked, unless it is no Join code.
 */
function firstStep(linkCode: string | undefined, left: boolean): Step {
  if (left) return { kind: "left" };
  if (linkCode === undefined) return { kind: "code", refused: false };
  return isJoinCode(linkCode) ? null : { kind: "code", refused: true };
}

/**
 * The join flow (v1 spec #49, "Join flow"): the Join code on the number pad,
 * or from the QR link, then "Who's singing?" and the New Profile / Guest
 * form. It waits for the server's answer to the Phone id first, so a Phone
 * already in the Party goes to the Remote without ever showing the pad.
 */
export function JoinFlow({
  linkCode,
  store,
  storage,
  random,
  switching,
}: JoinFlowProps) {
  const answered = useLive(selectAnswered, store);
  const [step, setStep] = useState<Step>(() =>
    switching
      ? { kind: "who", joinCode: "" }
      : firstStep(linkCode, store.getSnapshot().phone?.leftParty ?? false),
  );
  const [retrying, setRetrying] = useState(false);
  const linkChecked = useRef(false);

  useEffect(() => {
    if (!answered || step !== null || linkCode === undefined) return;
    if (linkChecked.current) return;
    linkChecked.current = true;
    void checkJoinCode(store, linkCode).then((answer) => {
      setStep(
        answer === "accepted"
          ? { kind: "who", joinCode: linkCode }
          : { kind: "code", refused: answer === "refused" },
      );
    });
  }, [answered, linkCode, step, store]);

  /**
   * Joins as `joinAs`. A wrong code goes back to the pad and a full Party
   * shows its screen; any other refusal is returned for the screen to show.
   * Once joined, a Profile is remembered on the Phone.
   */
  async function join(
    joinCode: string,
    joinAs: JoinAs,
    back: Step,
  ): Promise<UserMessage | null> {
    const result: JoinResult = switching
      ? await switchIdentity(store, joinAs)
      : await joinParty(store, {
          phoneId: phoneId(storage),
          joinCode,
          joinAs,
        });
    if (result.ok) {
      const { identity } = result.member;
      if (identity.kind === "profile")
        rememberProfile(storage, identity.profileId);
      switching?.onDone();
      return null;
    }
    const reason = result.reason ?? { code: "serverError" };
    if (reason.code === "joinCodeWrong") {
      setStep({ kind: "code", refused: true });
      return null;
    }
    if (reason.code === "partyFull") {
      setStep({ kind: "full", joinCode, joinAs, back });
      return null;
    }
    return reason;
  }

  if (!answered || step === null)
    return (
      <main className="flex min-h-dvh flex-col">
        <TopBar />
        <p role="status" className="px-5 pt-10 text-center text-xl text-ink-2">
          {t("join.connecting")}
        </p>
      </main>
    );

  switch (step.kind) {
    case "left":
      return (
        <LeftParty
          onJoinAgain={() => {
            setStep({ kind: "code", refused: false });
          }}
        />
      );
    case "who":
      return (
        <WhosSinging
          store={store}
          storage={storage}
          onJoin={(joinAs) => join(step.joinCode, joinAs, step)}
          onNewProfile={() => {
            setStep({
              kind: "form",
              joinCode: step.joinCode,
              form: "newProfile",
            });
          }}
          onGuest={() => {
            setStep({ kind: "form", joinCode: step.joinCode, form: "guest" });
          }}
          {...(switching ? { onBack: switching.onBack } : {})}
        />
      );
    case "form":
      return (
        <JoinForm
          kind={step.form}
          store={store}
          {...(random ? { random } : {})}
          onJoin={(joinAs) => join(step.joinCode, joinAs, step)}
          onBack={() => {
            setStep({ kind: "who", joinCode: step.joinCode });
          }}
        />
      );
    case "full":
      return (
        <PartyFull
          pending={retrying}
          onTryAgain={() => {
            setRetrying(true);
            void join(step.joinCode, step.joinAs, step.back).then((problem) => {
              setRetrying(false);
              // Any other refusal: back to the screen it was sent from.
              if (problem !== null) setStep(step.back);
            });
          }}
        />
      );
    case "code":
      return (
        <main className="flex min-h-dvh flex-col">
          <TopBar />
          <div className="flex flex-col items-center gap-2 px-5 pb-6">
            <h1 className="mt-2 self-start text-4xl leading-tight font-bold">
              {t("join.title")}
            </h1>
            <p className="self-start text-lg text-ink-2">
              {t("join.typeCode")}
            </p>
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
}
