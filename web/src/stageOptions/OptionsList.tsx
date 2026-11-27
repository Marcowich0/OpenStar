// The Stage options as a list: the groups Players, Look, Sing screen and
// Sound, each with its rows and an Advanced fold for the rarer ones. Each row
// has its name, a short explanation, its default, its control and Reset
// (greyed at the default). It takes the options and a change callback and
// knows nothing of where it is shown, so the Stage's Setup › Options and a
// Phone render the same list. Every control is a button, so the Stage's
// arrow keys reach them all.
//
// To add an option: its field (`stageOptions.ts`), its texts (`en.ts`), its
// name (`optionNames.ts`), then one `switchRow`, `choiceRow` or `stepperRow`
// line in `rows` or `advanced` of its group in `OPTION_GROUPS`.
//
// One row is not a Stage option: the OpenStar volume under Sound (#270). It
// is live state the server keeps per Stage output and moves in steps of 5,
// bound to the same value as a Phone's Volume control (`OpenStarVolume`,
// passed in by the caller), so it is never a copy. Its − and + ask for one
// step, as the Phone's do; its default is 80, where an output with no kept
// volume starts, and its Reset asks the server to set 80 (`setVolume`).
// Without a binding (no live connection) the row is left out.

import {
  createContext,
  useContext,
  useId,
  useState,
  type ReactNode,
} from "react";

import type { Difficulty } from "../generated/Difficulty";
import type { LyricSize } from "../generated/LyricSize";
import type { Effects } from "../generated/Effects";
import type { OpenStarVolume } from "../live/useOpenStarVolume";
import { OPENSTAR_VOLUME } from "../playback/gain";
import { THEME_NAMES } from "../theme/themes";
import { t } from "../i18n/t";
import { Icon } from "../ui/Icon";
import { OPTION_NAMES, type PlainKey } from "./optionNames";
import { STAGE_OPTIONS, type StageOptions } from "./stageOptions";

type OptionKey = keyof StageOptions;
type OnChange = (change: Partial<StageOptions>) => void;

/** The keys of the options of type `V`. */
type KeysOf<V> = {
  [K in OptionKey]: StageOptions[K] extends V ? K : never;
}[OptionKey];

/** One option's row, ready to render against the current options. */
export interface OptionRowDef {
  key: OptionKey;
  name: PlainKey;
  help: PlainKey;
  /** The default's value, as the control shows it. */
  defaultText: () => string;
  control: (options: StageOptions, onChange: OnChange) => ReactNode;
}

/** The OpenStar volume's row: live state, not a Stage option. */
export interface VolumeRowDef {
  key: "openStarVolume";
  name: PlainKey;
  help: PlainKey;
}

export type RowDef = OptionRowDef | VolumeRowDef;

export interface OptionGroupDef {
  id: "players" | "look" | "singScreen" | "sound";
  title: PlainKey;
  rows: readonly RowDef[];
  /** Behind the Advanced fold, closed by default. */
  advanced: readonly OptionRowDef[];
}

const defaults = STAGE_OPTIONS.defaults;

/**
 * The Phone's smaller list (`compact`): each row stacks its texts over its
 * controls, which wrap, so it fits a 390 px wide screen.
 */
const Compact = createContext(false);

const PILL_BASE =
  "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full font-bold transition";
const pill = (compact: boolean) =>
  `${PILL_BASE} ${compact ? "min-h-12 px-5 text-lg" : "min-h-14 px-7 text-2xl"}`;
const ON = "bg-green text-white shadow-ledge-green";
const OFF = "bg-surface text-ink-2 shadow-ledge-sm";

const onOffText = (on: boolean) => (on ? t("options.on") : t("options.off"));

/** An on-or-off option. */
function switchRow(key: KeysOf<boolean>, help: PlainKey): OptionRowDef {
  const name: PlainKey = OPTION_NAMES[key];
  return {
    key,
    name,
    help,
    defaultText: () => onOffText(defaults[key]),
    control: (options, onChange) => (
      <SwitchControl
        name={t(name)}
        on={options[key]}
        onSwitch={(on) => {
          onChange({ [key]: on });
        }}
      />
    ),
  };
}

/** An option of a few values, each its own pill. */
function choiceRow<K extends KeysOf<string>>(
  key: K,
  help: PlainKey,
  values: readonly StageOptions[K][],
  text: (value: StageOptions[K]) => string,
): OptionRowDef {
  const name: PlainKey = OPTION_NAMES[key];
  return {
    key,
    name,
    help,
    defaultText: () => text(defaults[key]),
    control: (options, onChange) => (
      <ChoiceControl
        name={t(name)}
        value={options[key]}
        choices={values.map((value) => ({ value, text: text(value) }))}
        onPick={(value) => {
          const change: Partial<StageOptions> = {};
          change[key] = value;
          onChange(change);
        }}
      />
    ),
  };
}

