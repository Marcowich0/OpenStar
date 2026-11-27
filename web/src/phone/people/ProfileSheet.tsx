import { useState } from "react";

import type { ProfileId } from "../../generated/ProfileId";
import { t } from "../../i18n/t";
import { ProfilePage } from "../../profile/ProfilePage";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";

/** The Profile a Phone's Profile page shows, and its name for the label. */
export interface ShownProfile {
  id: ProfileId;
  name: string;
}

/**
 * A Profile page on the Phone (spec #244): a full-screen sheet, from the Me
 * sheet's "My stats" and from a Profile on the People tab. `null` closes it.
 */
export function ProfileSheet({
  shown,
  onClose,
}: {
  shown: ShownProfile | null;
  onClose: () => void;
}) {
  // The last Profile shown, so the page stays while the sheet slides out.
  const [last, setLast] = useState(shown);
  if (shown !== null && shown !== last) setLast(shown);
  const profile = shown ?? last;

  return (
    <Sheet
      label={t("profilePage.sheet", { name: profile?.name ?? "" })}
      isOpen={shown !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
      fullScreen
    >
      <div className="flex flex-col gap-4">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex min-h-12 cursor-pointer items-center gap-1.5 self-start rounded-full bg-white pr-5 pl-3 text-lg font-semibold shadow-ledge-sm outline-none focus-visible:outline-6 focus-visible:outline-yellow"
        >
          <Icon name="chevron" className="size-5 rotate-180" />
          {t("profilePage.back")}
        </button>
        {profile ? <ProfilePage profileId={profile.id} /> : null}
      </div>
    </Sheet>
  );
}
