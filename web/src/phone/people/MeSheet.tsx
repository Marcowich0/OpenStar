import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  Label,
  RadioButton,
  RadioField,
  RadioGroup,
} from "react-aria-components";

import { profilesQuery } from "../../api/queries";
import type { Difficulty } from "../../generated/Difficulty";
import type { PartyMember } from "../../generated/PartyMember";
import type { PhoneId } from "../../generated/PhoneId";
import { colourName } from "../../i18n/colourNames";
import { difficultyName } from "../../i18n/seatNames";
import { t } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { useLive } from "../../live/useLive";
import { Avatar } from "../../ui/Avatar";
import { Sheet } from "../../ui/Sheet";
import type { MemberLook } from "../memberLook";
import { LeaveParty } from "./LeaveParty";
import { setMyDifficulty } from "./memberRequests";
import { myDifficulty, playingSeats, showsAdminLink } from "./people";

const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "hard"];

function isDifficulty(key: unknown): key is Difficulty {
  return DIFFICULTIES.some((d) => d === key);
}

const selectParty = (state: LiveState) => state.stage?.party ?? null;

/** What the Me sheet hands back to the Phone page. */
export interface MeActions {
  /** This browser's Phone id: the Admin link hides while it is a Mic mid-Song. */
  phoneId: PhoneId;
  /** "Someone else is using this phone": back to "Who's singing?". */
  onSomeoneElse: () => void;
  /** "Change name, look or colour": the join form, filled in. */
  onChangeLook: (look: MemberLook) => void;
}

const OPTION =
  "flex min-h-16 w-full cursor-pointer items-center rounded-card-sm bg-white px-5 text-left text-xl font-semibold shadow-ledge-sm outline-none focus-visible:outline-6 focus-visible:outline-yellow";

/**
 * The avatar at the top right of the Remote, and the Me sheet it opens
 * (v1 spec #49, "Me sheet"): who this Phone is, "My Difficulty for the next
 * Song", "Someone else is using this phone", "Change name, look or colour",
 * Leave party and a small "Admin" link.
 */
export function MeButton({
  store,
  member,
  look,
  me,
}: {
  store: LiveStore;
  member: PartyMember;
  look: MemberLook;
  me: MeActions;
}) {
  const [open, setOpen] = useState(false);
  const party = useLive(selectParty, store);
  const profiles = useQuery(profilesQuery);
  const difficulty = myDifficulty(
    member,
    profiles.data,
    party?.lineUp?.seats ?? null,
  );
  const colour = colourName(member.colour);

  return (
    <>
      <button
        type="button"
        aria-label={t("me.open", { name: look.name })}
        className="cursor-pointer rounded-full outline-none focus-visible:outline-6 focus-visible:outline-yellow"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Avatar
          name={look.name}
          avatar={look.avatar}
          colour={member.colour}
          size={44}
        />
      </button>
      <Sheet label={t("me.sheet")} isOpen={open} onOpenChange={setOpen}>
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <Avatar
              name={look.name}
              avatar={look.avatar}
              colour={member.colour}
              size={64}
            />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-3xl font-bold">{look.name}</span>
              <span className="text-lg text-ink-2">
                {member.identity.kind === "guest"
                  ? t("me.guest", { colour })
                  : t("me.profile", { colour })}
              </span>
            </div>
          </div>
          <RadioGroup
            value={difficulty}
            onChange={(key) => {
              if (isDifficulty(key)) setMyDifficulty(store, key);
            }}
            className="flex flex-col gap-2"
          >
            <Label className="text-lg font-semibold">
              {t("me.difficulty")}
            </Label>
            <div className="grid grid-cols-3 gap-2">
              {DIFFICULTIES.map((d) => (
                <RadioField key={d} value={d}>
                  <RadioButton className="flex min-h-14 cursor-pointer items-center justify-center rounded-card-sm bg-white text-xl font-semibold shadow-ledge-sm outline-none data-focus-visible:outline-6 data-focus-visible:outline-yellow data-selected:bg-ink data-selected:text-white">
                    {difficultyName(d)}
                  </RadioButton>
                </RadioField>
              ))}
            </div>
          </RadioGroup>
          <div className="flex flex-col gap-2.5">
            <h3 className="text-lg font-semibold">{t("me.thisPhone")}</h3>
            <button
              type="button"
              className={OPTION}
              onClick={() => {
                setOpen(false);
                me.onSomeoneElse();
              }}
            >
              {t("me.someoneElse")}
            </button>
            <button
              type="button"
              className={OPTION}
              onClick={() => {
                setOpen(false);
                me.onChangeLook(look);
              }}
            >
              {t("me.changeLook")}
            </button>
            <LeaveParty store={store} member={member} />
          </div>
          {showsAdminLink(me.phoneId, playingSeats(party)) ? (
            <a
              href="/admin"
              className="self-center rounded-full px-4 py-2 text-base font-semibold text-ink-2 underline outline-none focus-visible:outline-6 focus-visible:outline-yellow"
            >
              {t("me.admin")}
            </a>
          ) : null}
        </div>
      </Sheet>
    </>
  );
}
