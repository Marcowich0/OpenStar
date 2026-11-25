import { useState } from "react";

import type { PartyMember } from "../../generated/PartyMember";
import { userMessageText } from "../../i18n/serverText";
import { t } from "../../i18n/t";
import type { LiveStore } from "../../live/liveStore";
import { Button } from "../../ui/Button";
import { leaveParty, type Refusal } from "./memberRequests";

/**
 * "Leave party", on the People tab and in the Me sheet. While the member
 * sits in the Line-up it is disabled, with a hint to take them off the Song
 * first; once out, the Phone shows "You left the Party".
 */
export function LeaveParty({
  store,
  member,
  className = "",
}: {
  store: LiveStore;
  member: PartyMember;
  className?: string;
}) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Refusal>(null);
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <Button
        className="w-full"
        isDisabled={member.singing || pending}
        onPress={() => {
          setPending(true);
          setProblem(null);
          void leaveParty(store).then((refusal) => {
            setPending(false);
            setProblem(refusal);
          });
        }}
      >
        {t("people.leave")}
      </Button>
      {member.singing ? (
        <p className="text-center text-ink-2">{t("people.leaveSinging")}</p>
      ) : null}
      {problem ? (
        <p
          role="alert"
          className="text-center text-lg font-semibold text-warn-fg"
        >
          {userMessageText(problem)}
        </p>
      ) : null}
    </div>
  );
}
