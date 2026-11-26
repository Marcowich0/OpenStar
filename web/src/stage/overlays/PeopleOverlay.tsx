// The People overlay, "Tonight's Party" (v1 spec #55, "Overlays: Songs,
// Queue and People"): the twelve Party colours as a 6 × 2 grid in palette
// order, each spot showing who holds it or that it is free. Holding a
// spot's control removes that Party member (not one in the Line-up, who
// shows "singing"); New party, also a hold, and the join card sit at the
// bottom. The join card here never hides, whatever the song browser's Hide
// choice. Deleting a Profile lives in the Admin area, never here.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { profilesQuery } from "../../api/queries";
import type { PartyMember } from "../../generated/PartyMember";
import { colourName } from "../../i18n/colourNames";
import { userMessageText } from "../../i18n/serverText";
import { t } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import { useLive } from "../../live/useLive";
import { removeMember, type Refusal } from "../../phone/people/memberRequests";
import { peopleRows, type PeopleRow } from "../../phone/people/people";
import { PALETTE_KEYS, tokenVar, type PaletteKey } from "../../theme/tokens";
import { Avatar } from "../../ui/Avatar";
import { HoldButton } from "../../ui/HoldButton";
import { useStageFrame } from "../frame/stageFrameContext";
import { StageJoinCard } from "../joinCard/StageJoinCard";

const NO_MEMBERS: readonly PartyMember[] = [];
const selectMembers = (live: LiveState) =>
  live.stage?.party?.members ?? NO_MEMBERS;

export function PeopleOverlay() {
  const { store } = useStageFrame();
  const members = useLive(selectMembers, store);
  const profiles = useQuery(profilesQuery).data;
  const [problem, setProblem] = useState<Refusal>(null);
  // The Stage is no Party member, so no row is "me".
  const rows = peopleRows(members, null, profiles);
  const byColour = new Map(rows.map((row) => [row.member.colour, row]));

  return (
    <div className="flex flex-col gap-6">
      <p className="-mt-4 text-3xl text-ink-2">
        {t("stage.people.count", { count: members.length })}
      </p>
      <ul
        aria-label={t("stage.people.colours")}
        className="grid grid-cols-6 gap-4"
      >
        {PALETTE_KEYS.map((colour) => {
          const row = byColour.get(colour);
          return row ? (
            <TakenSpot
              key={colour}
              row={row}
              onRemove={() => {
                setProblem(null);
                void removeMember(store, row.member.memberId).then(setProblem);
              }}
            />
          ) : (
            <FreeSpot key={colour} colour={colour} />
          );
        })}
      </ul>
      {problem ? (
        <p role="alert" className="text-2xl font-semibold text-warn-fg">
          {userMessageText(problem)}
        </p>
      ) : null}
      <div className="flex items-end justify-between gap-8">
        <HoldButton
          fill="ink"
          onHold={() => {
            store.send({ type: "newParty" });
          }}
        >
          {t("stage.newParty")}
        </HoldButton>
        <StageJoinCard hideable={false} layout="wide" />
      </div>
    </div>
  );
}

const SPOT =
  "flex h-[212px] min-w-0 flex-col items-center gap-1 rounded-card-sm p-3 text-center *:shrink-0";

function TakenSpot({
  row,
  onRemove,
}: {
  row: PeopleRow;
  onRemove: () => void;
}) {
  const { member, look } = row;
  const name = look?.name ?? "";
  return (
    <li
      data-colour={member.colour}
      data-free="false"
      aria-label={name}
      className={`${SPOT} border-t-[6px] bg-white shadow-ledge-sm`}
      style={{ borderTopColor: tokenVar(member.colour) }}
    >
      {look ? (
        <Avatar
          name={look.name}
          avatar={look.avatar}
          colour={member.colour}
          size={56}
        />
      ) : (
        <span className="size-14" />
      )}
      <span className="w-full truncate text-2xl leading-tight font-semibold">
        {name}
      </span>
      <span className="flex gap-1.5 text-lg leading-tight text-ink-2">
        <span>
          {t(row.guest ? "stage.people.guest" : "stage.people.profile")}
        </span>
        <span className="before:mr-1.5 before:content-['·']">
          {t(member.onPhone ? "stage.people.phone" : "stage.people.localMic")}
        </span>
      </span>
      <span className="mt-auto">
        {row.remove === "singing" ? (
          <span className="inline-block rounded-full bg-green px-4 py-1 text-lg font-semibold text-white">
            {t("stage.people.singing")}
          </span>
        ) : (
          <HoldButton
            size="small"
            aria-label={t("stage.people.remove", { name })}
            onHold={onRemove}
          >
            <span className="text-base">{t("stage.people.holdToRemove")}</span>
          </HoldButton>
        )}
      </span>
    </li>
  );
}

function FreeSpot({ colour }: { colour: PaletteKey }) {
  const label = t("stage.people.free", { colour: colourName(colour) });
  return (
    <li
      data-colour={colour}
      data-free="true"
      aria-label={label}
      className={`${SPOT} justify-center border-4 border-dashed border-mute`}
    >
      <span
        data-free-ring
        aria-hidden="true"
        className="size-16 rounded-full border-[6px]"
        style={{ borderColor: tokenVar(colour) }}
      />
      <span className="text-xl font-semibold text-ink-2">{label}</span>
    </li>
  );
}
