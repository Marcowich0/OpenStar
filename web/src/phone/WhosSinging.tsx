import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { profilesQuery } from "../api/queries";
import type { JoinAs } from "../generated/JoinAs";
import type { PartyMember } from "../generated/PartyMember";
import type { Profile } from "../generated/Profile";
import type { UserMessage } from "../generated/UserMessage";
import { userMessageText } from "../i18n/serverText";
import { t } from "../i18n/t";
import type { LiveState } from "../live/liveState";
import type { LiveStore } from "../live/liveStore";
import { rememberedProfileId, type PhoneStorage } from "../live/phoneId";
import { useLive } from "../live/useLive";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { TopBar } from "./Logo";
import { whosSinging } from "./whosSinging";

const NO_MEMBERS: readonly PartyMember[] = [];
const selectMembers = (state: LiveState) =>
  state.stage?.party?.members ?? NO_MEMBERS;

export interface WhosSingingProps {
  store: LiveStore;
  storage: PhoneStorage;
  /** Joins; resolves to a problem to show, or `null` when it is handled. */
  onJoin: (joinAs: JoinAs) => Promise<UserMessage | null>;
  /** Opens the New Profile form. */
  onNewProfile: () => void;
  /** Opens the Guest form. */
  onGuest: () => void;
  /**
   * "Someone else is using this phone": the full grid at once, and a Back
   * to the Remote.
   */
  onBack?: () => void;
}

/**
 * "Who's singing?": the remembered Profile with one big button, or the grid
 * of every Profile, then "New Profile" and "I'm a Guest". Picking a Profile
 * joins the Phone as it.
 */
export function WhosSinging({
  store,
  storage,
  onJoin,
  onNewProfile,
  onGuest,
  onBack,
}: WhosSingingProps) {
  const profiles = useQuery(profilesQuery);
  const members = useLive(selectMembers, store);
  const [rememberedId] = useState(() => rememberedProfileId(storage));
  const [showAll, setShowAll] = useState(onBack !== undefined);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<UserMessage | null>(null);

  function pick(profile: Profile) {
    if (pending) return;
    setPending(true);
    setProblem(null);
    void onJoin({ kind: "profile", profileId: profile.id }).then((result) => {
      setPending(false);
      setProblem(result);
    });
  }

  const problemText = problem ? (
    <p role="alert" className="text-center text-lg font-semibold text-warn-fg">
      {userMessageText(problem)}
    </p>
  ) : null;

  if (!profiles.isSuccess)
    return (
      <main className="flex min-h-dvh flex-col">
        <TopBar />
        <p role="status" className="px-5 pt-10 text-center text-xl text-ink-2">
          {t(profiles.isError ? "join.profilesFailed" : "join.profilesLoading")}
        </p>
      </main>
    );

  const grid = whosSinging(profiles.data, members);
  const remembered = showAll
    ? undefined
    : grid.find((entry) => entry.profile.id === rememberedId);

  if (remembered)
    return (
      <main className="flex min-h-dvh flex-col">
        <TopBar />
        <div className="flex grow flex-col items-center justify-center gap-3 px-5 text-center">
          <Avatar
            name={remembered.profile.name}
            avatar={remembered.profile.avatar}
            colour={remembered.colour}
            size={150}
          />
          <h1 className="text-4xl leading-tight font-bold">
            {t("join.hi", { name: remembered.profile.name })}
          </h1>
          <p className="text-lg text-ink-2">{t("join.remembered")}</p>
        </div>
        <div className="flex flex-col gap-4 px-5 pb-8">
          {problemText}
          <Button
            fill="green"
            breathing
            className="w-full"
            onPress={() => {
              pick(remembered.profile);
            }}
          >
            {t("join.imName", { name: remembered.profile.name })}
          </Button>
          <Button
            className="w-full"
            onPress={() => {
              setShowAll(true);
            }}
          >
            {t("join.someoneElse")}
          </Button>
        </div>
      </main>
    );

  return (
    <main className="flex min-h-dvh flex-col">
      <TopBar>
        {onBack ? (
          <Button
            size="medium"
            className="min-h-12 px-5 text-xl"
            onPress={onBack}
          >
            {t("join.back")}
          </Button>
        ) : null}
      </TopBar>
      <div className="flex flex-col gap-2 px-5 pb-8">
        <h1 className="text-4xl leading-tight font-bold">
          {t("join.whosSinging")}
        </h1>
        <p className="text-lg text-ink-2">{t("join.tapProfile")}</p>
        <ul
          aria-label={t("join.whosSinging")}
          className="mt-4 grid grid-cols-3 gap-x-3 gap-y-5"
        >
          {grid.map(({ profile, here, colour }) => (
            <li key={profile.id}>
              <button
                type="button"
                className="flex w-full cursor-pointer flex-col items-center gap-1.5 rounded-card-sm py-1 text-lg font-semibold outline-none focus-visible:outline-6 focus-visible:outline-yellow"
                onClick={() => {
                  pick(profile);
                }}
              >
                <span aria-hidden="true">
                  <Avatar
                    name={profile.name}
                    avatar={profile.avatar}
                    colour={colour}
                    size={78}
                  />
                </span>
                <span className="w-full truncate text-center">
                  {profile.name}
                </span>
                {here ? (
                  <span className="rounded-full bg-ink-fill px-2.5 text-sm text-white">
                    {t("join.here")}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-6 flex flex-col gap-4">
          {problemText}
          <Button className="w-full" onPress={onNewProfile}>
            {t("join.newProfile")}
          </Button>
          <Button className="w-full" onPress={onGuest}>
            {t("join.guest")}
          </Button>
        </div>
      </div>
    </main>
  );
}
