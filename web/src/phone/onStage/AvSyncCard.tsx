// Check A/V sync on a Remote's Stage tab (v1 spec #53, ticket #163). The
// button starts it on the Stage (waiting Line-up and empty Queue only; the
// server refuses it while a Song plays). While it runs, whoever started it,
// the card shows big −/+, Reset to 0 and Done: each is a request the server
// passes to the Stage, which saves the value under its own browser id. No
// Admin PIN.

import type { AvSyncStep } from "../../generated/AvSyncStep";
import { t } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { useLive } from "../../live/useLive";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";

const selectAvSync = (state: LiveState) => state.avSync;

/** Whether Check A/V sync runs on the Stage. */
export function useAvSyncRunning(store: LiveStore): boolean {
  return useLive(selectAvSync, store);
}

export function AvSyncStartButton({ store }: { store: LiveStore }) {
  return (
    <Button
      fill="white"
      className="w-full"
      onPress={() => {
        store.send({ type: "startAvSync" });
      }}
    >
      {t("avSync.start")}
    </Button>
  );
}

const STEP_BUTTON =
  "flex size-24 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white text-ink shadow-ledge-sm outline-none focus-visible:outline-4 focus-visible:outline-yellow";

export function AvSyncCard({ store }: { store: LiveStore }) {
  const step = (press: AvSyncStep) => () => {
    store.send({ type: "stepAvSync", step: press });
  };
  return (
    <section
      data-testid="av-sync-card"
      className="flex flex-col gap-4 rounded-card bg-ink p-4.5 text-white shadow-ledge"
    >
      <h2 className="text-2xl font-bold">{t("avSync.start")}</h2>
      <p className="text-white/70">{t("avSync.remoteHint")}</p>
      <div className="flex items-center justify-center gap-8">
        <button
          type="button"
          aria-label={t("avSync.down")}
          onClick={step("down")}
          className={STEP_BUTTON}
        >
          <Icon name="minus" className="size-12" />
        </button>
        <button
          type="button"
          aria-label={t("avSync.up")}
          onClick={step("up")}
          className={STEP_BUTTON}
        >
          <Icon name="plus" className="size-12" />
        </button>
      </div>
      <div className="flex gap-3">
        <Button fill="white" className="grow" onPress={step("reset")}>
          {t("avSync.reset")}
        </Button>
        <Button
          fill="green"
          className="grow"
          onPress={() => {
            store.send({ type: "endAvSync" });
          }}
        >
          {t("avSync.done")}
        </Button>
      </div>
    </section>
  );
}
