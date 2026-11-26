// The Line-up scene (v1 spec #55, "Line-up screen"): shown while the head's
// Line-up waits for Start. The Song at the top, "Then …" in the top right,
// one tall card per seat with Who, Mic, Voice (duets only) and Difficulty,
// warnings hanging under the seat they concern, and Start, greyed and shaking
// until the server says the Line-up can start. Every edit is an `editLineUp`
// command; the Party snapshot that comes back redraws the screen, so edits
// from Remotes show at once. It never starts by itself.

import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";

import { profilesQuery, songsQuery } from "../../../api/queries";
import type { LineUp } from "../../../generated/LineUp";
import type { LineUpEdit } from "../../../generated/LineUpEdit";
import type { PartyMemberId } from "../../../generated/PartyMemberId";
import type { PartySnapshot } from "../../../generated/PartySnapshot";
import type { SongId } from "../../../generated/SongId";
import type { SeatWho } from "../../../generated/SeatWho";
import type { SongSummary } from "../../../generated/SongSummary";
import type { UserMessage } from "../../../generated/UserMessage";
import { lineUpWarningText } from "../../../i18n/serverText";
import { t } from "../../../i18n/t";
import type { LiveState } from "../../../live/liveState";
import { useLive } from "../../../live/useLive";
import { useLocalMics } from "../../../mics/LocalMics";
import { request } from "../../../phone/joinRequests";
import { memberLook } from "../../../phone/memberLook";
import { Button } from "../../../ui/Button";
import { Cover } from "../../../ui/Cover";
import { useStageFrame, useStageKeys } from "../../frame/stageFrameContext";
import {
  localMicOptions,
  micChoices,
  micHasProblem,
  micLabel,
  placeWarnings,
  seatLevelDbfs,
  thenSongIds,
  type MicLabel,
  type MicLevels,
} from "./lineUpView";
import { AddSingerCard, SeatCard } from "./SeatCard";
import { MicPickList, WhoPickList } from "./SeatPickLists";

/** v1 seats at most 4 Players (v1 spec #48). */
export const SEATS = 4;

/** The open pick list: a seat's Who or Mic list (Who for Add a singer). */
interface Picking {
  seat: number;
  field: "who" | "mic";
}

const selectParty = (live: LiveState) => live.stage?.party ?? null;

export function LineUpScene() {
  const { store } = useStageFrame();
  const party = useLive(selectParty, store);
  const lineUp = party?.lineUp ?? null;
  if (!party || !lineUp) return <section className="h-full" />;
  return <LineUpBody party={party} lineUp={lineUp} />;
}

/** Where the seat meters read each Mic's level. */
function useMicLevels(): MicLevels {
  const { capture, bridgeLevelDbfs, phoneLevelDbfs } = useLocalMics();
  return useMemo(
    () => ({
      browser: (deviceId, channel) =>
        capture?.levelDbfs(deviceId, channel) ?? null,
      bridge: bridgeLevelDbfs,
      phone: phoneLevelDbfs,
    }),
    [capture, bridgeLevelDbfs, phoneLevelDbfs],
  );
}

