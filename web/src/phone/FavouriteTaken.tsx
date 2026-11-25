import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { profilesQuery } from "../api/queries";
import type { PartyMember } from "../generated/PartyMember";
import type { UserMessage } from "../generated/UserMessage";
import { colourName } from "../i18n/colourNames";
import { userMessageText } from "../i18n/serverText";
import { t } from "../i18n/t";
import type { LiveState } from "../live/liveState";
import type { LiveStore } from "../live/liveStore";
import { useLive } from "../live/useLive";
import type { PaletteKey } from "../theme/tokens";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { ColourPicker } from "./ColourPicker";
import { colourChoices } from "./joinForm";
import { editMemberColour } from "./joinRequests";
import { TopBar } from "./Logo";
import { memberLook } from "./memberLook";

const NO_MEMBERS: readonly PartyMember[] = [];
const selectMembers = (state: LiveState) =>
  state.stage?.party?.members ?? NO_MEMBERS;

export interface FavouriteTakenProps {
  /** This Phone's member: a Profile that got another colour. */
  member: PartyMember;
  store: LiveStore;
  /** "Let's go": on to the Remote with tonight's colour. */
  onDone: () => void;
}

/**
 * The full screen a Profile sees when its favourite colour was held as it
 * joined: its colour tonight, who holds the usual one, "Let's go", and "Pick
 * another colour" among the free ones (which becomes the favourite too).
 */
export function FavouriteTaken({ member, store, onDone }: FavouriteTakenProps) {
  const profiles = useQuery(profilesQuery);
  const members = useLive(selectMembers, store);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<PaletteKey | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<UserMessage | null>(null);

  const look = memberLook(member, profiles.data);
  const favourite =
    member.identity.kind === "profile"
      ? profiles.data?.find(
          (p) =>
            member.identity.kind === "profile" &&
            p.id === member.identity.profileId,
        )?.favouriteColour
      : undefined;
  if (look === null || favourite === undefined) return null;

  const holder = members.find(
    (m) => m.colour === favourite && m.memberId !== member.memberId,
  );
  const holderName = holder ? memberLook(holder, profiles.data)?.name : null;

  if (picking) {
    const free = colourChoices(members).choices.filter((c) => !c.held);
    const colour =
      picked !== null && free.some((c) => c.colour === picked)
        ? picked
        : (free[0]?.colour ?? null);
    return (
      <main className="flex min-h-dvh flex-col">
        <TopBar>
          <Button
            className="min-h-12 px-5 text-xl"
            onPress={() => {
              setPicking(false);
            }}
          >
            {t("join.back")}
          </Button>
        </TopBar>
        <div className="flex flex-col gap-5 px-5 pb-8">
          <h1 className="text-4xl leading-tight font-bold">
            {t("join.pickAnotherColour")}
          </h1>
          <ColourPicker
            label={t("join.freeColours")}
            choices={free}
            value={colour}
            onChange={setPicked}
          />
          {problem ? (
            <p
              role="alert"
              className="text-center text-lg font-semibold text-warn-fg"
            >
              {userMessageText(problem)}
            </p>
          ) : null}
          {colour !== null ? (
            <Button
              fill="green"
              className="w-full"
              isDisabled={pending}
              onPress={() => {
                setPending(true);
                setProblem(null);
                void editMemberColour(store, member.memberId, colour).then(
                  (result) => {
                    setPending(false);
                    if (result.ok) onDone();
                    else setProblem(result.reason ?? { code: "serverError" });
                  },
                );
              }}
            >
              {t("join.takeColour", { colour: colourName(colour) })}
            </Button>
          ) : null}
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col">
      <TopBar />
      <div className="flex grow flex-col items-center justify-center gap-3 px-5 text-center">
        <Avatar
          name={look.name}
          avatar={look.avatar}
          colour={member.colour}
          size={150}
        />
        <h1 className="text-4xl leading-tight font-bold">
          {t("join.colourTonight", { colour: colourName(member.colour) })}
        </h1>
        <p className="max-w-80 text-lg text-ink-2">
          {holderName
            ? t("join.usualColourHeld", {
                holder: holderName,
                favourite: colourName(favourite),
              })
            : t("join.usualColourTaken", { favourite: colourName(favourite) })}
        </p>
      </div>
      <div className="flex flex-col gap-4 px-5 pb-8">
        <Button fill="green" className="w-full" onPress={onDone}>
          {t("join.letsGo")}
        </Button>
        <Button
          className="w-full"
          onPress={() => {
            setPicking(true);
          }}
        >
          {t("join.pickAnotherColour")}
        </Button>
      </div>
    </main>
  );
}
