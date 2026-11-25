import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  Input,
  Label,
  RadioButton,
  RadioField,
  RadioGroup,
  TextField,
} from "react-aria-components";

import { profilesQuery } from "../api/queries";
import { AVATAR_KEYS } from "../avatars/avatarIcons";
import type { Avatar as AvatarValue } from "../generated/Avatar";
import type { JoinAs } from "../generated/JoinAs";
import type { PartyMember } from "../generated/PartyMember";
import type { UserMessage } from "../generated/UserMessage";
import { userMessageText } from "../i18n/serverText";
import { t } from "../i18n/t";
import type { LiveState } from "../live/liveState";
import type { LiveStore } from "../live/liveStore";
import { useLive } from "../live/useLive";
import type { PaletteKey } from "../theme/tokens";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { ColourPicker } from "./ColourPicker";
import {
  NAME_MAX_LENGTH,
  colourChoices,
  formNameCheck,
  randomAvatar,
} from "./joinForm";
import { TopBar } from "./Logo";

const NO_MEMBERS: readonly PartyMember[] = [];
const selectMembers = (state: LiveState) =>
  state.stage?.party?.members ?? NO_MEMBERS;

export type JoinFormKind = "guest" | "newProfile";

export interface JoinFormProps {
  kind: JoinFormKind;
  store: LiveStore;
  /** Joins; resolves to a problem to show, or `null` when it is handled. */
  onJoin: (joinAs: JoinAs) => Promise<UserMessage | null>;
  onBack: () => void;
  /** The picture's random source (tests pass a fixed one). */
  random?: () => number;
}

/**
 * The one short form behind "New Profile" and "I'm a Guest": a name, a
 * colour from the twelve with tonight's held ones crossed out, and a
 * picture. A Guest lasts for the Party; a new Profile is kept, its colour
 * becoming its favourite.
 */
export function JoinForm({
  kind,
  store,
  onJoin,
  onBack,
  random,
}: JoinFormProps) {
  const profiles = useQuery(profilesQuery);
  const members = useLive(selectMembers, store);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<PaletteKey | null>(null);
  const [avatar, setAvatar] = useState<AvatarValue>(() => randomAvatar(random));
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<UserMessage | null>(null);

  const { choices, preselected } = colourChoices(members);
  // A picked colour someone took meanwhile falls back to the first free one.
  const colour =
    picked !== null && choices.some((c) => c.colour === picked && !c.held)
      ? picked
      : preselected;
  const check = formNameCheck(name, profiles.data ?? [], members);
  const trimmed = name.trim();
  const canSend = check.kind === "free" && colour !== null && !pending;

  function join(joinAs: JoinAs) {
    if (pending) return;
    setPending(true);
    setProblem(null);
    void onJoin(joinAs).then((result) => {
      setPending(false);
      setProblem(result);
    });
  }

  function send() {
    if (!canSend) return;
    join(
      kind === "guest"
        ? { kind: "guest", name: trimmed, colour, avatar }
        : {
            kind: "newProfile",
            name: trimmed,
            avatar,
            favouriteColour: colour,
          },
    );
  }

  return (
    <main className="flex min-h-dvh flex-col">
      <TopBar>
        <Button
          size="medium"
          className="min-h-12 px-5 text-xl"
          onPress={onBack}
        >
          {t("join.back")}
        </Button>
      </TopBar>
      <form
        className="flex flex-col gap-5 px-5 pb-8"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <h1 className="text-4xl leading-tight font-bold">
          {t(kind === "guest" ? "joinForm.newGuest" : "join.newProfile")}
        </h1>
        <TextField
          value={name}
          onChange={setName}
          maxLength={NAME_MAX_LENGTH}
          autoComplete="off"
          className="flex flex-col gap-2"
        >
          <Label className="text-lg font-semibold">{t("joinForm.name")}</Label>
          <Input
            placeholder={t("joinForm.namePlaceholder")}
            className="min-h-16 rounded-card-sm bg-white px-5 text-2xl font-semibold shadow-ledge-sm outline-none focus-visible:outline-6 focus-visible:outline-yellow"
          />
        </TextField>
        {check.kind === "profile" ? (
          <Card radius="small" className="flex items-center gap-3 p-4">
            <span aria-hidden="true">
              <Avatar
                name={check.profile.name}
                avatar={check.profile.avatar}
                colour={check.profile.favouriteColour}
                size={48}
              />
            </span>
            <span className="grow">
              <span className="block text-xl font-bold">
                {t("joinForm.areYou", { name: check.profile.name })}
              </span>
              <span className="text-ink-2">{t("joinForm.profileName")}</span>
            </span>
            <Button
              fill="green"
              className="min-h-14 px-6 text-2xl"
              onPress={() => {
                join({ kind: "profile", profileId: check.profile.id });
              }}
            >
              {t("joinForm.yes")}
            </Button>
          </Card>
        ) : null}
        {check.kind === "takenTonight" ? (
          <p role="alert" className="text-lg font-semibold text-warn-fg">
            {t("joinForm.nameTakenTonight")}
          </p>
        ) : null}
        <ColourPicker
          label={t("joinForm.colour")}
          hint={t("joinForm.colourHint")}
          choices={choices}
          value={colour}
          onChange={setPicked}
        />
        <RadioGroup
          value={avatar.key}
          onChange={(key) => {
            const found = AVATAR_KEYS.find((k) => k === key);
            if (found) setAvatar({ kind: "builtIn", key: found });
          }}
          className="flex flex-col gap-2"
        >
          <Label className="text-lg font-semibold">
            {t("joinForm.picture")}
          </Label>
          <div className="grid grid-cols-4 gap-2">
            {AVATAR_KEYS.map((key, index) => (
              <RadioField
                key={key}
                value={key}
                aria-label={t("joinForm.pictureNumber", { number: index + 1 })}
              >
                <RadioButton className="flex cursor-pointer justify-center rounded-full p-1 outline-none data-focus-visible:outline-6 data-focus-visible:outline-yellow data-selected:outline-4 data-selected:outline-ink">
                  <span aria-hidden="true">
                    <Avatar
                      name={trimmed}
                      avatar={{ kind: "builtIn", key }}
                      colour={colour ?? "cherry"}
                      size={60}
                    />
                  </span>
                </RadioButton>
              </RadioField>
            ))}
          </div>
        </RadioGroup>
        {problem ? (
          <p
            role="alert"
            className="text-center text-lg font-semibold text-warn-fg"
          >
            {userMessageText(problem)}
          </p>
        ) : null}
        <Button
          fill="green"
          className="w-full"
          isDisabled={!canSend}
          onPress={send}
        >
          {trimmed === ""
            ? t("joinForm.join")
            : t("joinForm.joinAs", { name: trimmed })}
        </Button>
      </form>
    </main>
  );
}
