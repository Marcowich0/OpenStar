// A Request card's sheet (v1 spec #49, "Queue tab"): the Song, its place in
// the Queue and only the actions that Request allows (`requestActions`).
// Remove from the Queue is a press and hold; the Request whose Song plays
// says that Skip or End takes it off instead.

import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { songQuery } from "../../api/queries";
import type { QueueMove } from "../../generated/QueueMove";
import type { Request } from "../../generated/Request";
import type { RequestId } from "../../generated/RequestId";
import type { UserMessage } from "../../generated/UserMessage";
import { userMessageText } from "../../i18n/serverText";
import { t } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { useLive } from "../../live/useLive";
import { Cover } from "../../ui/Cover";
import { coverSongOf } from "../../ui/generatedCover";
import { HoldButton } from "../../ui/HoldButton";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";
import type { CommandResult } from "../songs/requestCommands";
import { requestActions } from "./queueActions";
import { moveRequest, removeRequest } from "./queueCommands";

const selectParty = (state: LiveState) => state.stage?.party ?? null;

export function RequestActionsSheet({
  store,
  requestId,
  onClose,
  onChangeSingers,
}: {
  store: LiveStore;
  /** The card's Request; `null` closes the sheet. */
  requestId: RequestId | null;
  onClose: () => void;
  onChangeSingers: (request: Request) => void;
}) {
  // Keep the last Request on screen while the sheet slides out.
  const [shown, setShown] = useState(requestId);
  if (requestId !== null && requestId !== shown) setShown(requestId);
  const party = useLive(selectParty, store);
  const request = party?.queue.find((r) => r.requestId === shown) ?? null;
  const song = useQuery({
    ...songQuery(request?.songId ?? 0),
    enabled: request !== null,
  }).data;
  // The Request left the Queue (removed here or elsewhere): nothing to act on.
  const open = requestId !== null && request !== null;

  return (
    <Sheet
      label={song?.song.headers.title ?? t("request.loading")}
      isOpen={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      {request !== null && (
        <SheetBody
          key={request.requestId}
          store={store}
          request={request}
          onClose={onClose}
          onChangeSingers={onChangeSingers}
        />
      )}
    </Sheet>
  );
}

function SheetBody({
  store,
  request,
  onClose,
  onChangeSingers,
}: {
  store: LiveStore;
  request: Request;
  onClose: () => void;
  onChangeSingers: (request: Request) => void;
}) {
  const party = useLive(selectParty, store);
  const song = useQuery(songQuery(request.songId)).data;
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<UserMessage | "noAnswer" | null>(null);
  const actions = party ? requestActions(party, request.requestId) : null;
  if (!party || !actions) return null;
  const place = party.queue.findIndex((r) => r.requestId === request.requestId);
  const where =
    party.head !== request.requestId
      ? t("queue.sheetPlace", { place: place + 1 })
      : actions.remove === "playing"
        ? t("queue.sheetPlaying")
        : t("queue.sheetHead");

  function run(command: Promise<CommandResult>) {
    setPending(true);
    setProblem(null);
    void command.then((result) => {
      setPending(false);
      if (result.ok) onClose();
      else setProblem(result.reason ?? "noAnswer");
    });
  }

  const move = (to: QueueMove) => () => {
    if (!pending) run(moveRequest(store, request.requestId, to));
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3.5 pb-1">
        <Cover
          src={song?.media.cover ?? null}
          song={coverSongOf(song)}
          rim={3}
          className="w-14 shrink-0"
        />
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate text-xl leading-tight font-bold">
            {song?.song.headers.title}
          </h2>
          <p className="truncate text-ink-2">{song?.song.headers.artist}</p>
        </div>
      </div>
      <h3 className="mt-1 text-sm font-semibold tracking-wide text-mute uppercase">
        {where}
      </h3>
      {actions.playNext && (
        <Option icon={<PlayNextIcon />} onPress={move("next")}>
          {t("queue.playNext")}
        </Option>
      )}
      {actions.moveUp && (
        <Option
          icon={<Icon name="chevron" className="size-6 -rotate-90" />}
          onPress={move("up")}
        >
          {t("queue.moveUp")}
        </Option>
      )}
      {actions.moveDown && (
        <Option
          icon={<Icon name="chevron" className="size-6 rotate-90" />}
          onPress={move("down")}
        >
          {t("queue.moveDown")}
        </Option>
      )}
      {actions.changeSingers && (
        <Option
          icon={<Icon name="people" className="size-6" />}
          onPress={() => {
            onChangeSingers(request);
          }}
        >
          {t("queue.changeSingers")}
        </Option>
      )}
      {actions.remove === "hold" ? (
        <HoldButton
          size="small"
          className="w-full"
          onHold={() => {
            if (!pending) run(removeRequest(store, request.requestId));
          }}
        >
          <Icon name="close" className="size-6 text-red" />
          <span className="text-lg text-red">{t("queue.remove")}</span>
        </HoldButton>
      ) : (
        <p className="px-1 text-ink-2">{t("queue.isPlaying")}</p>
      )}
      {problem !== null && (
        <p role="alert" className="text-center font-semibold text-warn-fg">
          {problem === "noAnswer"
            ? t("request.noAnswer")
            : userMessageText(problem)}
        </p>
      )}
    </div>
  );
}

/** Two chevrons pointing up: to the top of what may move. */
function PlayNextIcon() {
  return (
    <span className="flex size-6 flex-col items-center justify-center">
      <Icon name="chevron" className="-mb-2.5 size-5 -rotate-90" />
      <Icon name="chevron" className="size-5 -rotate-90" />
    </span>
  );
}

function Option({
  icon,
  onPress,
  children,
}: {
  icon: ReactNode;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      className="flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-card-sm bg-white px-3.5 py-2.5 text-left text-lg font-semibold shadow-ledge-sm outline-none focus-visible:outline-4 focus-visible:outline-yellow"
    >
      <span aria-hidden="true" className="text-ink-2">
        {icon}
      </span>
      {children}
    </button>
  );
}
