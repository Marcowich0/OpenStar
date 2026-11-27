// The small "Join · 4821" chip: what the song browser's join card hides to,
// and what the Line-up and results show in their bottom-left corner (#250),
// where pressing it opens People and its full join card. When Phones can't
// reach a working join address it reads "Join · 4821 · Phones can't sing
// yet"; that wording lives here only (`joinChipText`). The chip is 56
// reference px tall and, with the warning, about 640 px wide: the Line-up and
// results keep their bottom-left corner clear for that.

import { Button as AriaButton } from "react-aria-components";

import { t } from "../../i18n/t";
import type { JoinAddress } from "../../joinAddress";
import { Icon } from "../../ui/Icon";

/** The chip's words, which are also its accessible name. */
export function joinChipText(
  joinCode: string,
  warning: JoinAddress["warning"],
): string {
  return warning === "none"
    ? t("stage.joinCard.chip", { code: joinCode })
    : t("stage.joinCard.chipCantSing", { code: joinCode });
}

export interface JoinChipProps {
  joinCode: string;
  warning: JoinAddress["warning"];
  onPress: () => void;
  /** Placement from the caller, on a wrapper. */
  className?: string;
}

export function JoinChip({
  joinCode,
  warning,
  onPress,
  className = "",
}: JoinChipProps) {
  const text = joinChipText(joinCode, warning);
  return (
    <div className={className}>
      <AriaButton
        aria-label={text}
        onPress={onPress}
        className="pointer-events-auto flex items-center gap-3 rounded-full bg-white px-7 py-3 text-[28px] leading-none font-semibold whitespace-nowrap text-ink shadow-ledge outline-none"
      >
        <span data-testid="party-join-code" className="sr-only">
          {joinCode}
        </span>
        {warning !== "none" && (
          <span
            aria-hidden="true"
            className="flex size-8 items-center justify-center rounded-full bg-red text-white shadow-ledge-red"
          >
            <Icon name="lock" className="size-5" />
          </span>
        )}
        <span aria-hidden="true">{text}</span>
      </AriaButton>
    </div>
  );
}
