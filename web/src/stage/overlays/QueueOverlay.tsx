// The Queue overlay (v1 spec #55, "Overlays: Songs, Queue and People"): the
// Requests as rows, the head of the Queue first, ringed in green and marked
// up next. Enter on a row opens its pick list with the Phone Queue tab's
// actions under the same rules (`phone/queue/queueActions.ts`); removing a
// Request is a hold, and the Request whose Song plays can't be removed here.
// Change singers turns the pick list into the Party members, toggled with
// Enter, up to the seat count. Changes made here don't toast: the store keeps
// no toast for a change the Stage made.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { profilesQuery, songQuery } from "../../api/queries";
import type { PartyMemberId } from "../../generated/PartyMemberId";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { Profile } from "../../generated/Profile";
import type { QueueMove } from "../../generated/QueueMove";
import type { Request } from "../../generated/Request";
import type { RequestId } from "../../generated/RequestId";
import type { UserMessage } from "../../generated/UserMessage";
import { userMessageText } from "../../i18n/serverText";
import { t } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { SEATS } from "../../live/seats";
import { useLive } from "../../live/useLive";
import { memberLook } from "../../phone/memberLook";
import { headState, requestActions } from "../../phone/queue/queueActions";
import { moveRequest, removeRequest } from "../../phone/queue/queueCommands";
import { memberName } from "../../phone/queue/QueueTab";
import {
  setRequestedPlayers,
  type CommandResult,
} from "../../phone/songs/requestCommands";
import { Avatar } from "../../ui/Avatar";
import { Cover } from "../../ui/Cover";
import { coverSongOf } from "../../ui/generatedCover";
import { HoldButton } from "../../ui/HoldButton";
import { Icon } from "../../ui/Icon";
import { StagePickList, StagePickListEntry } from "../frame/StagePickList";
import { useStageFrame } from "../frame/stageFrameContext";
import { ByInput } from "../input/KeyHint";

const selectParty = (live: LiveState) => live.stage?.party ?? null;

/** "Bo, Jonas": the requested Players' names, in the catalogue's language. */
const NAMES = new Intl.ListFormat("en", { style: "short", type: "unit" });

export function QueueOverlay() {
  const { store } = useStageFrame();
  const party = useLive(selectParty, store);
  const profiles = useQuery(profilesQuery).data;
  const [opened, setOpened] = useState<RequestId | null>(null);
  const queue = party?.queue ?? [];

  if (party === null || queue.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <p className="text-4xl font-bold">{t("queue.empty")}</p>
        <p className="text-2xl text-ink-2">{t("queue.emptyHint")}</p>
      </div>
    );
  }

  return (
    <ol aria-label={t("queue.list")} className="flex flex-col gap-5 p-2">
      {queue.map((request, place) => (
        <QueueRow
          key={request.requestId}
          store={store}
          party={party}
          request={request}
          place={place}
          profiles={profiles}
          open={opened === request.requestId}
          onOpen={() => {
            setOpened(request.requestId);
          }}
          onClose={() => {
            setOpened(null);
          }}
        />
      ))}
    </ol>
  );
}

function QueueRow({
  store,
  party,
  request,
  place,
  profiles,
  open,
  onOpen,
  onClose,
}: {
  store: LiveStore;
  party: PartySnapshot;
  request: Request;
  place: number;
  profiles: readonly Profile[] | undefined;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const song = useQuery(songQuery(request.songId)).data;
  const head = headState(party, request.requestId);
  const players = request.requestedPlayers.flatMap((id) => {
    const member = party.members.find((m) => m.memberId === id);
    const look = member ? memberLook(member, profiles) : null;
    return member && look ? [{ member, look }] : [];
  });
  const adder = memberName(party.members, profiles, request.adder);
  const who =
    players.length === 0
      ? t("queue.anyone")
      : NAMES.format(players.map((s) => s.look.name));
  const by =
    request.adder === null
      ? t("queue.fromStage")
      : adder === null
        ? ""
        : t("queue.addedBy", { name: adder });
  const line = by === "" ? who : t("queue.whoBy", { who, by });
  const title = song?.song.headers.title ?? "";

  return (
    <li className="relative" {...(head ? { "data-head": head } : {})}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onOpen}
        className={`flex w-full cursor-pointer items-center gap-6 rounded-card-sm bg-white p-4 text-left shadow-ledge-sm ${head ? "ring-6 ring-green" : ""}`}
      >
        <span className="w-12 shrink-0 text-center text-4xl font-bold text-mute tabular-nums">
          {t("queue.place", { place: place + 1 })}
        </span>
        <Cover
          src={song?.media.cover ?? null}
          song={coverSongOf(song)}
          rim={4}
          className="w-24 shrink-0"
        />
        <span className="flex min-w-0 grow flex-col gap-1">
          {head && (
            <span
              className={`self-start rounded-full px-4 text-xl font-semibold ${head === "playing" ? "bg-red text-white" : "bg-green text-white"}`}
            >
              {t(head === "playing" ? "queue.playingNow" : "queue.upNext")}
            </span>
          )}
          <span
            data-testid="queue-row-title"
            className="truncate text-4xl leading-tight font-semibold"
          >
            {title}
          </span>
          <span className="truncate text-2xl text-ink-2">{line}</span>
        </span>
        {players.length > 0 && (
          <span aria-hidden="true" className="flex shrink-0">
            {players.map(({ member, look }) => (
              <span
                key={member.memberId}
                className="-ml-3 rounded-full ring-4 ring-white first:ml-0"
              >
                <Avatar
                  name={look.name}
                  avatar={look.avatar}
                  colour={member.colour}
                  size={56}
                />
              </span>
            ))}
          </span>
        )}
      </button>
      {open && (
        <RequestPickList
          store={store}
          party={party}
          request={request}
          title={title}
          profiles={profiles}
          onClose={onClose}
        />
      )}
    </li>
  );
}

