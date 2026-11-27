import type { JoinAs } from "../generated/JoinAs";
import type { MemberEdit } from "../generated/MemberEdit";
import type { PartyMember } from "../generated/PartyMember";
import type { UserMessage } from "../generated/UserMessage";
import { t } from "../i18n/t";
import type { LiveStore } from "../live/liveStore";
import { Button } from "../ui/Button";
import { TopBar } from "./Logo";
import { LookForm, type JoinFormKind } from "./LookForm";
import type { MemberLook } from "./memberLook";

export type { JoinFormKind } from "./LookForm";

export type JoinFormProps = {
  store: LiveStore;
  onBack: () => void;
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
);

/**
 * The Phone's page for "New Profile", "I'm a Guest" and the Me sheet's
 * "Change name, look or colour": Back, and the shared form (`LookForm`).
 */
export function JoinForm({ onBack, ...props }: JoinFormProps) {
  const title = t(
    props.kind === "edit"
      ? "me.changeLook"
      : props.kind === "guest"
        ? "joinForm.newGuest"
        : "join.newProfile",
  );
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
      <LookForm title={title} {...props} />
    </main>
  );
}
