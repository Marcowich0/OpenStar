// Placeholder for the scene a later ticket builds: the results (#182). It
// replaces its entry in `frame/sceneComponents.tsx`.

import { t } from "../../i18n/t";

const HEADING = "text-8xl font-bold";
const CENTRED = "flex h-full items-center justify-center";

export function ResultsScene() {
  return (
    <section className={CENTRED}>
      <h1 className={HEADING}>{t("stage.results.title")}</h1>
    </section>
  );
}