/** A number within `min`..`max`, moved by `step`. */
function stepperRow(
  key: KeysOf<number>,
  help: PlainKey,
  range: { min: number; max: number; step: number },
  text: (value: number) => string,
): OptionRowDef {
  const name: PlainKey = OPTION_NAMES[key];
  return {
    key,
    name,
    help,
    defaultText: () => text(defaults[key]),
    control: (options, onChange) => (
      <StepperControl
        name={t(name)}
        value={options[key]}
        {...range}
        text={text(options[key])}
        onSet={(value) => {
          onChange({ [key]: value });
        }}
      />
    ),
  };
}

const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "hard"];
const LYRIC_SIZES: readonly LyricSize[] = ["s", "m", "l", "xl"];
const EFFECTS_VALUES: readonly Effects[] = ["off", "calm", "full"];

/** Every option, in its group, in the order shown. */
export const OPTION_GROUPS: readonly OptionGroupDef[] = [
  {
    id: "players",
    title: "options.group.players",
    rows: [
      choiceRow(
        "startingDifficulty",
        "options.startingDifficulty.help",
        DIFFICULTIES,
        (value) => t(`difficulty.${value}`),
      ),
    ],
    advanced: [],
  },
  {
    id: "look",
    title: "options.group.look",
    rows: [
      choiceRow("theme", "options.theme.help", THEME_NAMES, (theme) =>
        t(`options.theme.${theme}`),
      ),
    ],
    advanced: [
      stepperRow(
        "laneFrostingPercent",
        "options.laneFrosting.help",
        STAGE_OPTIONS.laneFrosting,
        (percent) => t("options.laneFrosting.value", { percent }),
      ),
    ],
  },
  {
    id: "singScreen",
    title: "options.group.singScreen",
    rows: [
      switchRow("lineRatings", "options.lineRatings.help"),
      choiceRow("effects", "options.effects.help", EFFECTS_VALUES, (value) =>
        t(`options.effects.${value}`),
      ),
      switchRow("songVideo", "options.songVideo.help"),
      switchRow("skipIntros", "options.skipIntros.help"),
      choiceRow("lyricSize", "options.lyricSize.help", LYRIC_SIZES, (size) =>
        t(`options.lyricSize.${size}`),
      ),
    ],
    advanced: [switchRow("showNextLine", "options.showNextLine.help")],
  },
  {
    id: "sound",
    title: "options.group.sound",
    rows: [
      {
        key: "openStarVolume",
        name: "options.openStarVolume",
        help: "options.openStarVolume.help",
      },
      stepperRow(
        "uiSoundsPercent",
        "options.uiSounds.help",
        STAGE_OPTIONS.uiSounds,
        (percent) =>
          percent === 0
            ? t("options.off")
            : t("options.uiSounds.value", { percent }),
      ),
      stepperRow(
        "previewVolumePercent",
        "options.previewVolume.help",
        STAGE_OPTIONS.previewVolume,
        (percent) => t("options.previewVolume.value", { percent }),
      ),
    ],
    advanced: [
      stepperRow(
        "resumeCountdownSeconds",
        "options.resumeCountdown.help",
        STAGE_OPTIONS.resumeCountdown,
        (count) => t("options.resumeCountdown.value", { count }),
      ),
    ],
  },
];

export interface OptionsListProps {
  options: StageOptions;
  /** Called with the changed fields; the caller saves them. */
  onChange: OnChange;
  /**
   * The OpenStar volume to show under Sound (`useOpenStarVolume`), or none
   * to leave its row out.
   */
  openStarVolume?: OpenStarVolume | undefined;
  /** The Phone's smaller list, for one hand on a 390 px wide screen. */
  compact?: boolean;
}

/** The Stage options in their groups. */
export function OptionsList({
  options,
  onChange,
  openStarVolume,
  compact = false,
}: OptionsListProps) {
  return (
    <Compact.Provider value={compact}>
      {OPTION_GROUPS.map((group) => (
        <OptionGroup
          key={group.id}
          group={group}
          options={options}
          onChange={onChange}
          openStarVolume={openStarVolume}
        />
      ))}
    </Compact.Provider>
  );
}

const isDefault = (options: StageOptions, row: OptionRowDef) =>
  options[row.key] === defaults[row.key];

