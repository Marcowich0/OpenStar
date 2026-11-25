import { useState, type SyntheticEvent } from "react";

import type { LiveStore } from "./liveStore";
import { liveStore, useLiveState } from "./useLive";

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
      <p data-testid="live-connection">WebSocket: {live.connection}</p>
      <p data-testid="placeholder">{live.stage?.placeholder ?? ""}</p>
      <form onSubmit={submit}>
        <input
          aria-label="Placeholder"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
        <button type="submit" disabled={live.connection !== "open"}>
          Share
        </button>
      </form>
      {live.lastRejection && (
        <p data-testid="rejection">{live.lastRejection.code}</p>
      )}
    </section>
  );
}
