// The Who list's small form behind + Guest and + Profile (v1 spec #55,
// "Line-up screen"): the host types a name on the Stage computer's keyboard,
// then steps a row of the free Party colours (the first free one
// preselected) and a row of the 24 avatar icons (one prefilled at random)
// with ← and →, leaving each row with ↑ and ↓, and OK seats the new Guest
// or Profile, entering them into the Party. The name rules are the Phone
// form's (`phone/joinForm.ts`); the server's refusals show in the form.

import { useEffect, useRef, useState, type ReactNode } from "react";

import { AVATAR_KEYS } from "../../../avatars/avatarIcons";
import type { Avatar as AvatarValue } from "../../../generated/Avatar";
import type { AvatarKey } from "../../../generated/AvatarKey";
import type { PartyMember } from "../../../generated/PartyMember";
import type { Profile } from "../../../generated/Profile";
import type { SeatWho } from "../../../generated/SeatWho";
import type { UserMessage } from "../../../generated/UserMessage";
import { colourName } from "../../../i18n/colourNames";
import { userMessageText } from "../../../i18n/serverText";
import { t } from "../../../i18n/t";
import {
  NAME_MAX_LENGTH,
  colourChoices,
  formNameCheck,
  randomAvatar,
} from "../../../phone/joinForm";
import type { PaletteKey } from "../../../theme/tokens";
import { tokenVar } from "../../../theme/tokens";
import { Avatar } from "../../../ui/Avatar";
import { Button } from "../../../ui/Button";
import { FOCUSABLE } from "../../frame/focusables";
import { useStageKeys } from "../../frame/stageFrameContext";

export type NewPlayerKind = "guest" | "newProfile";

export interface NewPlayerFormProps {
  kind: NewPlayerKind;
  members: readonly PartyMember[];
  profiles: readonly Profile[];
  /** Seats them; resolves to a refusal to show, or `null` when it is handled. */
  onSeat: (who: SeatWho) => Promise<UserMessage | null>;
  /** The avatar's random source (tests pass a fixed one). */
  random?: () => number;
}

/** Steps `items` from `current` by `step`, stopping at either end. */
function stepped<T>(
  items: readonly T[],
  current: T | null,
  step: number,
): T | null {
  if (items.length === 0) return null;
  const at = current === null ? -1 : items.indexOf(current);
  const next = Math.min(items.length - 1, Math.max(0, at + step));
  return items[next] ?? null;
}

const ROW = "gap-2.5 rounded-card-sm bg-cream p-3 outline-none";
const ITEM =
  "flex cursor-pointer items-center justify-center rounded-full ring-ink";