/** One group: its heading, its rows and its Advanced fold. */
function OptionGroup({
  group,
  options,
  onChange,
  openStarVolume,
}: {
  group: OptionGroupDef;
  options: StageOptions;
  onChange: OnChange;
  openStarVolume: OpenStarVolume | undefined;
}) {
  const compact = useContext(Compact);
  const heading = `options-${group.id}`;
  const rows = (defs: readonly RowDef[]) => (
    <ul className={`flex flex-col ${compact ? "gap-3" : "gap-4"}`}>
      {defs.map((row) =>
        row.key === "openStarVolume" ? (
          openStarVolume && (
            <VolumeRow key={row.key} row={row} volume={openStarVolume} />
          )
        ) : (
          <OptionRow
            key={row.key}
            row={row}
            options={options}
            onChange={onChange}
          />
        ),
      )}
    </ul>
  );
  return (
    <section
      role="group"
      aria-labelledby={heading}
      className={`flex flex-col ${compact ? "gap-3" : "gap-4"}`}
      data-testid={heading}
      data-options-group={group.id}
    >
      <h3
        id={heading}
        className={compact ? "text-2xl font-bold" : "text-3xl font-bold"}
      >
        {t(group.title)}
      </h3>
      {group.rows.length > 0 && rows(group.rows)}
      {group.advanced.length > 0 && (
        <AdvancedFold
          changed={group.advanced.some((row) => !isDefault(options, row))}
        >
          {rows(group.advanced)}
        </AdvancedFold>
      )}
    </section>
  );
}

