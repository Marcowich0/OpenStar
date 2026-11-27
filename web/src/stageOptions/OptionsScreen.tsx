// Setup › Options on the Stage: the Stage options in groups, each row with
// its name, a short explanation, its control and Reset (greyed at the
// default, which is how the Stage behaved before the option existed). Every
// change is saved at once, with no Admin PIN, and kept for every Party.
// Every control is a button, so the Stage's arrow keys reach them all.
//
// To add an option: its field (`stageOptions.ts`), then one `OptionRow` in
// the group it belongs to, with a `ChoiceControl`, `SwitchControl` or
// `StepperControl`.

import type { ReactNode } from "react";

import type { Difficulty } from "../generated/Difficulty";
import { t } from "../i18n/t";
import { Icon } from "../ui/Icon";
import { STAGE_OPTIONS, type StageOptions } from "./stageOptions";
import { useStageOptions } from "./useStageOptions";

const PILL =
  "inline-flex min-h-14 shrink-0 cursor-pointer items-center justify-center rounded-full px-7 text-2xl font-bold transition";
const ON = "bg-green text-white shadow-ledge-green";
const OFF = "bg-white text-ink-2 shadow-ledge-sm";

/** One group of rows under its heading. */
function OptionGroup({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  const heading = `options-${id}`;
  return (
    <section
      role="group"
      aria-labelledby={heading}
      className="flex flex-col gap-4"
      data-testid={heading}
    >
      <h3 id={heading} className="text-3xl font-bold">
        {title}
      </h3>
      <ul className="flex flex-col gap-4">{children}</ul>
    </section>
  );
}

/** One option: name and explanation, its control, and Reset. */
function OptionRow({
  id,
  name,
  help,
  isDefault,
  defaultText,
  onReset,
  children,
}: {
  id: string;
  name: string;
  help: string;
  isDefault: boolean;
  /** The default's value, as the control shows it. */
  defaultText: string;
  onReset: () => void;
  children: ReactNode;
}) {
  return (
    <li
      className="flex items-center gap-8 rounded-card bg-white px-8 py-5"
      data-option={id}
    >
      <div className="min-w-0 flex-1">
        <h4 className="text-3xl font-semibold">{name}</h4>
        <p className="mt-1 text-xl text-ink-2">{help}</p>
        <p className="mt-1 text-xl text-mute">
          {t("options.default", { value: defaultText })}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-4">{children}</div>
      <button
        type="button"
        aria-label={t("options.resetLabel", { name })}
        {...(isDefault ? { "aria-disabled": true } : {})}
        onClick={() => {
          if (!isDefault) onReset();
        }}
        className={`${PILL} bg-cream text-ink shadow-ledge-sm ${isDefault ? "cursor-not-allowed opacity-45" : ""}`}
      >
        {t("options.reset")}
      </button>
    </li>
  );
}

/** One of a few values, each its own pill. */
function ChoiceControl<V extends string>({
  name,
  value,
  choices,
  onPick,
}: {
  name: string;
  value: V;
  choices: readonly { value: V; text: string }[];
  onPick: (value: V) => void;
}) {
  return (
    <div role="group" aria-label={name} className="flex gap-3">
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          aria-pressed={choice.value === value}
          onClick={() => {
            onPick(choice.value);
          }}
          className={`${PILL} ${choice.value === value ? ON : OFF}`}
        >
          {choice.text}
        </button>
      ))}
    </div>
  );
}

/** On or off. */
function SwitchControl({
  name,
  on,
  onSwitch,
}: {
  name: string;
  on: boolean;
  onSwitch: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={name}
      onClick={() => {
        onSwitch(!on);
      }}
      className={`${PILL} w-36 ${on ? ON : OFF}`}
    >
      {on ? t("options.on") : t("options.off")}
    </button>
  );
}

const STEP =
  "inline-flex size-14 shrink-0 cursor-pointer items-center justify-center rounded-full bg-ink text-white shadow-ledge-ink";

/** A number within `min`..`max`, moved by `step` with − and +. */
function StepperControl({
  name,
  value,
  min,
  max,
  step,
  text,
  onSet,
}: {
  name: string;
  value: number;
  min: number;
  max: number;
  step: number;
  text: string;
  onSet: (value: number) => void;
}) {
  const move = (by: number) => {
    const next = Math.min(max, Math.max(min, value + by));
    if (next !== value) onSet(next);
  };
  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        aria-label={t("options.down", { name })}
        {...(value <= min ? { "aria-disabled": true } : {})}
        onClick={() => {
          move(-step);
        }}
        className={`${STEP} ${value <= min ? "opacity-45" : ""}`}
      >
        <Icon name="minus" className="size-7" />
      </button>
      <p
        aria-label={name}
        aria-live="polite"
        className="min-w-44 text-center text-3xl font-bold tabular-nums"
      >
        {text}
      </p>
      <button
        type="button"
        aria-label={t("options.up", { name })}
        {...(value >= max ? { "aria-disabled": true } : {})}
        onClick={() => {
          move(step);
        }}
        className={`${STEP} ${value >= max ? "opacity-45" : ""}`}
      >
        <Icon name="plus" className="size-7" />
      </button>
    </div>
  );
}

