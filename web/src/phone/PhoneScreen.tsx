import { useSearch } from "@tanstack/react-router";

import { browserStorage } from "../live/browserLive";
import type { LiveState } from "../live/liveState";
import type { LiveStore } from "../live/liveStore";
import type { PhoneStorage } from "../live/phoneId";
import { liveStore, useLive } from "../live/useLive";
import { JoinFlow } from "./JoinFlow";
import { phonePage } from "./phonePage";
import { Remote } from "./Remote";

const selectPage = (state: LiveState) => phonePage(state);

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
}

/** The Phone page: one of its states, picked from the store by `phonePage`. */
export function PhonePageView({
  joinCode,
  store = liveStore(),
  storage = browserStorage(),
}: PhonePageViewProps) {
  const page = useLive(selectPage, store);
  switch (page) {
    case "joinFlow":
      return <JoinFlow linkCode={joinCode} store={store} storage={storage} />;
    // Calibrating and the mic takeover come with their tickets; until then
    // the Remote shows.
    case "calibrating":
      return <Remote store={store} />;
    case "micTakeover":
      return <Remote store={store} />;
    case "remote":
      return <Remote store={store} />;
  }
}
