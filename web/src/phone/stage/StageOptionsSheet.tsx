// The Stage options on a Phone (#271): Options on the Stage tab opens the
// Stage's own list (`OptionsList`, compact) as a full-height sheet, with the
// same groups, folds, defaults and Resets. A change applies at once: only
// the changed fields go over the WebSocket as this Phone
// (`setStageOptions`), so the Stage toasts who changed what ("Sam changed
// Effects"), another device's change to other options is kept, and every
// browser refetches the options on the change notice. A refused change says
// so and shows the kept options again. No Admin PIN. Its OpenStar volume row
// is the same value as the Stage tab's Volume control (`useOpenStarVolume`).

import { useCallback, useState } from "react";

import type { ClientMessage } from "../../generated/ClientMessage";
import { t } from "../../i18n/t";
import type { LiveStore } from "../../live/liveStore";
import { useOpenStarVolume } from "../../live/useOpenStarVolume";
import { OptionsList } from "../../stageOptions/OptionsList";
import {
  useStageOptions,
  type SaveStageOptions,
} from "../../stageOptions/useStageOptions";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";
import { request } from "../joinRequests";

let nextNonce = 1;

/**
 * Sends `message`, then a ping. The server answers a connection's messages
 * in order, so a refusal before the pong is `message`'s ("refused"), and the
 * pong alone means it was done. "unanswered": not sent, or the socket closed
 * first.
 */
function sendAnswered(
  store: LiveStore,
  message: ClientMessage,
): Promise<"done" | "refused" | "unanswered"> {
  if (!store.send(message)) return Promise.resolve("unanswered");
  const nonce = nextNonce++;
  return request(
    store,
    { type: "ping", nonce },
    (state) => (state.lastPong === nonce ? "done" : undefined),
    () => "refused",
    "unanswered",
  );
}

/** Options, under Check A/V sync, and its sheet. */
export function StageOptionsButton({ store }: { store: LiveStore }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        fill="white"
        className="w-full"
        onPress={() => {
          setOpen(true);
        }}
      >
        {t("stageTab.options")}
      </Button>
      <Sheet
        label={t("stageTab.options")}
        isOpen={open}
        onOpenChange={setOpen}
        fullScreen
      >
        <StageOptionsBody
          store={store}
          onBack={() => {
            setOpen(false);
          }}
        />
      </Sheet>
    </>
  );
}

function StageOptionsBody({
  store,
  onBack,
}: {
  store: LiveStore;
  onBack: () => void;
}) {
  // The server answers with a change notice, not the options: what is kept
  // comes with the refetch it starts.
  const save: SaveStageOptions = useCallback(
    async (options, change) => {
      const answer = await sendAnswered(store, {
        type: "setStageOptions",
        options: change,
      });
      if (answer !== "done") throw new Error(`not saved: ${answer}`);
      return options;
    },
    [store],
  );
  const { options, saveFailed, change } = useStageOptions(save);
  const openStarVolume = useOpenStarVolume(store);
  return (
    <div className="flex flex-col gap-5" data-testid="phone-stage-options">
      {/* Full height, so nothing outside it to tap, and a Phone has no Esc. */}
      <button
        type="button"
        onClick={onBack}
        className="inline-flex min-h-12 cursor-pointer items-center gap-1.5 self-start rounded-full bg-surface pr-5 pl-3 text-lg font-semibold shadow-ledge-sm outline-none focus-visible:outline-6 focus-visible:outline-yellow"
      >
        <Icon name="chevron" className="size-5 rotate-180" />
        {t("stageTab.optionsBack")}
      </button>
      <h2 className="text-3xl font-bold">{t("stageTab.options")}</h2>
      <p className="text-lg text-ink-2">{t("options.hint")}</p>
      {saveFailed && (
        <p role="alert" className="text-lg font-semibold text-warn-fg">
          {t("options.saveFailed")}
        </p>
      )}
      <OptionsList
        options={options}
        onChange={change}
        openStarVolume={openStarVolume}
        compact
      />
    </div>
  );
}
