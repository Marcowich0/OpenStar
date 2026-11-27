// Toasts on the Stage (v1 spec #55, "Toasts"): ink pills at the top centre,
// one per Party change the live store keeps (`live/toasts.ts`: only changes
// made from a Remote, at most three, oldest first). Each drops in, stays
// about 4 s, fades up and is then dropped from the store. They sit above
// every scene and overlay, and during a Song higher up, in the clear video
// above the lanes.

import { useQuery } from "@tanstack/react-query";

import { profilesQuery } from "../../api/queries";
import { t } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import type { Toast } from "../../live/toasts";
import { useLive } from "../../live/useLive";
import { Avatar } from "../../ui/Avatar";
import { ReferenceBox } from "../frame/ReferenceBox";
import { toastContent, type ToastContent } from "../../toasts/toastContent";
import { ToastText } from "../../toasts/ToastText";
import { useToastPhase } from "../../toasts/useToastPhase";

/** Where the stack starts, in reference px from the top. */
const TOP = 150;
/** During a Song: above the lanes and lyrics. */
const TOP_DURING_SONG = 90;
/** The avatar's diameter in reference px. */
const AVATAR_SIZE = 46;

const selectToasts = (live: LiveState) => live.toasts;
const selectParty = (live: LiveState) => live.stage?.party ?? null;

export interface StageToastsProps {
  store: LiveStore;
  duringSong: boolean;
}

export function StageToasts({ store, duringSong }: StageToastsProps) {
  const toasts = useLive(selectToasts, store);
  return (
    <ReferenceBox passThrough layer="toast">
      <div
        role="status"
        aria-label={t("toast.list")}
        className="absolute inset-x-0 top-0"
        style={{ paddingTop: duringSong ? TOP_DURING_SONG : TOP }}
      >
        {toasts.length > 0 && <ToastStack store={store} toasts={toasts} />}
      </div>
    </ReferenceBox>
  );
}

/** Mounted only while there are toasts, so it reads the Profiles only then. */
function ToastStack({
  store,
  toasts,
}: {
  store: LiveStore;
  toasts: readonly Toast[];
}) {
  const party = useLive(selectParty, store);
  const profiles = useQuery(profilesQuery).data ?? [];
  return (
    <ul className="flex flex-col items-center gap-2.5">
      {toasts.map((toast) => (
        <ToastPill
          key={toast.id}
          id={toast.id}
          store={store}
          content={toastContent(toast, party, profiles)}
        />
      ))}
    </ul>
  );
}

function ToastPill({
  id,
  store,
  content,
}: {
  id: number;
  store: LiveStore;
  content: ToastContent;
}) {
  const phase = useToastPhase(id, store);

  const { actor, parts } = content;
  return (
    <li
      data-leaving={phase === "showing" ? undefined : ""}
      className={`flex items-center gap-3.5 rounded-full bg-ink py-2.5 pr-7.5 text-[28px] font-medium whitespace-nowrap text-white shadow-ledge-ink ${
        phase === "showing" ? "animate-toast-in" : "animate-toast-out"
      } ${actor ? "pl-3" : "pl-7.5"}`}
    >
      {actor && (
        // The name is in the text already; the avatar is not read twice.
        <span aria-hidden="true" className="flex">
          <Avatar
            name={actor.name}
            avatar={actor.avatar}
            colour={actor.colour}
            size={AVATAR_SIZE}
          />
        </span>
      )}
      <ToastText parts={parts} />
    </li>
  );
}