const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "hard"];

const countdownText = (seconds: number) =>
  t("options.resumeCountdown.value", { count: seconds });
const previewText = (percent: number) =>
  t("options.previewVolume.value", { percent });
const onOffText = (on: boolean) => (on ? t("options.on") : t("options.off"));

export function OptionsScreen() {
  const { options, saveFailed, change } = useStageOptions();
  const defaults = STAGE_OPTIONS.defaults;
  const is = (key: keyof StageOptions) => options[key] === defaults[key];
  const reset = (key: keyof StageOptions) => () => {
    change({ [key]: defaults[key] });
  };

  return (
    <div className="flex flex-col gap-8" data-testid="stage-options">
      <p className="text-2xl text-ink-2">{t("options.hint")}</p>
      {saveFailed && (
        <p role="alert" className="text-2xl font-semibold text-warn-fg">
          {t("options.saveFailed")}
        </p>
      )}

      <OptionGroup id="players" title={t("options.group.players")}>
        <OptionRow
          id="startingDifficulty"
          name={t("options.startingDifficulty")}
          help={t("options.startingDifficulty.help")}
          isDefault={is("startingDifficulty")}
          defaultText={t(`difficulty.${defaults.startingDifficulty}`)}
          onReset={reset("startingDifficulty")}
        >
          <ChoiceControl
            name={t("options.startingDifficulty")}
            value={options.startingDifficulty}
            choices={DIFFICULTIES.map((value) => ({
              value,
              text: t(`difficulty.${value}`),
            }))}
            onPick={(startingDifficulty) => {
              change({ startingDifficulty });
            }}
          />
        </OptionRow>
      </OptionGroup>

      <OptionGroup id="singScreen" title={t("options.group.singScreen")}>
        <OptionRow
          id="lineRatings"
          name={t("options.lineRatings")}
          help={t("options.lineRatings.help")}
          isDefault={is("lineRatings")}
          defaultText={onOffText(defaults.lineRatings)}
          onReset={reset("lineRatings")}
        >
          <SwitchControl
            name={t("options.lineRatings")}
            on={options.lineRatings}
            onSwitch={(lineRatings) => {
              change({ lineRatings });
            }}
          />
        </OptionRow>
        <OptionRow
          id="effects"
          name={t("options.effects")}
          help={t("options.effects.help")}
          isDefault={is("effects")}
          defaultText={onOffText(defaults.effects)}
          onReset={reset("effects")}
        >
          <SwitchControl
            name={t("options.effects")}
            on={options.effects}
            onSwitch={(effects) => {
              change({ effects });
            }}
          />
        </OptionRow>
        <OptionRow
          id="songVideo"
          name={t("options.songVideo")}
          help={t("options.songVideo.help")}
          isDefault={is("songVideo")}
          defaultText={onOffText(defaults.songVideo)}
          onReset={reset("songVideo")}
        >
          <SwitchControl
            name={t("options.songVideo")}
            on={options.songVideo}
            onSwitch={(songVideo) => {
              change({ songVideo });
            }}
          />
        </OptionRow>
      </OptionGroup>

      <OptionGroup id="playback" title={t("options.group.playback")}>
        <OptionRow
          id="resumeCountdownSeconds"
          name={t("options.resumeCountdown")}
          help={t("options.resumeCountdown.help")}
          isDefault={is("resumeCountdownSeconds")}
          defaultText={countdownText(defaults.resumeCountdownSeconds)}
          onReset={reset("resumeCountdownSeconds")}
        >
          <StepperControl
            name={t("options.resumeCountdown")}
            value={options.resumeCountdownSeconds}
            min={0}
            max={STAGE_OPTIONS.resumeCountdownMaxSeconds}
            step={1}
            text={countdownText(options.resumeCountdownSeconds)}
            onSet={(resumeCountdownSeconds) => {
              change({ resumeCountdownSeconds });
            }}
          />
        </OptionRow>
        <OptionRow
          id="previewVolumePercent"
          name={t("options.previewVolume")}
          help={t("options.previewVolume.help")}
          isDefault={is("previewVolumePercent")}
          defaultText={previewText(defaults.previewVolumePercent)}
          onReset={reset("previewVolumePercent")}
        >
          <StepperControl
            name={t("options.previewVolume")}
            value={options.previewVolumePercent}
            min={0}
            max={100}
            step={STAGE_OPTIONS.previewVolumeStepPercent}
            text={previewText(options.previewVolumePercent)}
            onSet={(previewVolumePercent) => {
              change({ previewVolumePercent });
            }}
          />
        </OptionRow>
      </OptionGroup>
    </div>
  );
}