/** A row's actions; Change singers turns it into the singers list. */
function RequestPickList({
  store,
  party,
  request,
  title,
  profiles,
  onClose,
}: {
  store: LiveStore;
  party: PartySnapshot;
  request: Request;
  title: string;
  profiles: readonly Profile[] | undefined;
  onClose: () => void;
}) {
  const [pickingPlayers, setPickingPlayers] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<UserMessage | "noAnswer" | null>(null);
  const actions = requestActions(party, request.requestId);
  if (!actions) return null;

  function run(command: Promise<CommandResult>, closeOnDone: boolean) {
    setPending(true);
    setProblem(null);
    void command.then((result) => {
      setPending(false);
      if (!result.ok) setProblem(result.reason ?? "noAnswer");
      else if (closeOnDone) onClose();
    });
  }
  const move = (to: QueueMove) => () => {
    if (!pending) run(moveRequest(store, request.requestId, to), true);
  };

  const problemText = problem !== null && (
    <p role="alert" className="px-2 text-2xl font-semibold text-warn-fg">
      {problem === "noAnswer"
        ? t("request.noAnswer")
        : userMessageText(problem)}
    </p>
  );

  if (pickingPlayers) {
    const chosen = request.requestedPlayers;
    // Each Enter sends at once, from the singers the snapshot shows.
    const toggle = (memberId: PartyMemberId) => {
      const next = chosen.includes(memberId)
        ? chosen.filter((id) => id !== memberId)
        : [...chosen, memberId];
      if (next.length > SEATS) return;
      run(setRequestedPlayers(store, request.requestId, next), false);
    };
    return (
      <StagePickList
        aria-label={t("stage.queue.singers", { song: title })}
        onClose={onClose}
        className="top-full right-6 mt-4"
      >
        <div className="flex max-h-[560px] flex-col gap-3 overflow-y-auto">
          {party.members.map((member) => {
            const look = memberLook(member, profiles);
            const on = chosen.includes(member.memberId);
            const full = !on && chosen.length >= SEATS;
            return (
              <button
                key={member.memberId}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                aria-disabled={full || undefined}
                onClick={() => {
                  toggle(member.memberId);
                }}
                className={`flex min-h-19 w-full cursor-pointer items-center gap-4 rounded-full bg-cream px-6 text-left text-3xl font-semibold ${full ? "opacity-45" : ""}`}
              >
                {look && (
                  <span aria-hidden="true">
                    <Avatar
                      name={look.name}
                      avatar={look.avatar}
                      colour={member.colour}
                      size={52}
                    />
                  </span>
                )}
                <span className="grow">{look?.name}</span>
                <span
                  aria-hidden="true"
                  className={`inline-flex size-10 items-center justify-center rounded-full ring-4 ring-ink ${on ? "bg-green" : "bg-white"}`}
                >
                  {on && <Icon name="check" className="size-7 text-white" />}
                </span>
              </button>
            );
          })}
        </div>
        <p className="px-2 text-xl text-ink-2">
          <ByInput
            keys={t("stage.queue.singersHint", { seats: SEATS })}
            pad={t("stage.queue.singersHint.pad", { seats: SEATS })}
          />
        </p>
        {problemText}
      </StagePickList>
    );
  }

  return (
    <StagePickList
      aria-label={t("stage.queue.actions", { song: title })}
      onClose={onClose}
      className="top-full right-6 mt-4"
    >
      {actions.playNext && (
        <StagePickListEntry onPick={move("next")}>
          {t("queue.playNext")}
        </StagePickListEntry>
      )}
      {actions.moveUp && (
        <StagePickListEntry onPick={move("up")}>
          {t("queue.moveUp")}
        </StagePickListEntry>
      )}
      {actions.moveDown && (
        <StagePickListEntry onPick={move("down")}>
          {t("queue.moveDown")}
        </StagePickListEntry>
      )}
      {actions.changeSingers && (
        <StagePickListEntry
          onPick={() => {
            setProblem(null);
            setPickingPlayers(true);
          }}
        >
          {t("queue.changeSingers")}
        </StagePickListEntry>
      )}
      {actions.remove === "hold" ? (
        <HoldButton
          fill="red"
          onHold={() => {
            if (!pending) run(removeRequest(store, request.requestId), true);
          }}
        >
          {t("queue.remove")}
        </HoldButton>
      ) : (
        <p className="max-w-[560px] px-2 text-2xl text-ink-2">
          {t("queue.isPlaying")}
        </p>
      )}
      {problemText}
    </StagePickList>
  );
}
