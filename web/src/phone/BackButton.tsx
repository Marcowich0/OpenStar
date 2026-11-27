import { Button } from "react-aria-components";

import { t } from "../i18n/t";

/**
 * Back in a Phone's top bar: a white pill as tall as the bar's other
 * buttons (the 44 px Me avatar), not a full-size Bubble Pop button.
 */
export function BackButton({ onPress }: { onPress: () => void }) {
  return (
    <Button
      onPress={onPress}
      className="inline-flex h-11 shrink-0 cursor-pointer items-center justify-center rounded-full bg-surface px-5 text-xl font-semibold text-ink shadow-ledge-sm outline-none transition-transform duration-200 data-focus-visible:outline-6 data-focus-visible:outline-yellow data-pressed:scale-95"
    >
      {t("join.back")}
    </Button>
  );
}
