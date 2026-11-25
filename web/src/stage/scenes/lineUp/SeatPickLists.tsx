// The short pick lists under a Line-up field (v1 spec #55): Who lists the
// Party members, then the Profiles not in the Party yet (most recently sung
// first), then + Guest and + Profile, which turn the list into a small form
// (`NewSingerForm`). Mic lists the Mics, dimming those another seat has (with who
// has them) and unplugged Local mics. The seat's current choice takes the
// focus.

import { useLayoutEffect, useRef, useState } from "react";

import type { LineUp } from "../../../generated/LineUp";
import type { MicKey } from "../../../generated/MicKey";
import type { PartyMemberId } from "../../../generated/PartyMemberId";
import type { PartySnapshot } from "../../../generated/PartySnapshot";
import type { Profile } from "../../../generated/Profile";
import type { ProfileId } from "../../../generated/ProfileId";
import type { SeatWho } from "../../../generated/SeatWho";
import type { UserMessage } from "../../../generated/UserMessage";
import { userMessageText } from "../../../i18n/serverText";
import { t } from "../../../i18n/t";
import { memberLook } from "../../../phone/memberLook";
import { Avatar } from "../../../ui/Avatar";
import { REFERENCE_HEIGHT } from "../../frame/referenceFrame";
import { StagePickList, StagePickListEntry } from "../../frame/StagePickList";
import {
  pickListTop,
  profilesToEnter,
  type MicChoice,
  type MicLabel,
} from "./lineUpView";
import { NewSingerForm, type NewSingerKind } from "./NewSingerForm";

const POSITION = "top-full left-1/2 mt-4 -translate-x-1/2";
const ENTRY = "flex w-full items-center gap-4";
const DIMMED = "opacity-45";

/**
 * Keeps a pick list inside the 1080 px frame: under its field when it fits,
 * else above it (`pickListTop`). Placed again whenever it changes size, as
 * when the Who list turns into a form. Put the ref on an element inside the list.
 */
function useFitInFrame() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const layer = ref.current?.closest<HTMLElement>("[data-stage-layer]");
    const box = layer?.closest("[data-reference-box]");
    if (!layer || !box) return;
    const place = () => {
      const anchor = layer.offsetParent;
      const frame = box.getBoundingClientRect();
      const scale = frame.height / REFERENCE_HEIGHT;
      if (!(anchor instanceof HTMLElement) || !(scale > 0)) return;
      const field = anchor.getBoundingClientRect();
      const top = pickListTop(
        {
          top: (field.top - frame.top) / scale,
          bottom: (field.bottom - frame.top) / scale,
        },
        layer.offsetHeight,
      );
      layer.style.top = `${String(top)}px`;
      layer.style.marginTop = "0px";
    };
    place();
    // The form grows when it shows a refusal: place it again.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    observer.observe(layer);
    return () => {
      observer.disconnect();
    };
  });
  return ref;
}

export function WhoPickList({
  party,
  lineUp,
  current,
  nameOf,
  profiles,
  onClose,
  onPick,
  onSeat,
}: {
  party: PartySnapshot;
  lineUp: LineUp;
  /** The seat's member; `null` for Add a singer. */
  current: PartyMemberId | null;
  nameOf: (memberId: PartyMemberId) => string;
  profiles: readonly Profile[] | undefined;
  onClose: () => void;
  /** A Party member: the list closes and the edit is sent. */
  onPick: (memberId: PartyMemberId) => void;
  /**
   * Someone who enters the Party (a Profile, a new Guest or Profile);
   * resolves to a refusal to show, or `null` when it is handled.
   */
  onSeat: (who: SeatWho) => Promise<UserMessage | null>;
}) {
  const [form, setForm] = useState<NewSingerKind | null>(null);
  const [problem, setProblem] = useState<UserMessage | null>(null);
  const seated = new Set(lineUp.seats.map((s) => s.memberId));
  const label = t("stage.lineUp.whoList");
  const fit = useFitInFrame();

  if (form !== null) {
    return (
      <StagePickList aria-label={label} onClose={onClose} className={POSITION}>
        <div ref={fit} className="contents" />
        <NewSingerForm
          kind={form}
          members={party.members}
          profiles={profiles ?? []}
          onSeat={onSeat}
        />
      </StagePickList>
    );
  }

  const seatProfile = (profileId: ProfileId) => {
    setProblem(null);
    void onSeat({ kind: "profile", profileId }).then(setProblem);
  };

  return (
    <StagePickList aria-label={label} onClose={onClose} className={POSITION}>
      <div
        ref={fit}
        className="-m-3 flex max-h-[600px] flex-col gap-3 overflow-y-auto p-5"
        onFocus={(event) => {
          event.target.scrollIntoView({ block: "nearest" });
        }}
      >
        {party.members.map((member) => {
          const look = memberLook(member, profiles);
          const elsewhere =
            seated.has(member.memberId) && member.memberId !== current;
          return (
            <div
              key={`m${String(member.memberId)}`}
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
        {profilesToEnter(party.members, profiles).map((profile) => (
          <StagePickListEntry
            key={`p${String(profile.id)}`}
            onPick={() => {
              seatProfile(profile.id);
            }}
          >
            <span className={ENTRY}>
              <span aria-hidden="true">
                <Avatar
                  name={profile.name}
                  avatar={profile.avatar}
                  colour={profile.favouriteColour}
                  size={52}
                />
              </span>
              {profile.name}
            </span>
          </StagePickListEntry>
        ))}
        {problem && (
          <p role="alert" className="px-4 text-2xl font-semibold text-warn-fg">
            {userMessageText(problem)}
          </p>
        )}
        <StagePickListEntry
          onPick={() => {
            setForm("guest");
          }}
        >
          {t("stage.lineUp.addGuest")}
        </StagePickListEntry>
        <StagePickListEntry
          onPick={() => {
            setForm("newProfile");
          }}
        >
          {t("stage.lineUp.addProfile")}
        </StagePickListEntry>
      </div>
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
