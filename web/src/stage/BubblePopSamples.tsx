// A few base components on the Stage, so `/stage` shows the Bubble Pop look
// before the Stage's own screens exist (#109). The Stage screens replace it.

import { t } from "../i18n/t";
import { PALETTE_KEYS } from "../theme/tokens";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Chip } from "../ui/Chip";
import { Score } from "../ui/Score";
import { Swatch } from "../ui/Swatch";

export function BubblePopSamples() {
  return (
    <Card popIn className="flex max-w-5xl flex-col items-center gap-8 p-10">
      <div className="flex flex-wrap items-center justify-center gap-4">
        <Chip tone="duet">{t("chip.duet")}</Chip>
        <Chip>{t("stage.title")}</Chip>
        <Chip tone="best">
          <Score value={9480} />
        </Chip>
      </div>
      <div className="flex flex-wrap justify-center gap-3">
        {PALETTE_KEYS.map((key) => (
          <Swatch key={key} colour={key} />
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-6">
        <Button fill="white">{t("stage.back")}</Button>
        <Button fill="red">{t("stage.end")}</Button>
        <Button fill="ink">{t("stage.takeBack")}</Button>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-6">
        <Button fill="green" size="big" breathing>
          {t("stage.sing")}
        </Button>
        <Button fill="green" size="big" isDisabled>
          {t("stage.start")}
        </Button>
      </div>
    </Card>
  );
}
