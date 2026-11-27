// The People overlay, "Tonight's Party" (v1 spec #55, "Overlays: Songs,
// Queue and People"): the twelve Party colours as a 6 × 2 grid in palette
// order, each spot showing who holds it or that it is free. Holding a
// spot's control removes that Party member (not one in the Line-up, who
// shows "singing"); New party, also a hold, and the join card sit at the
// bottom. The join card here never hides, whatever the song browser's Hide
// choice. Deleting a Profile lives in the Admin area, never here.
//
// A Profile's spot opens its Profile page (spec #244) on Enter or a click:
// a layer over this overlay, so Esc comes back here. Guests have none.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { profilesQuery } from "../../api/queries";
import type { PartyMember } from "../../generated/PartyMember";
import type { ProfileId } from "../../generated/ProfileId";
import { colourName } from "../../i18n/colourNames";
import { userMessageText } from "../../i18n/serverText";
import { t } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import { useLive } from "../../live/useLive";
import { removeMember, type Refusal } from "../../phone/people/memberRequests";
import { peopleRows, type PeopleRow } from "../../phone/people/people";
import { ProfilePage, type ShownProfile } from "../../profile/ProfilePage";
import { PALETTE_KEYS, tokenVar, type PaletteKey } from "../../theme/tokens";
import { Avatar } from "../../ui/Avatar";
import { HoldButton } from "../../ui/HoldButton";
import { Icon } from "../../ui/Icon";
import { StageLayer, useStageFrame } from "../frame/stageFrameContext";
import { StageJoinCard } from "../joinCard/StageJoinCard";

const NO_MEMBERS: readonly PartyMember[] = [];
const selectMembers = (live: LiveState) =>
  live.stage?.party?.members ?? NO_MEMBERS;

export function PeopleOverlay() {
  const { store } = useStageFrame();
  const members = useLive(selectMembers, store);
  const profiles = useQuery(profilesQuery).data;
  const [problem, setProblem] = useState<Refusal>(null);
  const [shown, setShown] = useState<ShownProfile | null>(null);
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
              onOpen={(id) => {
                setShown({ id, name: row.look?.name ?? "" });
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
      {shown ? (
        <ProfileLayer
          profileId={shown.id}
          name={shown.name}
          onClose={() => {
            setShown(null);
          }}
        />
      ) : null}
    </div>
  );
}

/** A Profile's page over the overlay: Esc and Back come back to the grid. */
function ProfileLayer({
  profileId,
  name,
  onClose,
}: {
  profileId: ProfileId;
  name: string;
  onClose: () => void;
}) {
  return (
    <StageLayer
      onDismiss={onClose}
      role="dialog"
      aria-modal
      aria-label={t("profilePage.sheet", { name })}
      className="absolute inset-0 z-10 flex animate-pop-in flex-col gap-6 overflow-auto rounded-card bg-cream p-9"
    >
      <div className="flex justify-end">
        <button
          type="button"
          data-stage-default=""
          onClick={onClose}
          className="inline-flex h-16 cursor-pointer items-center gap-3 rounded-full bg-white px-7 text-3xl font-semibold shadow-ledge-sm"
        >
          <Icon name="close" className="size-8" />
          {t("profilePage.back")}
        </button>
      </div>
      <ProfilePage profileId={profileId} size="stage" />
    </StageLayer>
  );
}

const SPOT =
  "flex h-[212px] min-w-0 flex-col items-center gap-1 rounded-card-sm p-3 text-center *:shrink-0";

function TakenSpot({
  row,
  onRemove,
  onOpen,
}: {
  row: PeopleRow;
  onRemove: () => void;
  /** Opens the Profile page; never called for a Guest. */
  onOpen: (profileId: ProfileId) => void;
}) {
  const { member, look } = row;
  const name = look?.name ?? "";
  const who = (
    <>
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
    </>
  );
  const identity = member.identity;
  return (
    <li
      data-colour={member.colour}
      data-free="false"
      aria-label={name}
      className={`${SPOT} border-t-[6px] bg-white shadow-ledge-sm`}
      style={{ borderTopColor: tokenVar(member.colour) }}
    >
      {identity.kind === "profile" ? (
        <button
          type="button"
          aria-label={t("stage.people.openProfile", { name })}
          onClick={() => {
            onOpen(identity.profileId);
          }}
          className="-m-1 flex w-[calc(100%+0.5rem)] min-w-0 cursor-pointer flex-col items-center gap-1 rounded-card-sm p-1 *:shrink-0"
        >
          {who}
        </button>
      ) : (
        who
      )}
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