export function NewPlayerForm({
  kind,
  members,
  profiles,
  onSeat,
  random,
}: NewPlayerFormProps) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<PaletteKey | null>(null);
  const [avatar, setAvatar] = useState<AvatarValue>(() => randomAvatar(random));
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<UserMessage | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const areYouRef = useRef<HTMLSpanElement>(null);
  const coloursRef = useRef<HTMLDivElement>(null);
  const avatarsRef = useRef<HTMLDivElement>(null);
  const okRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    nameRef.current?.focus({ preventScroll: true });
  }, []);

  const { choices, preselected } = colourChoices(members);
  const free = choices.filter((c) => !c.held).map((c) => c.colour);
  // A picked colour someone took meanwhile falls back to the first free one.
  const colour =
    picked !== null && free.includes(picked) ? picked : preselected;
  const trimmed = name.trim();
  // Counted in code points, as the server counts them.
  const tooLong = Array.from(trimmed).length > NAME_MAX_LENGTH;
  const check = formNameCheck(name, profiles, members);
  const canSend =
    check.kind === "free" && !tooLong && colour !== null && !pending;
  const avatarKey = avatar.key;

  // A problem the form sees itself, before asking the server.
  const shown: UserMessage | null =
    problem ??
    (colour === null
      ? { code: "partyFull" }
      : tooLong
        ? { code: "profileNameTooLong", params: { maxLength: NAME_MAX_LENGTH } }
        : null);

  function settle(who: SeatWho) {
    if (pending) return;
    setPending(true);
    setProblem(null);
    void onSeat(who).then((result) => {
      setPending(false);
      setProblem(result);
    });
  }

  function send() {
    if (!canSend) return;
    settle(
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

  // The form's parts top to bottom, for ↑ and ↓.
  const parts = (): HTMLElement[] =>
    [nameRef, areYouRef, coloursRef, avatarsRef, okRef]
      .map((ref) => ref.current)
      .filter((el) => el !== null);
  const focusable = (el: Element): HTMLElement | null =>
    el.matches(`${FOCUSABLE}, input`)
      ? (el as HTMLElement)
      : el.querySelector<HTMLElement>(FOCUSABLE);
  const leave = (step: number) => {
    const all = parts();
    const active = document.activeElement;
    const at = all.findIndex((p) => active !== null && p.contains(active));
    if (at < 0) return false;
    const target = all[Math.min(all.length - 1, Math.max(0, at + step))];
    if (target) focusable(target)?.focus({ preventScroll: true });
    return true;
  };
  const stepRow = (step: number) => {
    const active = document.activeElement;
    if (active === coloursRef.current) {
      const next = stepped(free, colour, step);
      if (next !== null) setPicked(next);
      return true;
    }
    if (active === avatarsRef.current) {
      const next = stepped(AVATAR_KEYS, avatarKey, step);
      if (next !== null) setAvatar({ kind: "builtIn", key: next });
      return true;
    }
    // In the name box the caret moves; elsewhere the frame moves the focus.
    return false;
  };

  useStageKeys({
    ArrowDown: () => leave(1),
    ArrowUp: () => leave(-1),
    ArrowLeft: () => stepRow(-1),
    ArrowRight: () => stepRow(1),
    Enter: () => {
      if (document.activeElement !== nameRef.current) return false;
      send();
      return true;
    },
  });

  return (
    <div
      className="flex w-[680px] flex-col gap-3 p-3"
      onPointerOver={(event) => {
        // The frame moves the focus to whatever the mouse passes over; while
        // a name is typed, a passing mouse must not take the keys away.
        if (document.activeElement === nameRef.current) event.stopPropagation();
      }}
    >
      <h2 className="px-2 text-3xl font-bold">
        {t(kind === "guest" ? "joinForm.newGuest" : "join.newProfile")}
      </h2>
      <input
        ref={nameRef}
        data-stage-focus
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          setProblem(null);
        }}
        aria-label={t("joinForm.name")}
        placeholder={t("stage.lineUp.namePlaceholder")}
        autoComplete="off"
        spellCheck={false}
        className="min-h-17 rounded-full bg-cream px-7 text-3xl font-semibold outline-none placeholder:text-mute"
      />
      {check.kind === "profile" && (
        <span ref={areYouRef} className="flex items-center gap-4 px-2">
          <span aria-hidden="true">
            <Avatar
              name={check.profile.name}
              avatar={check.profile.avatar}
              colour={check.profile.favouriteColour}
              size={52}
            />
          </span>
          <span className="grow text-2xl font-semibold">
            {t("joinForm.areYou", { name: check.profile.name })}
          </span>
          <Button
            fill="green"
            className="min-h-16 px-8 text-2xl"
            onPress={() => {
              settle({ kind: "profile", profileId: check.profile.id });
            }}
          >
            {t("joinForm.yes")}
          </Button>
        </span>
      )}
      {check.kind === "takenTonight" && (
        <Problem>{t("joinForm.nameTakenTonight")}</Problem>
      )}
      <FormRow label={t("joinForm.colour")}>
        <div
          ref={coloursRef}
          data-stage-focus
          tabIndex={-1}
          role="radiogroup"
          aria-label={t("joinForm.colour")}
          className={`${ROW} flex flex-wrap`}
        >
          {free.map((key) => (
            <span
              key={key}
              role="radio"
              aria-checked={key === colour}
              aria-label={colourName(key)}
              onClick={() => {
                setPicked(key);
              }}
              className={`${ITEM} size-[46px] border-4 border-white shadow-ledge-sm ${key === colour ? "ring-4" : ""}`}
              style={{ backgroundColor: tokenVar(key) }}
            />
          ))}
        </div>
      </FormRow>
      <FormRow label={t("joinForm.picture")}>
        <div
          ref={avatarsRef}
          data-stage-focus
          tabIndex={-1}
          role="radiogroup"
          aria-label={t("joinForm.picture")}
          className={`${ROW} grid grid-cols-12`}
        >
          {AVATAR_KEYS.map((key: AvatarKey, index) => (
            <span
              key={key}
              role="radio"
              aria-checked={key === avatarKey}
              aria-label={t("joinForm.pictureNumber", { number: index + 1 })}
              onClick={() => {
                setAvatar({ kind: "builtIn", key });
              }}
              className={`${ITEM} p-0.5 ${key === avatarKey ? "ring-4" : ""}`}
            >
              <span aria-hidden="true">
                <Avatar
                  name={trimmed}
                  avatar={{ kind: "builtIn", key }}
                  colour={colour ?? "cherry"}
                  size={40}
                />
              </span>
            </span>
          ))}
        </div>
      </FormRow>
      {shown && <Problem>{userMessageText(shown)}</Problem>}
      <span ref={okRef} className="self-end">
        <Button fill="green" isDisabled={!canSend} onPress={send}>
          {t("stage.lineUp.ok")}
        </Button>
      </span>
    </div>
  );
}

function FormRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span
        aria-hidden="true"
        className="px-2 text-xl font-semibold text-ink-2"
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function Problem({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="px-2 text-2xl font-semibold text-warn-fg">
      {children}
    </p>
  );
}
