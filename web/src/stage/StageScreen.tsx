import { t } from "../i18n/t";
import { ServerStatus } from "../phone/ServerStatus";
import { BubblePopSamples } from "./BubblePopSamples";

/** `/stage`: the Stage. A placeholder for now. */
export function StageScreen() {
  return (
    <main className="flex flex-col items-center gap-8 p-10">
      <h1 className="text-6xl font-bold">{t("stage.title")}</h1>
      <BubblePopSamples />
      <ServerStatus />
    </main>
  );
}
