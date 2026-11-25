import { t } from "../i18n/t";
import { ServerStatus } from "../phone/ServerStatus";

/** `/stage`: the Stage. A placeholder for now. */
export function StageScreen() {
  return (
    <main>
      <h1>{t("stage.title")}</h1>
      <ServerStatus />
    </main>
  );
}
