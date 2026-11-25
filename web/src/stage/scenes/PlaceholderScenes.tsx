// Placeholders for the scenes later tickets build: the sing scene (#164)
// and the results (#182). Each replaces its entry in
// `frame/sceneComponents.tsx`.

import { t } from "../../i18n/t";

const HEADING = "text-8xl font-bold";
const CENTRED = "flex h-full items-center justify-center";

export function SingScene() {
  return (
    <section className={`${CENTRED} bg-ink text-white`}>
      <h1 className={HEADING}>{t("stage.sing.title")}</h1>
    </section>
  );
}

export function ResultsScene() {
  return (
    <section className={CENTRED}>
      <h1 className={HEADING}>{t("stage.results.title")}</h1>
    </section>
  );
}
