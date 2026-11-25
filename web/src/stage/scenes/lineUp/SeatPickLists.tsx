// The short pick lists under a Line-up field (v1 spec #55): Who lists the
// Party members (#125 adds Profiles not in the Party, + Guest and
// + Profile), Mic lists the Mics, dimming those another seat has (with who
// has them) and unplugged Local mics. The seat's current choice takes the
// focus.

import type { LineUp } from "../../../generated/LineUp";
import type { MicKey } from "../../../generated/MicKey";
import type { PartyMemberId } from "../../../generated/PartyMemberId";
import type { PartySnapshot } from "../../../generated/PartySnapshot";
import type { Profile } from "../../../generated/Profile";
import { t } from "../../../i18n/t";
import { memberLook } from "../../../phone/memberLook";
import { Avatar } from "../../../ui/Avatar";
import { StagePickList, StagePickListEntry } from "../../frame/StagePickList";
import type { MicChoice, MicLabel } from "./lineUpView";

const POSITION = "top-full left-1/2 mt-4 -translate-x-1/2";
const ENTRY = "flex w-full items-center gap-4";
const DIMMED = "opacity-45";

export function WhoPickList({
  party,
  lineUp,
  current,
  nameOf,
  profiles,
  onClose,
  onPick,
}: {
  party: PartySnapshot;
  lineUp: LineUp;
  /** The seat's member; `null` for Add a singer. */
  current: PartyMemberId | null;
  nameOf: (memberId: PartyMemberId) => string;
  profiles: readonly Profile[] | undefined;
  onClose: () => void;
  onPick: (memberId: PartyMemberId) => void;
}) {
  const seated = new Set(lineUp.seats.map((s) => s.memberId));
  return (
    <StagePickList
      aria-label={t("stage.lineUp.whoList")}
      onClose={onClose}
      className={POSITION}
    >
      {party.members.map((member) => {
        const look = memberLook(member, profiles);
        const elsewhere =
          seated.has(member.memberId) && member.memberId !== current;
        return (
          <div
            key={member.memberId}
            className="contents"
            data-stage-default={member.memberId === current || undefined}
          >
            <StagePickListEntry
              onPick={() => {
                onPick(member.memberId);
              }}
            >
              <span className={elsewhere ? `${ENTRY} ${DIMMED}` : ENTRY}>
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
                {nameOf(member.memberId)}
              </span>
            </StagePickListEntry>
          </div>
        );
      })}
    </StagePickList>
  );
}

export function MicPickList({
  name,
  choices,
  micText,
  nameOf,
  onClose,
  onPick,
}: {
  /** The seat's member, naming the list. */
  name: string;
  choices: readonly MicChoice[];
  micText: (label: MicLabel) => string;
  nameOf: (memberId: PartyMemberId) => string;
  onClose: () => void;
  onPick: (mic: MicKey) => void;
}) {
  return (
    <StagePickList
      aria-label={t("stage.lineUp.micList", { name })}
      onClose={onClose}
      className={POSITION}
    >
      {choices.map((choice) => {
        const dimmed = choice.usedBy !== null || choice.unavailable;
        const note =
          choice.usedBy !== null
            ? t("stage.lineUp.micUsedBy", { name: nameOf(choice.usedBy) })
            : choice.unavailable
              ? t("stage.lineUp.micUnplugged")
              : null;
        return (
          <div
            key={JSON.stringify(choice.mic)}
            className="contents"
            data-stage-default={choice.current || undefined}
          >
            <StagePickListEntry
              onPick={() => {
                // A Mic in use or unplugged stays where it is.
                if (dimmed) onClose();
                else onPick(choice.mic);
              }}
            >
              <span className={dimmed ? `${ENTRY} ${DIMMED}` : ENTRY}>
                {micText(choice.label)}
                {note !== null && (
                  <span className="ml-auto text-xl font-medium text-mute">
                    {note}
                  </span>
                )}
              </span>
            </StagePickListEntry>
          </div>
        );
      })}
    </StagePickList>
  );
}