function LineUpBody({
  party,
  lineUp,
}: {
  party: PartySnapshot;
  lineUp: LineUp;
}) {
  const { store } = useStageFrame();
  const profiles = useQuery(profilesQuery).data;
  const songs = useQuery(songsQuery()).data?.songs;
  const localMics = localMicOptions(party);
  const levels = useMicLevels();
  const [picking, setPicking] = useState<Picking | null>(null);
  const startRef = useRef<HTMLDivElement>(null);

  const songOf = (id: SongId | undefined): SongSummary | undefined =>
    songs?.find((s) => s.id === id);
  const nameOf = (memberId: PartyMemberId): string => {
    const member = party.members.find((m) => m.memberId === memberId);
    return (member && memberLook(member, profiles)?.name) ?? "";
  };
  const micText = (label: MicLabel | null): string => {
    if (label === null) return t("stage.lineUp.noMic");
    return label.kind === "phone"
      ? t("stage.lineUp.phoneMic", { name: nameOf(label.memberId) })
      : label.name;
  };

  const edit = (change: LineUpEdit) => {
    store.send({
      type: "editLineUp",
      requestId: lineUp.requestId,
      edit: change,
    });
  };
  // Seats someone who enters the Party, and waits for the server: done once
  // a member who was not in the Party sits in that seat, or the Line-up is
  // gone; a refusal comes back to show in the list.
  const seatNew = (seat: number, who: SeatWho): Promise<UserMessage | null> => {
    const before = new Set(party.members.map((m) => m.memberId));
    const change: LineUpEdit =
      seat < lineUp.seats.length
        ? { kind: "setWho", seat, who }
        : { kind: "addSeat", who };
    return request<UserMessage | null>(
      store,
      { type: "editLineUp", requestId: lineUp.requestId, edit: change },
      (state) => {
        const now = state.stage?.party?.lineUp;
        if (now?.requestId !== lineUp.requestId) return null;
        const sitter = now.seats[seat]?.memberId;
        if (sitter === undefined || before.has(sitter)) return undefined;
        close();
        return null;
      },
      (reason) => reason,
      null,
    );
  };
  const start = () => {
    store.send({
      type: "controlSong",
      requestId: lineUp.requestId,
      control: "start",
    });
  };

  // Space presses Start: it starts a ready Line-up and shakes a greyed one.
  // Bound in the scene layer, so it does nothing while a pick list is open.
  useStageKeys({
    " ": () => {
      startRef.current?.querySelector("button")?.click();
      return true;
    },
  });

  const head = songOf(party.queue[0]?.songId);
  const then = thenSongIds(party)
    .map((id) => songOf(id)?.title)
    .filter((title): title is string => title !== undefined);
  const { bySeat, songWide } = placeWarnings(lineUp);
  const close = () => {
    setPicking(null);
  };

  return (
    <section className="relative flex h-full flex-col items-center">
      <header className="mt-14 flex items-center gap-[26px]">
        <Cover
          src={head?.cover ?? null}
          tileColour={head?.tileColour ?? "teal"}
          rim={7}
          className="w-[120px]"
        />
        <div>
          <h1 className="text-[72px] leading-none font-bold">{head?.title}</h1>
          <p className="mt-1.5 text-[32px] font-medium text-ink-2">
            {head && lineUp.duet
              ? t("stage.lineUp.artistDuet", { artist: head.artist })
              : head?.artist}
          </p>
        </div>
      </header>

      {then.length > 0 && (
        <p className="absolute top-[140px] right-12 max-w-[520px] text-right text-[22px] leading-snug font-semibold text-ink-2">
          {then.length === 1
            ? t("stage.lineUp.thenOne", { first: then[0] ?? "" })
            : t("stage.lineUp.thenTwo", {
                first: then[0] ?? "",
                second: then[1] ?? "",
              })}
        </p>
      )}

      <ol
        aria-label={t("stage.lineUp.seats")}
        className="mt-14 flex items-start gap-[34px]"
      >
        {lineUp.seats.map((seat, index) => {
          const member = party.members.find(
            (m) => m.memberId === seat.memberId,
          );
          const look = member ? memberLook(member, profiles) : null;
          const open = picking?.seat === index ? picking.field : null;
          const warnings = bySeat[index] ?? [];
          return (
            <li key={`${String(index)}-${String(seat.memberId)}`}>
              <SeatCard
                seat={seat}
                readLevel={() =>
                  seatLevelDbfs(seat.mic, party.localMics, levels)
                }
                duet={lineUp.duet}
                name={look?.name ?? ""}
                avatar={look?.avatar ?? null}
                colour={member?.colour ?? "teal"}
                micText={micText(
                  seat.mic === null
                    ? null
                    : micLabel(party, seat.mic, localMics),
                )}
                micBad={micHasProblem(warnings)}
                warnings={warnings.map((w) => lineUpWarningText(w, nameOf))}
                order={index}
                isDefault={index === 0}
                onWho={() => {
                  setPicking({ seat: index, field: "who" });
                }}
                onMic={() => {
                  setPicking({ seat: index, field: "mic" });
                }}
                onEdit={(change) => {
                  edit(change(index));
                }}
                whoList={
                  open === "who" && (
                    <WhoPickList
                      party={party}
                      lineUp={lineUp}
                      current={seat.memberId}
                      nameOf={nameOf}
                      profiles={profiles}
                      onClose={close}
                      onSeat={(who) => seatNew(index, who)}
                      onPick={(memberId) => {
                        close();
                        edit({
                          kind: "setWho",
                          seat: index,
                          who: { kind: "member", memberId },
                        });
                      }}
                    />
                  )
                }
                micList={
                  open === "mic" && (
                    <MicPickList
                      name={look?.name ?? ""}
                      choices={micChoices(party, lineUp, index, localMics)}
                      micText={micText}
                      nameOf={nameOf}
                      onClose={close}
                      onPick={(mic) => {
                        close();
                        edit({ kind: "setMic", seat: index, mic });
                      }}
                    />
                  )
                }
              />
            </li>
          );
        })}
        {lineUp.seats.length < SEATS && (
          <li>
            <AddSingerCard
              order={lineUp.seats.length}
              isDefault={lineUp.seats.length === 0}
              onPress={() => {
                setPicking({ seat: lineUp.seats.length, field: "who" });
              }}
            >
              {picking?.seat === lineUp.seats.length && (
                <WhoPickList
                  party={party}
                  lineUp={lineUp}
                  current={null}
                  nameOf={nameOf}
                  profiles={profiles}
                  onClose={close}
                  onSeat={(who) => seatNew(lineUp.seats.length, who)}
                  onPick={(memberId) => {
                    close();
                    edit({
                      kind: "addSeat",
                      who: { kind: "member", memberId },
                    });
                  }}
                />
              )}
            </AddSingerCard>
          </li>
        )}
      </ol>

      <div className="absolute inset-x-0 bottom-[90px] flex flex-col items-center gap-3.5">
        {songWide.map((warning) => (
          <p
            key={JSON.stringify(warning)}
            className="text-[28px] font-semibold text-warn-fg"
          >
            {lineUpWarningText(warning, nameOf)}
          </p>
        ))}
        <div ref={startRef}>
          <Button
            fill="green"
            size="big"
            breathing
            isDisabled={!lineUp.canStart}
            onPress={start}
          >
            {t("stage.start")}
          </Button>
        </div>
      </div>
    </section>
  );
}
