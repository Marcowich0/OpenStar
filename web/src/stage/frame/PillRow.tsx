// The small pill row in the top right: Songs · Queue 4 · People 6 (live
// counts) and, on the song browser and the Line-up, Setup with its menu.

import { useState } from "react";

import { t } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import { useLive } from "../../live/useLive";
import type { OverlayId } from "./overlayIds";
import { StagePickList, StagePickListEntry } from "./StagePickList";
import { useStageFrame } from "./stageFrameContext";

const selectParty = (live: LiveState) => live.stage?.party ?? null;

const PILL =
  "inline-flex min-h-14 cursor-pointer items-center rounded-full bg-white px-7 text-2xl font-semibold text-ink shadow-ledge-sm";

const SETUP_ENTRIES = [
  ["mics", "stage.overlay.mics"],
  ["calibrateMics", "stage.overlay.calibrateMics"],
  ["avSync", "stage.overlay.avSync"],
  // Marc asked for Downloads on the Stage (2026-11-27): an overlay, so the
  // Stage never navigates to the Admin area (`noStageEntry.test.ts`).
  ["downloads", "stage.overlay.downloads"],
  ["options", "stage.overlay.options"],
] as const satisfies readonly (readonly [OverlayId, string])[];

export function PillRow({ setup }: { setup: boolean }) {
  const { store, openOverlay } = useStageFrame();
  const party = useLive(selectParty, store);
  const [setupOpen, setSetupOpen] = useState(false);
  return (
    <nav
      aria-label={t("stage.pills")}
      className="pointer-events-auto absolute top-12 right-12 flex items-center gap-4"
      data-testid="pill-row"
    >
      <button
        type="button"
        className={PILL}
        onClick={() => {
          openOverlay("songs");
        }}
      >
        {t("stage.pill.songs")}
      </button>
      <button
        type="button"
        className={PILL}
        onClick={() => {
          openOverlay("queue");
        }}
      >
        {t("stage.pill.queue", { count: party?.queue.length ?? 0 })}
      </button>
      <button
        type="button"
        className={PILL}
        onClick={() => {
          openOverlay("people");
        }}
      >
        {t("stage.pill.people", { count: party?.members.length ?? 0 })}
      </button>
      {setup && (
        <span className="relative">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={setupOpen}
            className={PILL}
            onClick={() => {
              setSetupOpen(true);
            }}
          >
            {t("stage.pill.setup")}
          </button>
          {setupOpen && (
            <StagePickList
              aria-label={t("stage.setup.menu")}
              onClose={() => {
                setSetupOpen(false);
              }}
              className="top-full right-0 mt-4"
            >
              {SETUP_ENTRIES.map(([id, label]) => (
                <StagePickListEntry
                  key={id}
                  onPick={() => {
                    setSetupOpen(false);
                    openOverlay(id);
                  }}
                >
                  {t(label)}
                </StagePickListEntry>
              ))}
            </StagePickList>
          )}
        </span>
      )}
    </nav>
  );
}
