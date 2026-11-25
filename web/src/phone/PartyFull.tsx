import { t } from "../i18n/t";
import { Button } from "../ui/Button";
import { TopBar } from "./Logo";

export interface PartyFullProps {
  onTryAgain: () => void;
  /** A retry is on its way. */
  pending: boolean;
}

/**
 * "The Party is full": all 12 colours are held, so a join that would add a
 * Party member is refused until someone leaves or is removed.
 */
export function PartyFull({ onTryAgain, pending }: PartyFullProps) {
  return (
    <main className="flex min-h-dvh flex-col">
      <TopBar />
      <div className="flex grow flex-col items-center justify-center gap-4 px-5 pb-8 text-center">
        <h1 className="text-4xl leading-tight font-bold">
          {t("join.partyFull")}
        </h1>
        <p className="text-lg text-ink-2">{t("join.partyFullWhy")}</p>
        <Button
          fill="ink"
          className="mt-4 w-full"
          isDisabled={pending}
          onPress={onTryAgain}
        >
          {t("join.tryAgain")}
        </Button>
      </div>
    </main>
  );
}
