import { userMessageText } from "../i18n/serverText";
import { t, type MessageKey } from "../i18n/t";
import type { LiveConnection, LiveState } from "./liveState";
import type { LiveStore } from "./liveStore";
import { liveStore, useLive } from "./useLive";

const selectConnection = (live: LiveState) => live.connection;
const selectStage = (live: LiveState) => live.stage;
const selectRejection = (live: LiveState) => live.lastRejection;

const CONNECTION_TEXT = {
  connecting: "live.connecting",
  open: "live.open",
  reconnecting: "live.reconnecting",
} as const satisfies Record<LiveConnection, MessageKey>;

/**
 * The walking skeleton's view of the Party every connected browser shares:
 * the connection, the Join code and, on the Stage, New party. The Stage and
 * Phone screens replace it.
 */
export function PartyPanel({ store = liveStore() }: { store?: LiveStore }) {
  const connection = useLive(selectConnection, store);
  const stage = useLive(selectStage, store);
  const lastRejection = useLive(selectRejection, store);

  return (
    <section>
      <p data-testid="live-connection">{t(CONNECTION_TEXT[connection])}</p>
      <p data-testid="party-join-code">{stage?.party?.joinCode ?? ""}</p>
      {stage?.stageMoved && (
        <p data-testid="stage-moved">{t("live.stageMoved")}</p>
      )}
      {stage?.isStage && (
        <button
          type="button"
          disabled={connection !== "open"}
          onClick={() => {
            store.send({ type: "newParty" });
          }}
        >
          {t("live.newParty")}
        </button>
      )}
      {lastRejection && (
        <p data-testid="rejection">{userMessageText(lastRejection)}</p>
      )}
    </section>
  );
}
