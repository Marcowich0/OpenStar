// The Queue tab (v1 spec #49, "Queue tab"): the Queue as numbered Request
// cards with cover, title, the requested Players and who added each one, the
// head highlighted as up next or playing now. Tapping a card opens its
// actions sheet; Change singers opens the Request sheet in its "Save
// singers" form. There is no drag to reorder.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { profilesQuery, songQuery } from "../../api/queries";
import type { PartyMember } from "../../generated/PartyMember";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { Profile } from "../../generated/Profile";
import type { Request } from "../../generated/Request";
import type { RequestId } from "../../generated/RequestId";
import { t } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { useLive } from "../../live/useLive";
import { Avatar } from "../../ui/Avatar";
import { Cover } from "../../ui/Cover";
import { memberLook } from "../memberLook";
import { RequestSheet } from "../songs/RequestSheet";
import { headState } from "./queueActions";
import { RequestActionsSheet } from "./RequestActionsSheet";

const selectParty = (state: LiveState) => state.stage?.party ?? null;

/** "Bo, Jonas": the requested Players' names, in the catalogue's language. */
const NAMES = new Intl.ListFormat("en", { style: "short", type: "unit" });

/** A Party member's name, or `null` while the Profiles load or once they left. */
export function memberName(
  members: readonly PartyMember[],
  profiles: readonly Profile[] | undefined,
  memberId: number | null,
): string | null {
  const member = members.find((m) => m.memberId === memberId);
  return member ? (memberLook(member, profiles)?.name ?? null) : null;
}

export function QueueTab({ store }: { store: LiveStore }) {
  const party = useLive(selectParty, store);
  const profiles = useQuery(profilesQuery).data;
  const [opened, setOpened] = useState<RequestId | null>(null);
  const [changing, setChanging] = useState<Request | null>(null);
  const queue = party?.queue ?? [];

  return (
    <section className="flex flex-col gap-3 pt-2 pb-6">
      <h2 className="text-3xl font-bold">{t("queue.title")}</h2>
      {party === null || queue.length === 0 ? (
        <div className="flex flex-col items-center gap-1 rounded-card-sm bg-white px-5 py-6 text-center shadow-ledge-sm">
          <p className="text-xl font-bold">{t("queue.empty")}</p>
          <p className="text-ink-2">{t("queue.emptyHint")}</p>
        </div>
      ) : (
        <>
          <ol aria-label={t("queue.list")} className="flex flex-col gap-3">
            {queue.map((request, place) => (
              <RequestCard
                key={request.requestId}
                party={party}
                request={request}
                place={place}
                profiles={profiles}
                onOpen={() => {
                  setOpened(request.requestId);
                }}
              />
            ))}
          </ol>
          <p className="text-sm text-mute">{t("queue.hint")}</p>
        </>
      )}

      <RequestActionsSheet
        store={store}
        requestId={opened}
        onClose={() => {
          setOpened(null);
        }}
        onChangeSingers={(request) => {
          setOpened(null);
          setChanging(request);
        }}
      />
      <RequestSheet
        store={store}
        target={
          changing === null ? null : { kind: "change", request: changing }
        }
        onClose={() => {
          setChanging(null);
        }}
      />
    </section>
  );
}

function RequestCard({
  party,
  request,
  place,
  profiles,
  onOpen,
}: {
  party: PartySnapshot;
  request: Request;
  place: number;
  profiles: readonly Profile[] | undefined;
  onOpen: () => void;
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
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={`flex w-full cursor-pointer items-center gap-3 rounded-card-sm bg-white p-3 text-left shadow-ledge-sm outline-none focus-visible:outline-4 focus-visible:outline-yellow ${head ? "ring-3 ring-yellow" : ""}`}
      >
        <span className="w-7 shrink-0 text-center text-xl font-bold text-mute tabular-nums">
          {t("queue.place", { place: place + 1 })}
        </span>
        <Cover
          src={song?.media.cover ?? null}
          tileColour={song?.media.tileColour ?? "teal"}
          rim={3}
          className="w-13 shrink-0"
        />
        <span className="flex min-w-0 grow flex-col gap-0.5">
          {head && (
            <span
              className={`self-start rounded-full px-2 text-xs font-semibold ${head === "playing" ? "bg-red text-white" : "bg-yellow text-ink"}`}
            >
              {t(head === "playing" ? "queue.playingNow" : "queue.upNext")}
            </span>
          )}
          <span className="truncate text-lg leading-tight font-semibold">
            {title}
          </span>
          <span className="truncate text-sm text-ink-2">{line}</span>
        </span>
        {players.length > 0 && (
          <span aria-hidden="true" className="flex shrink-0">
            {players.slice(0, 3).map(({ member, look }) => (
              <span
                key={member.memberId}
                className="-ml-2 rounded-full ring-2 ring-white first:ml-0"
              >
                <Avatar
                  name={look.name}
                  avatar={look.avatar}
                  colour={member.colour}
                  size={28}
                />
              </span>
            ))}
          </span>
        )}
      </button>
    </li>
  );
}
