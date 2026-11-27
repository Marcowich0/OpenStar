// Muting the carousel preview (#162): a toggle in the song browser's header,
// beside the Search button, and the `M` key. Muted, the carousel plays no
// preview (as while Check A/V sync runs); unmuted, the selected Song plays
// again. It touches only the preview: the sung Song, Check A/V sync's clicks
// and the OpenStar volume are not its business. The choice lives in this
// browser's own storage, not in Party state, so each Stage browser keeps its
// own.

import { useState } from "react";

import { t } from "../../../i18n/t";
import { Icon } from "../../../ui/Icon";
import { isTextField } from "../../frame/focusables";
import { useStageKeys } from "../../frame/stageFrameContext";
import { KeyHint } from "../../input/KeyHint";
import { SEARCH_ROW_CONTROL } from "../../search/StageSongSearch";

/** The `localStorage` key of the song browser's Mute choice. */
export const PREVIEW_MUTED_KEY = "openstar.previewMuted";

type MuteStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): MuteStorage {
  return window.localStorage;
}

function readMuted(storage: () => MuteStorage): boolean {
  try {
    return storage().getItem(PREVIEW_MUTED_KEY) === "true";
  } catch {
    return false;
  }
}

function writeMuted(storage: () => MuteStorage, muted: boolean) {
  try {
    storage().setItem(PREVIEW_MUTED_KEY, String(muted));
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
}

/**
 * The stored Mute choice and its toggle, which `M` also works while the
 * song browser is the top layer (typed into the search box, `m` is text).
 */
export function usePreviewMute(
  storage: () => MuteStorage = browserStorage,
): [muted: boolean, toggle: () => void] {
  const [muted, setMuted] = useState(() => readMuted(storage));
  const toggle = () => {
    const next = !muted;
    setMuted(next);
    writeMuted(storage, next);
  };
  useStageKeys({
    m: (event) => {
      if (isTextField(document.activeElement)) return false;
      if (!event.repeat) toggle();
      return true;
    },
  });
  return [muted, toggle];
}

/** The toggle: pressed while the preview is muted. */
export function PreviewMuteButton({
  muted,
  onToggle,
}: {
  muted: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={t("stage.browser.mutePreview")}
      aria-pressed={muted}
      aria-keyshortcuts="M"
      title={t(
        muted ? "stage.browser.previewMuted" : "stage.browser.previewOn",
      )}
      onClick={onToggle}
      className={`${SEARCH_ROW_CONTROL} ${muted ? "bg-ink text-white" : "bg-white text-ink"}`}
    >
      <Icon name={muted ? "volume-off" : "volume"} className="size-9" />
      <KeyHint keyName="M" />
    </button>
  );
}
