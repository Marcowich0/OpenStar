// The Timing editor's playback controls (#220), at the top of the side
// panel: Play/Pause, the speeds, clicks and hum, Loop a Line and Check A/V
// sync. Each has its key too (Space or P, 1/2/3, L), handled by the editor.

import {
  Button as AriaButton,
  CheckboxButton,
  CheckboxField,
  Label,
  RadioButton,
  RadioField,
  RadioGroup,
  ToggleButton,
} from "react-aria-components";

import {
  SPEEDS,
  type EditorPlaybackState,
} from "../../editorAudio/editorPlayback";
import { t } from "../../i18n/t";

const BUTTON =
  "rounded-full px-4 py-1.5 text-lg font-semibold shadow-ledge-sm outline-none focus-visible:outline-6 focus-visible:outline-yellow disabled:opacity-40";
const CHOICE =
  "cursor-pointer rounded-full bg-white px-3 py-1 text-base font-semibold text-ink ring-2 ring-ledge outline-none data-focus-visible:outline-6 data-focus-visible:outline-yellow data-selected:bg-ink data-selected:text-white data-selected:ring-ink";
const CHECK =
  "group flex cursor-pointer items-center gap-2 text-lg outline-none data-focus-visible:outline-6 data-focus-visible:outline-yellow";
const BOX =
  "flex size-6 items-center justify-center rounded-md bg-white ring-2 ring-ink group-data-selected:bg-green";

export interface PlaybackPanelProps {
  /** The media element is there to play. */
  ready: boolean;
  state: EditorPlaybackState;
  clicks: boolean;
  hum: boolean;
  onTogglePlay: () => void;
  onSpeed: (rate: number) => void;
  onClicks: (on: boolean) => void;
  onHum: (on: boolean) => void;
  onLoop: () => void;
  onCheckAvSync: () => void;
}

export function PlaybackPanel({
  ready,
  state,
  clicks,
  hum,
  onTogglePlay,
  onSpeed,
  onClicks,
  onHum,
  onLoop,
  onCheckAvSync,
}: PlaybackPanelProps) {
  return (
    <section
      aria-label={t("timing.play.section")}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <AriaButton
          isDisabled={!ready}
          onPress={onTogglePlay}
          className={`${BUTTON} min-w-24 bg-ink text-white`}
        >
          {state.playing ? t("timing.play.pause") : t("timing.play.play")}
        </AriaButton>
        <ToggleButton
          isDisabled={!ready}
          isSelected={state.loop !== null}
          onChange={onLoop}
          className={`${BUTTON} bg-white text-ink data-selected:bg-yellow`}
        >
          {t("timing.play.loop")}
        </ToggleButton>
      </div>
      <RadioGroup
        value={String(state.rate)}
        onChange={(value) => {
          onSpeed(Number(value));
        }}
        orientation="horizontal"
        className="flex flex-wrap items-center gap-2"
      >
        <Label className="text-lg font-semibold">
          {t("timing.play.speed")}
        </Label>
        {SPEEDS.map((rate) => (
          <RadioField key={rate} value={String(rate)}>
            <RadioButton className={CHOICE}>
              {t("timing.play.speedPercent", { percent: rate * 100 })}
            </RadioButton>
          </RadioField>
        ))}
      </RadioGroup>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        <CheckboxField isSelected={clicks} onChange={onClicks}>
          <CheckboxButton className={CHECK}>
            <span className={BOX} aria-hidden />
            {t("timing.play.clicks")}
          </CheckboxButton>
        </CheckboxField>
        <CheckboxField isSelected={hum} onChange={onHum}>
          <CheckboxButton className={CHECK}>
            <span className={BOX} aria-hidden />
            {t("timing.play.hum")}
          </CheckboxButton>
        </CheckboxField>
      </div>
      <AriaButton
        onPress={onCheckAvSync}
        className={`${BUTTON} self-start bg-white text-ink`}
      >
        {t("timing.play.avSync")}
      </AriaButton>
      <p className="text-sm text-ink-2">{t("timing.play.keys")}</p>
    </section>
  );
}
