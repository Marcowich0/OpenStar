// The Phone's toasts (v1 spec #49, "Toasts"): ink pills at the top of the
// screen, each with the actor's avatar, for every change from any Remote or
// the Stage (the live store keeps them, `live/toasts.ts`). This Phone's own
// changes read in the second person. The content and the lifetime are the
// Stage's (`stage/toasts/`); only the size and place differ.

import { useQuery } from "@tanstack/react-query";

import { profilesQuery } from "../api/queries";
import { t } from "../i18n/t";
import type { LiveState } from "../live/liveState";
import type { LiveStore } from "../live/liveStore";
import type { Toast } from "../live/toasts";
import { useLive } from "../live/useLive";
import { toastContent, type ToastContent } from "../toasts/toastContent";
import { ToastText } from "../toasts/ToastText";
import { useToastPhase } from "../toasts/useToastPhase";
import { Avatar } from "../ui/Avatar";

/** The avatar's diameter in px. */
const AVATAR_SIZE = 32;

const selectToasts = (live: LiveState) => live.toasts;
const selectParty = (live: LiveState) => live.stage?.party ?? null;
const selectMe = (live: LiveState) => live.phone?.memberId ?? null;

export function PhoneToasts({ store }: { store: LiveStore }) {
  const toasts = useLive(selectToasts, store);
  return (
    <div
      role="status"
      aria-label={t("toast.list")}
      className="pointer-events-none fixed inset-x-3 top-[calc(0.75rem+env(safe-area-inset-top,0px))] z-50"
    >
      {toasts.length > 0 && <ToastStack store={store} toasts={toasts} />}
    </div>
  );
}

/** Mounted only while there are toasts. */
function ToastStack({
  store,
  toasts,
}: {
  store: LiveStore;
  toasts: readonly Toast[];
}) {
  const party = useLive(selectParty, store);
  const me = useLive(selectMe, store);
  const profiles = useQuery(profilesQuery).data ?? [];
  return (
    <ul className="flex flex-col gap-1.5">
      {toasts.map((toast) => (
        <ToastPill
          key={toast.id}
          id={toast.id}
          store={store}
          content={toastContent(toast, party, profiles, me)}
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
      className={`flex items-center gap-2 rounded-full bg-ink-fill py-2 pr-4 text-base font-medium text-white shadow-[0_5px_0_var(--color-ink-ledge)] ${
        phase === "showing" ? "animate-toast-in" : "animate-toast-out"
      } ${actor ? "pl-2" : "pl-4"}`}
    >
      {actor && (
        // The name is in the text already; the avatar is not read twice.
        <span aria-hidden="true" className="flex shrink-0">
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