/** The rarer options of a group, folded away until opened. */
function AdvancedFold({
  changed,
  children,
}: {
  /** An option inside differs from its default: the fold shows a dot. */
  changed: boolean;
  children: ReactNode;
}) {
  const compact = useContext(Compact);
  const [open, setOpen] = useState(false);
  const inside = useId();
  return (
    <div className={`flex flex-col ${compact ? "gap-3" : "gap-4"}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={inside}
        onClick={() => {
          setOpen(!open);
        }}
        className={`${pill(compact)} gap-3 self-start bg-surface text-ink shadow-ledge-sm`}
      >
        <Icon
          name="chevron"
          className={`${compact ? "size-6" : "size-7"} transition ${open ? "rotate-90" : ""}`}
        />
        {t("options.advanced")}
        {changed && (
          <>
            <span
              aria-hidden="true"
              data-testid="options-advanced-changed"
              className={`${compact ? "size-3" : "size-4"} rounded-full bg-red`}
            />
            <span className="sr-only">{t("options.advanced.changed")}</span>
          </>
        )}
      </button>
      {open && <div id={inside}>{children}</div>}
    </div>
  );
}

/** One option: name and explanation, its control, and Reset. */
function OptionRow({
  row,
  options,
  onChange,
}: {
  row: OptionRowDef;
  options: StageOptions;
  onChange: OnChange;
}) {
  return (
    <RowShell
      id={row.key}
      name={t(row.name)}
      help={t(row.help)}
      defaultText={row.defaultText()}
      atDefault={isDefault(options, row)}
      onReset={() => {
        onChange({ [row.key]: defaults[row.key] });
      }}
      control={row.control(options, onChange)}
    />
  );
}

/**
 * The OpenStar volume: the server's value, − and + one step each, and Reset
 * to 80. All greyed until a Stage has told its volume.
 */
function VolumeRow({
  row,
  volume: { volume, step, set },
}: {
  row: VolumeRowDef;
  volume: OpenStarVolume;
}) {
  const name = t(row.name);
  return (
    <RowShell
      id={row.key}
      name={name}
      help={t(row.help)}
      defaultText={String(OPENSTAR_VOLUME.default)}
      atDefault={volume === null || volume === OPENSTAR_VOLUME.default}
      onReset={() => {
        set(OPENSTAR_VOLUME.default);
      }}
      control={
        <StepperControl
          name={name}
          value={volume ?? OPENSTAR_VOLUME.default}
          min={OPENSTAR_VOLUME.min}
          max={OPENSTAR_VOLUME.max}
          step={OPENSTAR_VOLUME.step}
          text={
            volume === null
              ? t("options.openStarVolume.unknown")
              : String(volume)
          }
          disabled={volume === null}
          onSet={(next) => {
            if (volume !== null) step(next > volume ? "up" : "down");
          }}
        />
      }
    />
  );
}

/** A row's layout: name and explanation, its control, and Reset. */
function RowShell({
  id,
  name,
  help,
  defaultText,
  atDefault,
  onReset,
  control,
}: {
  id: string;
  name: string;
  help: string;
  defaultText: string;
  atDefault: boolean;
  onReset: () => void;
  control: ReactNode;
}) {
  const compact = useContext(Compact);
  const reset = (
    <button
      type="button"
      aria-label={t("options.resetLabel", { name })}
      {...(atDefault ? { "aria-disabled": true } : {})}
      onClick={() => {
        if (!atDefault) onReset();
      }}
      className={`${pill(compact)} bg-cream text-ink shadow-ledge-sm ${compact ? "ml-auto" : ""} ${atDefault ? "cursor-not-allowed opacity-45" : ""}`}
    >
      {t("options.reset")}
    </button>
  );
  const texts = (
    <div className="min-w-0 flex-1">
      <h4
        className={compact ? "text-xl font-semibold" : "text-3xl font-semibold"}
      >
        {name}
      </h4>
      <p className={`mt-1 ${compact ? "text-base" : "text-xl"} text-ink-2`}>
        {help}
      </p>
      <p className={`mt-1 ${compact ? "text-base" : "text-xl"} text-mute`}>
        {t("options.default", { value: defaultText })}
      </p>
    </div>
  );
  if (compact) {
    return (
      <li
        className="flex flex-col gap-3 rounded-card bg-surface px-4 py-4"
        data-option={id}
      >
        {texts}
        <div className="flex flex-wrap items-center gap-2">
          {control}
          {reset}
        </div>
      </li>
    );
  }
  return (
    <li
      className="flex items-center gap-8 rounded-card bg-surface px-8 py-5"
      data-option={id}
    >
      {texts}
      <div className="flex shrink-0 items-center gap-4">{control}</div>
      {reset}
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
  const compact = useContext(Compact);
  return (
    <div
      role="group"
      aria-label={name}
      className={compact ? "flex flex-wrap gap-2" : "flex gap-3"}
    >
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          aria-pressed={choice.value === value}
          onClick={() => {
            onPick(choice.value);
          }}
          className={`${pill(compact)} ${choice.value === value ? ON : OFF}`}
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
  const compact = useContext(Compact);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={name}
      onClick={() => {
        onSwitch(!on);
      }}
      className={`${pill(compact)} ${compact ? "w-24" : "w-36"} ${on ? ON : OFF}`}
    >
      {on ? t("options.on") : t("options.off")}
    </button>
  );
}

const STEP_BASE =
  "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full bg-ink-fill text-white shadow-ledge-ink";

/**
 * A number within `min`..`max`, moved by `step` with − and +. A value off the
 * steps (a default such as 66 %) moves to the nearest step that way.
 * `disabled` greys both.
 */
function StepperControl({
  name,
  value,
  min,
  max,
  step,
  text,
  disabled = false,
  onSet,
}: {
  name: string;
  value: number;
  min: number;
  max: number;
  step: number;
  text: string;
  disabled?: boolean;
  onSet: (value: number) => void;
}) {
  const compact = useContext(Compact);
  const stepClass = `${STEP_BASE} ${compact ? "size-12" : "size-14"}`;
  const iconClass = compact ? "size-6" : "size-7";
  const move = (by: number) => {
    const onStep =
      by > 0
        ? Math.floor(value / step) * step + step
        : Math.ceil(value / step) * step - step;
    const next = Math.min(max, Math.max(min, onStep));
    if (!disabled && next !== value) onSet(next);
  };
  const atMin = disabled || value <= min;
  const atMax = disabled || value >= max;
  return (
    <div className={`flex items-center ${compact ? "gap-2" : "gap-4"}`}>
      <button
        type="button"
        aria-label={t("options.down", { name })}
        {...(atMin ? { "aria-disabled": true } : {})}
        onClick={() => {
          move(-step);
        }}
        className={`${stepClass} ${atMin ? "opacity-45" : ""}`}
      >
        <Icon name="minus" className={iconClass} />
      </button>
      <p
        aria-label={name}
        aria-live="polite"
        className={`text-center font-bold tabular-nums ${compact ? "min-w-28 text-2xl" : "min-w-44 text-3xl"}`}
      >
        {text}
      </p>
      <button
        type="button"
        aria-label={t("options.up", { name })}
        {...(atMax ? { "aria-disabled": true } : {})}
        onClick={() => {
          move(step);
        }}
        className={`${stepClass} ${atMax ? "opacity-45" : ""}`}
      >
        <Icon name="plus" className={iconClass} />
      </button>
    </div>
  );
}
