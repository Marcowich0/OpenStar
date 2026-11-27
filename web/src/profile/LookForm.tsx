import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
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
import type { MemberEdit } from "../generated/MemberEdit";
import type { PartyMember } from "../generated/PartyMember";
import type { Profile } from "../generated/Profile";
import type { ProfileEdit } from "../generated/ProfileEdit";
import type { UserMessage } from "../generated/UserMessage";
import { userMessageText } from "../i18n/serverText";
import { t } from "../i18n/t";
import type { LiveState } from "../live/liveState";
import type { LiveStore } from "../live/liveStore";
import { useLive } from "../live/useLive";
import { ColourPicker } from "../phone/ColourPicker";
import {
  NAME_MAX_LENGTH,
  colourChoices,
  formNameCheck,
  randomAvatar,
  type ColourChoice,
} from "../phone/joinForm";
import type { MemberLook } from "../phone/memberLook";
import { PALETTE_KEYS, type PaletteKey } from "../theme/tokens";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";

const NO_MEMBERS: readonly PartyMember[] = [];
const selectMembers = (state: LiveState) =>
  state.stage?.party?.members ?? NO_MEMBERS;

/** A favourite colour is no Party colour: none of the twelve is held. */
const FAVOURITE_CHOICES: readonly ColourChoice[] = PALETTE_KEYS.map(
  (colour) => ({ colour, held: false }),
);

export type JoinFormKind = "guest" | "newProfile";

export type LookFormProps = {
  store: LiveStore;
  /** The form's heading, also its accessible name. */
  title: string;
  /** The heading's level: a page's own form is `1`, a section's `3`. */
  level?: 1 | 3;
  /** The picture's random source (tests pass a fixed one). */
  random?: () => number;
} & (
  | {
      kind: JoinFormKind;
      /** Joins; resolves to a problem to show, or `null` when it is handled. */
      onJoin: (joinAs: JoinAs) => Promise<UserMessage | null>;
    }
  | {
      /** The Me sheet's "Change name, look or colour": the form filled in. */
      kind: "edit";
      member: PartyMember;
      look: MemberLook;
      /** Saves; resolves to a problem to show, or `null` when it is handled. */
      onSave: (edit: MemberEdit) => Promise<UserMessage | null>;
    }
  | {
      /**
       * Admin › Profiles' Edit: a Profile outside the Party, filled in with
       * its own; the colour is its favourite, any of the twelve.
       */
      kind: "profile";
      profile: Profile;
      /** Saves; resolves to a problem to show, or `null` when it is handled. */
      onSave: (edit: ProfileEdit) => Promise<UserMessage | null>;
    }
);

/**
 * The one short form behind "New Profile" and "I'm a Guest": a name, a
 * colour from the twelve with tonight's held ones crossed out, and a
 * picture. A Guest lasts for the Party; a new Profile is kept, its colour
 * becoming its favourite. The Me sheet's "Change name, look or colour" is
 * the same form, filled in with the member's own, whose colour stays
 * offered; so is Admin › Profiles' Edit, whose favourite colour may be any.
 */
export function LookForm(props: LookFormProps) {
  const { kind, store, title, level = 1, random } = props;
  const editing = kind === "edit" || kind === "profile";
  const self =
    props.kind === "edit"
      ? props.member
      : props.kind === "profile"
        ? props.profile
        : undefined;
  const headingId = useId();
  const profiles = useQuery(profilesQuery);
  const members = useLive(selectMembers, store);
  const [name, setName] = useState(() =>
    props.kind === "edit"
      ? props.look.name
      : props.kind === "profile"
        ? props.profile.name
        : "",
  );
  const [picked, setPicked] = useState<PaletteKey | null>(null);
  const [avatar, setAvatar] = useState<AvatarValue>(() =>
    props.kind === "edit"
      ? props.look.avatar
      : props.kind === "profile"
        ? props.profile.avatar
        : randomAvatar(random),
  );
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<UserMessage | null>(null);

  const { choices, preselected } =
    props.kind === "profile"
      ? {
          choices: FAVOURITE_CHOICES,
          preselected: props.profile.favouriteColour,
        }
      : colourChoices(
          members,
          props.kind === "edit" ? props.member : undefined,
        );
  // A picked colour someone took meanwhile falls back to the first free one.
  const colour =
    picked !== null && choices.some((c) => c.colour === picked && !c.held)
      ? picked
      : preselected;
  const check = formNameCheck(name, profiles.data ?? [], members, self);
  const trimmed = name.trim();
  const canSend = check.kind === "free" && colour !== null && !pending;

  function settle(answer: Promise<UserMessage | null>) {
    if (pending) return;
    setPending(true);
    setProblem(null);
    void answer.then((result) => {
      setPending(false);
      setProblem(result);
    });
  }

  function join(joinAs: JoinAs) {
    if (props.kind === "guest" || props.kind === "newProfile")
      settle(props.onJoin(joinAs));
  }

  function send() {
    if (!canSend) return;
    if (props.kind === "edit") {
      settle(props.onSave({ name: trimmed, avatar, colour }));
      return;
    }
    if (props.kind === "profile") {
      settle(props.onSave({ name: trimmed, avatar, favouriteColour: colour }));
      return;
    }
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

  const Heading = level === 1 ? "h1" : "h3";

  return (
    <form
      aria-labelledby={headingId}
      className={
        level === 1 ? "flex flex-col gap-5 px-5 pb-8" : "flex flex-col gap-5"
      }
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <Heading
        id={headingId}
        className={
          level === 1
            ? "text-4xl leading-tight font-bold"
            : "text-2xl leading-tight font-bold text-ink"
        }
      >
        {title}
      </Heading>
      <TextField
        value={name}
        onChange={setName}
        maxLength={NAME_MAX_LENGTH}
        autoComplete="off"
        className="flex flex-col gap-2"
      >
        <Label className="text-lg font-semibold">{t("joinForm.name")}</Label>
        <Input
          // "Your name for tonight" is the Phone's; a kept Profile has none.
          {...(kind === "profile"
            ? {}
            : { placeholder: t("joinForm.namePlaceholder") })}
          className="min-h-16 rounded-card-sm bg-surface px-5 text-2xl font-semibold shadow-ledge-sm outline-none focus-visible:outline-6 focus-visible:outline-yellow"
        />
      </TextField>
      {check.kind === "profile" && editing ? (
        <p role="alert" className="text-lg font-semibold text-warn-fg">
          {t("userMessage.profileNameTaken")}
        </p>
      ) : null}
      {check.kind === "profile" && !editing ? (
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
      {kind === "profile" ? (
        <ColourPicker
          label={t("joinForm.favouriteColour")}
          choices={choices}
          value={colour}
          onChange={setPicked}
        />
      ) : (
        <ColourPicker
          label={t("joinForm.colour")}
          hint={t("joinForm.colourHint")}
          choices={choices}
          value={colour}
          onChange={setPicked}
        />
      )}
      <RadioGroup
        value={avatar.key}
        onChange={(key) => {
          const found = AVATAR_KEYS.find((k) => k === key);
          if (found) setAvatar({ kind: "builtIn", key: found });
        }}
        className="flex flex-col gap-2"
      >
        <Label className="text-lg font-semibold">{t("joinForm.picture")}</Label>
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
        {editing
          ? t("me.save")
          : trimmed === ""
            ? t("joinForm.join")
            : t("joinForm.joinAs", { name: trimmed })}
      </Button>
    </form>
  );
}
