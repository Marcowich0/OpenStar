import { useSearch } from "@tanstack/react-router";
import { useState } from "react";

import { browserStorage } from "../live/browserLive";
import type { LiveState } from "../live/liveState";
import type { LiveStore } from "../live/liveStore";
import { phoneId, type PhoneStorage } from "../live/phoneId";
import { liveStore, useLive } from "../live/useLive";
import { FavouriteTaken } from "./FavouriteTaken";
import { JoinFlow } from "./JoinFlow";
import { phoneMember, phonePage } from "./phonePage";
import { Remote } from "./Remote";

const selectPage = (state: LiveState) => phonePage(state);
/** The server answered that this Phone is in no Party: it has to join. */
const selectOutside = (state: LiveState) =>
  state.connection === "open" && state.phone?.memberId === null;

/** `/`: the Phone screens. `?join=<code>` comes from the Stage's QR code. */
export function PhoneScreen() {
  const { join } = useSearch({ from: "/" });
  return <PhonePageView joinCode={join} />;
}

export interface PhonePageViewProps {
  /** The Join code from the QR link, if the Phone came through it. */
  joinCode: string | undefined;
  store?: LiveStore;
  storage?: PhoneStorage;
  /** The join form's picture source (tests pass a fixed one). */
  random?: () => number;
}

/** The Phone page: one of its states, picked from the store by `phonePage`. */
export function PhonePageView({
  joinCode,
  store = liveStore(),
  storage = browserStorage(),
  random,
}: PhonePageViewProps) {
  const page = useLive(selectPage, store);
  const member = useLive(phoneMember, store);
  const outside = useLive(selectOutside, store);
  // The favourite-colour notice is for a Phone that joined through the flow
  // here, not one the server found already in the Party.
  const [joinedHere, setJoinedHere] = useState(false);
  if (outside && !joinedHere) setJoinedHere(true);
  const [noticeDone, setNoticeDone] = useState<number | null>(null);

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
    // Calibrating and the mic takeover come with their tickets; until then
    // the Remote shows.
    case "calibrating":
      return <Remote store={store} phoneId={phoneId(storage)} />;
    case "micTakeover":
      return <Remote store={store} phoneId={phoneId(storage)} />;
    case "remote":
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
      return <Remote store={store} phoneId={phoneId(storage)} />;
  }
}
