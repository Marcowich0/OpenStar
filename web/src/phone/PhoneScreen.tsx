import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { browserStorage } from "../live/browserLive";
import type { LiveState } from "../live/liveState";
import type { LiveStore } from "../live/liveStore";
import { phoneId, type PhoneStorage } from "../live/phoneId";
import { liveStore, useLive } from "../live/useLive";
import { CalibratingTakeover } from "./calibrating/CalibratingTakeover";
import { isCalibrating } from "./calibrating/calibrating";
import { FavouriteTaken } from "./FavouriteTaken";
import { JoinFlow } from "./JoinFlow";
import { JoinForm } from "./JoinForm";
import type { MemberLook } from "./memberLook";
import type { MeActions } from "./people/MeSheet";
import { editMember } from "./people/memberRequests";
import { phoneMicFor } from "./mic/browserPhoneMic";
import type { PhoneMic } from "./mic/phoneMic";
import { AvSyncPage } from "./onStage/AvSyncCard";
import { phoneMember, phonePage, startedAvSync } from "./phonePage";
import { Remote } from "./Remote";
import type { RequestId } from "../generated/RequestId";
import { takeoverShows } from "./takeover/micTakeover";
import { MicTakeover } from "./takeover/MicTakeover";
import { useMicTakeover } from "./takeover/useMicTakeover";
/** The server answered that this Phone is in no Party: it has to join. */
const selectOutside = (state: LiveState) =>
  state.connection === "open" && state.phone?.memberId === null;

/** `/`: the Phone screens. `?join=<code>` comes from the Stage's QR code. */
export function PhoneScreen() {
  const { join } = useSearch({ from: "/" });
  const navigate = useNavigate();
  // Once in the Party the QR link's code has done its job: a reload after
  // a new Party must not check the old one.
  const dropJoinCode = useCallback(() => {
    void navigate({ to: "/", search: {}, replace: true });
  }, [navigate]);
  return (
    <PhonePageView
      joinCode={join}
      {...(join !== undefined ? { onInParty: dropJoinCode } : {})}
    />
  );
}

export interface PhonePageViewProps {
  /** The Join code from the QR link, if the Phone came through it. */
  joinCode: string | undefined;
  store?: LiveStore;
  storage?: PhoneStorage;
  /** The join form's picture source (tests pass a fixed one). */
  random?: () => number;
  /** This Phone's mic (tests pass a fake); the browser's by default. */
  mic?: PhoneMic;
  /** Runs once this Phone is in the Party (the QR link's code is dropped). */
  onInParty?: () => void;
}

/** The Phone page: one of its states, picked from the store by `phonePage`. */
export function PhonePageView({
  joinCode,
  store = liveStore(),
  storage = browserStorage(),
  random,
  mic: givenMic,
  onInParty,
}: PhonePageViewProps) {
  const myPhoneId = phoneId(storage);
  // The Request whose After the Song screen was closed with Done.
  const [doneWith, setDoneWith] = useState<RequestId | null>(null);
  // After Done the Remote opens on its Stage tab, once.
  const [toStageTab, setToStageTab] = useState(false);
  const selectPage = useCallback(
    (state: LiveState) =>
      phonePage(state, {
        calibrating: (s) => isCalibrating(s, myPhoneId),
        avSync: (s) => startedAvSync(s, myPhoneId),
        micTakeover: (s) => takeoverShows(s, myPhoneId, doneWith),
      }),
    [myPhoneId, doneWith],
  );
  const page = useLive(selectPage, store);
  const mic = givenMic ?? phoneMicFor(store, myPhoneId);
  const takeover = useMicTakeover(store, myPhoneId, mic, doneWith);
  if (page === "micTakeover" && toStageTab) setToStageTab(false);
  // "Queue & controls": the Remote on top of the takeover, until "Back to
  // my mic"; it closes with the takeover.
  const [remoteOnTop, setRemoteOnTop] = useState(false);
  if (page !== "micTakeover" && remoteOnTop) setRemoteOnTop(false);
  // The Song's results close the Remote on top: the Player sees their result.
  const afterFor = takeover?.step === "after" ? takeover.requestId : null;
  const [shownAfter, setShownAfter] = useState<RequestId | null>(null);
  if (afterFor !== shownAfter) {
    setShownAfter(afterFor);
    if (afterFor !== null) setRemoteOnTop(false);
  }
  const member = useLive(phoneMember, store);
  const inParty = member !== null;
  useEffect(() => {
    if (inParty) onInParty?.();
  }, [inParty, onInParty]);
  const outside = useLive(selectOutside, store);
  // The favourite-colour notice is for a Phone that joined through the flow
  // here, not one the server found already in the Party.
  const [joinedHere, setJoinedHere] = useState(false);
  if (outside && !joinedHere) setJoinedHere(true);
  const [noticeDone, setNoticeDone] = useState<number | null>(null);
  // A Me sheet action that replaces the Remote for a while.
  const [meScreen, setMeScreen] = useState<
    { kind: "switch" } | { kind: "edit"; look: MemberLook } | null
  >(null);
  if (page === "joinFlow" && meScreen !== null) setMeScreen(null);
  const me: MeActions = {
    phoneId: myPhoneId,
    onSomeoneElse: () => {
      setMeScreen({ kind: "switch" });
    },
    onChangeLook: (look) => {
      setMeScreen({ kind: "edit", look });
    },
  };
  const closeMeScreen = () => {
    setMeScreen(null);
  };

  switch (page) {
    case "joinFlow":
      return (
        <JoinFlow
          linkCode={joinCode}
          store={store}
          storage={storage}
          {...(random ? { random } : {})}
        />
      );
    case "calibrating":
      return (
        <CalibratingTakeover store={store} phoneId={myPhoneId} mic={mic} />
      );
    case "avSync":
      return <AvSyncPage store={store} />;
    case "micTakeover":
      if (takeover && !remoteOnTop)
        return (
          <MicTakeover
            store={store}
            takeover={takeover}
            mic={mic}
            myMemberId={member?.memberId ?? null}
            onOpenRemote={() => {
              setRemoteOnTop(true);
            }}
            onDone={(requestId) => {
              setDoneWith(requestId);
              setToStageTab(true);
            }}
          />
        );
      return (
        <Remote
          store={store}
          phoneId={myPhoneId}
          me={me}
          {...(takeover
            ? {
                backToMic: {
                  colour: takeover.colour,
                  onBack: () => {
                    setRemoteOnTop(false);
                  },
                },
              }
            : {})}
        />
      );
    case "remote":
      if (meScreen?.kind === "switch")
        return (
          <JoinFlow
            linkCode={undefined}
            store={store}
            storage={storage}
            switching={{ onBack: closeMeScreen, onDone: closeMeScreen }}
            {...(random ? { random } : {})}
          />
        );
      if (meScreen?.kind === "edit" && member)
        return (
          <JoinForm
            kind="edit"
            store={store}
            member={member}
            look={meScreen.look}
            onBack={closeMeScreen}
            onSave={async (edit) => {
              const refusal = await editMember(store, member.memberId, edit);
              if (refusal === null) closeMeScreen();
              return refusal;
            }}
          />
        );
      if (
        joinedHere &&
        member?.identity.kind === "profile" &&
        member.favouriteTaken &&
        noticeDone !== member.memberId
      )
        return (
          <FavouriteTaken
            member={member}
            store={store}
            onDone={() => {
              setNoticeDone(member.memberId);
            }}
          />
        );
      return (
        <Remote
          store={store}
          phoneId={myPhoneId}
          me={me}
          {...(toStageTab ? { initialTab: "stage" as const } : {})}
        />
      );
  }
}
