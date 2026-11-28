// The People overlay (v1 spec #55, "Overlays: Songs, Queue and People";
// reordered by spec #241): the Party members first, as cards in the order
// they joined, then the free colours as a compact row of named swatches.
// Holding a card's control removes that Party member (not one in the
// Line-up, who shows "singing"). New party, also a hold, says what it
// clears; the join card sits beside it and never hides here, whatever the
// song browser's Hide choice. Deleting a Profile lives in the Admin area,
// never here.
//
// A Profile's card opens its Profile page (spec #244) on Enter or a click:
// a layer over this overlay, so Esc comes back here. Guests have none.

import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

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
  const taken = new Set(members.map((member) => member.colour));
  const free = PALETTE_KEYS.filter((colour) => !taken.has(colour));

  return (
    <div className="flex flex-col gap-6">
      <p className="-mt-4 text-3xl text-ink-2">
        {t("stage.people.count", { count: members.length })}
      </p>
      {rows.length > 0 ? (
        <ul
          aria-label={t("stage.people.members")}
          className="grid grid-cols-6 gap-4"
        >
          {rows.map((row) => (
            <MemberCard
              key={row.member.memberId}
              row={row}
              onRemove={() => {
                setProblem(null);
                void removeMember(store, row.member.memberId).then(setProblem);
              }}
              onOpen={(id) => {
                setShown({ id, name: row.look?.name ?? "" });
              }}
            />
          ))}
        </ul>
      ) : (
        <p className="rounded-card-sm border-4 border-dashed border-mute py-10 text-center text-3xl font-semibold text-ink-2">
          {t("stage.people.nobody")}
        </p>
      )}
      {free.length > 0 ? <FreeColours colours={free} /> : null}
      {problem ? (
        <p role="alert" className="text-2xl font-semibold text-warn-fg">
          {userMessageText(problem)}
        </p>
      ) : null}
      <div className="flex items-end justify-between gap-8">
        <NewParty
          onHold={() => {
            store.send({ type: "newParty" });
          }}
        />
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
      className="absolute inset-0 z-[1] flex animate-pop-in flex-col gap-6 overflow-auto rounded-card bg-cream p-9"
    >
      <div className="flex justify-end">
        <button
          type="button"
          data-stage-default=""
          onClick={onClose}
          className="inline-flex h-16 cursor-pointer items-center gap-3 rounded-full bg-surface px-7 text-3xl font-semibold shadow-ledge-sm"
        >
          <Icon name="close" className="size-8" />
          {t("profilePage.back")}
        </button>
      </div>
      <ProfilePage profileId={profileId} size="stage" />
    </StageLayer>
  );
}

function MemberCard({
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
          size={48}
        />
      ) : (
        <span className="size-12" />
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
      aria-label={name}
      className="flex h-[192px] min-w-0 flex-col items-center gap-1 rounded-card-sm border-t-[6px] bg-surface p-3 text-center shadow-ledge-sm *:shrink-0"
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

function FreeColours({ colours }: { colours: readonly PaletteKey[] }) {
  const labelId = useId();
  return (
    <div className="flex items-baseline gap-6">
      <span id={labelId} className="shrink-0 text-xl text-ink-2">
        {t("stage.people.freeColours")}
      </span>
      <ul aria-labelledby={labelId} className="flex flex-wrap gap-x-6 gap-y-3">
        {colours.map((colour) => (
          <li
            key={colour}
            data-colour={colour}
            className="flex items-center gap-2 text-xl font-semibold"
          >
            <span
              data-swatch
              aria-hidden="true"
              className="size-7 shrink-0 self-center rounded-full"
              style={{ backgroundColor: tokenVar(colour) }}
            />
            {colourName(colour)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** New party, held, with the line that says what it clears. */
function NewParty({ onHold }: { onHold: () => void }) {
  const clearsId = useId();
  return (
    <div className="flex max-w-[400px] flex-col items-start gap-3">
      <p id={clearsId} className="text-xl leading-snug text-ink-2">
        {t("stage.newPartyClears")}
      </p>
      <HoldButton
        fill="outline-red"
        aria-describedby={clearsId}
        onHold={onHold}
      >
        {t("stage.newParty")}
      </HoldButton>
    </div>
  );
}
