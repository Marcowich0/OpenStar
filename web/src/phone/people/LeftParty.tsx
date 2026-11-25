import { t } from "../../i18n/t";
import { Button } from "../../ui/Button";
import { TopBar } from "../Logo";

/**
 * "You left the Party": this Phone's member left or was removed, or a new
 * Party replaced this one. "Join again" leads to the Join code pad.
 */
export function LeftParty({ onJoinAgain }: { onJoinAgain: () => void }) {
  return (
    <main className="flex min-h-dvh flex-col">
      <TopBar />
      <div className="flex grow flex-col items-center justify-center gap-4 px-5 pb-8 text-center">
        <h1 className="text-4xl leading-tight font-bold">
          {t("leftParty.title")}
        </h1>
        <p className="text-lg text-ink-2">{t("leftParty.why")}</p>
        <Button fill="ink" className="mt-4 w-full" onPress={onJoinAgain}>
          {t("leftParty.joinAgain")}
        </Button>
      </div>
    </main>
  );
}
