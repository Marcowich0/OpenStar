// Check A/V sync on a Remote (v1 spec #53, tickets #163 and #168). The
// button on the Stage tab starts it on the Stage (waiting Line-up and empty
// Queue only; the server refuses it while a Song plays). While it runs, the
// Stage's current value shows large, as the Stage reports it, with big −/+,
// Reset to 0 and Done: each is a request the server passes to the Stage,
// which saves the value under its own browser id at once. The Phone that
// started it shows them as its page (`AvSyncPage`, picked by `phonePage`);
// every other Remote as a card on its Stage tab. No Admin PIN.

import type { AvSyncStep } from "../../generated/AvSyncStep";
import { avOffsetText } from "../../avSync/avSyncStep";
import { t } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { useLive } from "../../live/useLive";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";

const selectAvSync = (state: LiveState) => state.avSync;
const selectValue = (state: LiveState) => state.avSyncCheck.avOffsetMs;

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
  "flex size-24 shrink-0 cursor-pointer items-center justify-center rounded-full bg-surface text-ink shadow-ledge-sm outline-none focus-visible:outline-4 focus-visible:outline-yellow";

/** The value large, −/+, Reset to 0 and Done. */
function AvSyncControls({ store }: { store: LiveStore }) {
  const ms = useLive(selectValue, store);
  const step = (press: AvSyncStep) => () => {
    store.send({ type: "stepAvSync", step: press });
  };
  return (
    <>
      <p className="text-white/70">{t("avSync.remoteHint")}</p>
      <p
        data-testid="av-sync-value"
        aria-label={t("avSync.value")}
        aria-live="polite"
        className="text-center text-6xl font-bold tabular-nums"
      >
        {ms === null ? t("avSync.valueUnknown") : avOffsetText(ms)}
      </p>
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
    </>
  );
}

/** On the Stage tab of every Remote but the one that started it. */
export function AvSyncCard({ store }: { store: LiveStore }) {
  return (
    <section
      data-testid="av-sync-card"
      className="flex flex-col gap-4 rounded-card bg-ink-fill p-4.5 text-white shadow-ledge"
    >
      <h2 className="text-2xl font-bold">{t("avSync.start")}</h2>
      <AvSyncControls store={store} />
    </section>
  );
}

/** The page of the Phone that started it, until Done. */
export function AvSyncPage({ store }: { store: LiveStore }) {
  return (
    <main
      aria-label={t("avSync.start")}
      className="flex min-h-dvh flex-col justify-center gap-6 bg-ink-fill px-4 py-8 text-white"
    >
      <h1 className="text-4xl font-bold">{t("avSync.start")}</h1>
      <AvSyncControls store={store} />
    </main>
  );
}
