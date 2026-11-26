import { useQueryClient } from "@tanstack/react-query";
import { Button as AriaButton } from "react-aria-components";

import { api } from "../api/api";
import { setUnlocked, useUnlocked } from "../guarded/unlock";
import { t } from "../i18n/t";
import { Icon } from "../ui/Icon";

/**
 * Lock (v1 spec #45): shown while this browser holds an Unlock, and ends it
 * at once. Lock needs no Unlock itself.
 */
export function LockButton() {
  const queryClient = useQueryClient();
  const unlocked = useUnlocked();
  if (!unlocked) return null;
  return (
    <AriaButton
      onPress={() => {
        api("POST /api/lock").then(
          (status) => {
            setUnlocked(queryClient, status.unlocked);
          },
          () => {
            // Not locked: the button stays, so it can be pressed again.
          },
        );
      }}
      className="inline-flex min-h-12 shrink-0 cursor-pointer items-center gap-2 rounded-full bg-ink px-5 text-xl font-semibold text-white shadow-ledge-ink outline-none transition-transform duration-200 data-focus-visible:outline-6 data-focus-visible:outline-yellow data-pressed:scale-95"
    >
      <Icon name="lock" className="size-5" />
      {t("admin.lock")}
    </AriaButton>
  );
}
