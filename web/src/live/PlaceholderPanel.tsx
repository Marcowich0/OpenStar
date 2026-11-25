import { useState, type SyntheticEvent } from "react";

import { userMessageText } from "../i18n/serverText";
import { t, type MessageKey } from "../i18n/t";
import type { LiveConnection } from "./liveState";
import type { LiveStore } from "./liveStore";
import { liveStore, useLiveState } from "./useLive";

const CONNECTION_TEXT = {
  connecting: "live.connecting",
  open: "live.open",
  reconnecting: "live.reconnecting",
} as const satisfies Record<LiveConnection, MessageKey>;

/**
 * Shows and changes the placeholder live state that every connected browser
 * shares, until #48 replaces it with the Party.
 */
export function PlaceholderPanel({
  store = liveStore(),
}: {
  store?: LiveStore;
}) {
  const live = useLiveState(store);
  const [draft, setDraft] = useState("");

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    store.send({ type: "setPlaceholder", text: draft });
  };

  return (
    <section>
      <p data-testid="live-connection">{t(CONNECTION_TEXT[live.connection])}</p>
      <p data-testid="placeholder">{live.stage?.placeholder ?? ""}</p>
      <form onSubmit={submit}>
        <input
          aria-label={t("live.placeholderLabel")}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
        <button type="submit" disabled={live.connection !== "open"}>
          {t("live.share")}
        </button>
      </form>
      {live.lastRejection && (
        <p data-testid="rejection">{userMessageText(live.lastRejection)}</p>
      )}
    </section>
  );
}
