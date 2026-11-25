import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import { profilesQuery } from "../../api/queries";
import type { PartyMember } from "../../generated/PartyMember";
import { colourName } from "../../i18n/colourNames";
import { userMessageText } from "../../i18n/serverText";
import { t } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { useLive } from "../../live/useLive";
import { Avatar } from "../../ui/Avatar";
import { HoldButton } from "../../ui/HoldButton";
import { Icon } from "../../ui/Icon";
import { phoneMember } from "../phonePage";
import { LeaveParty } from "./LeaveParty";
import { removeMember, type Refusal } from "./memberRequests";
import { peopleRows, type PeopleRow } from "./people";

const NO_MEMBERS: readonly PartyMember[] = [];
const selectMembers = (state: LiveState) =>
  state.stage?.party?.members ?? NO_MEMBERS;
const selectJoinCode = (state: LiveState) =>
  state.stage?.party?.joinCode ?? null;

/** A small round tag on a row: "me", "guest", "singing". */
function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-ink px-2.5 text-sm font-semibold text-white">
      {children}
    </span>
  );
}

function PersonRow({
  row,
  onRemove,
}: {
  row: PeopleRow;
  onRemove: () => void;
}) {
  const nameId = useId();
  const { member, look } = row;
  const name = look?.name ?? "";
  const status = t(member.onPhone ? "people.onPhone" : "people.localMicOnly");
  return (
    <li
      aria-labelledby={nameId}
      className="flex min-h-18 items-center gap-3 rounded-card-sm bg-white px-3 py-2 shadow-ledge-sm"
    >
      {look ? (
        <Avatar
          name={look.name}
          avatar={look.avatar}
          colour={member.colour}
          size={44}
        />
      ) : (
        <span className="size-11" />
      )}
      <span className="flex min-w-0 grow flex-col">
        <span className="flex flex-wrap items-center gap-1.5 text-xl font-semibold">
          <span id={nameId} className="truncate">
            {name}
          </span>
          {row.isMe ? <Tag>{t("people.me")}</Tag> : null}
          {row.guest ? <Tag>{t("people.guest")}</Tag> : null}
        </span>
        <span className="text-ink-2">
          {row.favouriteTaken === null
            ? status
            : t("people.favouriteTaken", {
                status,
                colour: colourName(row.favouriteTaken),
              })}
        </span>
      </span>
      {row.remove === "singing" ? (
        <span className="rounded-full bg-yellow px-3 py-1 font-semibold">
          {t("people.singing")}
        </span>
      ) : null}
      {row.remove === "hold" ? (
        <HoldButton
          size="small"
          aria-label={t("people.remove", { name })}
          onHold={onRemove}
        >
          <Icon name="close" className="size-6" />
        </HoldButton>
      ) : null}
    </li>
  );
}

/**
 * The People tab (v1 spec #49, "People tab"): who is here, with their
 * colour, whether they are on a Phone and who's singing. Holding the × on a
 * row removes that member and frees their colour; Leave party is at the
 * bottom. New party and deleting a Profile are not on the Phone.
 */
export function PeopleTab({ store }: { store: LiveStore }) {
  const members = useLive(selectMembers, store);
  const me = useLive(phoneMember, store);
  const joinCode = useLive(selectJoinCode, store);
  const profiles = useQuery(profilesQuery);
  const [problem, setProblem] = useState<Refusal>(null);
  const rows = peopleRows(members, me?.memberId ?? null, profiles.data);

  return (
    <section className="flex flex-col gap-3 pt-2 pb-6">
      <div className="flex items-baseline gap-3">
        <h2 className="text-3xl font-bold">{t("people.title")}</h2>
        <span className="text-lg text-ink-2">
          {t("people.count", { count: members.length })}
        </span>
      </div>
      <p className="text-ink-2">
        {t("people.removingFrees", { code: joinCode ?? "" })}
      </p>
      <ul aria-label={t("people.list")} className="flex flex-col gap-2.5">
        {rows.map((row) => (
          <PersonRow
            key={row.member.memberId}
            row={row}
            onRemove={() => {
              setProblem(null);
              void removeMember(store, row.member.memberId).then(setProblem);
            }}
          />
        ))}
      </ul>
      {problem ? (
        <p
          role="alert"
          className="text-center text-lg font-semibold text-warn-fg"
        >
          {userMessageText(problem)}
        </p>
      ) : null}
      {me ? <LeaveParty store={store} member={me} className="mt-3" /> : null}
    </section>
  );
}
