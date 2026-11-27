// The Stage options as a list: the groups Players, Look, Sing screen and
// Sound, each with its rows and an Advanced fold for the rarer ones. Each row
// has its name, a short explanation, its default, its control and Reset
// (greyed at the default). It takes the options and a change callback and
// knows nothing of where it is shown, so the Stage's Setup › Options and a
// Phone render the same list. Every control is a button, so the Stage's
// arrow keys reach them all.
//
// To add an option: its field (`stageOptions.ts`), its texts (`en.ts`), then
// one `switchRow`, `choiceRow` or `stepperRow` line in `rows` or `advanced`
// of its group in `OPTION_GROUPS`. A group with no rows is not shown.

import {
  createContext,
  useContext,
  useId,
  useState,
  type ReactNode,
} from "react";

import type { Difficulty } from "../generated/Difficulty";
import { t, type ArgsOf, type MessageKey } from "../i18n/t";
import type { en } from "../i18n/en";
import { Icon } from "../ui/Icon";
import { STAGE_OPTIONS, type StageOptions } from "./stageOptions";

type OptionKey = keyof StageOptions;
type OnChange = (change: Partial<StageOptions>) => void;

/** The keys of the options of type `V`. */
type KeysOf<V> = {
  [K in OptionKey]: StageOptions[K] extends V ? K : never;
}[OptionKey];

/** A catalogue key that takes no parameters (a row's name or help). */
type PlainKey = {
  [K in MessageKey]: ArgsOf<(typeof en)[K]> extends [] ? K : never;
}[MessageKey];

/** One option's row, ready to render against the current options. */
export interface OptionRowDef {
  key: OptionKey;
  name: PlainKey;
  help: PlainKey;
  /** The default's value, as the control shows it. */
  defaultText: () => string;
  control: (options: StageOptions, onChange: OnChange) => ReactNode;
}

export interface OptionGroupDef {
  id: "players" | "look" | "singScreen" | "sound";
  title: PlainKey;
  rows: readonly OptionRowDef[];
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
const OFF = "bg-white text-ink-2 shadow-ledge-sm";

const onOffText = (on: boolean) => (on ? t("options.on") : t("options.off"));

/** An on-or-off option. */
function switchRow(
  key: KeysOf<boolean>,
  name: PlainKey,
  help: PlainKey,
): OptionRowDef {
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
  name: PlainKey,
  help: PlainKey,
  values: readonly StageOptions[K][],
  text: (value: StageOptions[K]) => string,
): OptionRowDef {
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
  name: PlainKey,
  help: PlainKey,
  range: { min: number; max: number; step: number },
  text: (value: number) => string,
): OptionRowDef {
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

/** Every option, in its group, in the order shown. */
export const OPTION_GROUPS: readonly OptionGroupDef[] = [
  {
    id: "players",
    title: "options.group.players",
    rows: [
      choiceRow(
        "startingDifficulty",
        "options.startingDifficulty",
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
    rows: [],
    advanced: [],
  },
  {
    id: "singScreen",
    title: "options.group.singScreen",
    rows: [
      switchRow(
        "lineRatings",
        "options.lineRatings",
        "options.lineRatings.help",
      ),
      switchRow("effects", "options.effects", "options.effects.help"),
      switchRow("songVideo", "options.songVideo", "options.songVideo.help"),
      switchRow("skipIntros", "options.skipIntros", "options.skipIntros.help"),
    ],
    advanced: [],
  },
  {
    id: "sound",
    title: "options.group.sound",
    rows: [
      stepperRow(
        "previewVolumePercent",
        "options.previewVolume",
        "options.previewVolume.help",
        { min: 0, max: 100, step: STAGE_OPTIONS.previewVolumeStepPercent },
        (percent) => t("options.previewVolume.value", { percent }),
      ),
    ],
    advanced: [
      stepperRow(
        "resumeCountdownSeconds",
        "options.resumeCountdown",
        "options.resumeCountdown.help",
        { min: 0, max: STAGE_OPTIONS.resumeCountdownMaxSeconds, step: 1 },
        (count) => t("options.resumeCountdown.value", { count }),
      ),
    ],
  },
];

/**
 * The shown name of the one option a change names (`stageOptionsChanged`:
 * field names, as sent), or `null` for several, or for one with no row in
 * this build: the toast then says "the Options".
 */
export function changedOptionName(options: readonly string[]): string | null {
  const [only] = options;
  if (options.length !== 1 || only === undefined) return null;
  const row = OPTION_GROUPS.flatMap((group) => [
    ...group.rows,
    ...group.advanced,
  ]).find((def) => def.key === only);
  return row ? t(row.name) : null;
}

export interface OptionsListProps {
  options: StageOptions;
  /** Called with the changed fields; the caller saves them. */
  onChange: OnChange;
  /** The Phone's smaller list, for one hand on a 390 px wide screen. */
  compact?: boolean;
  /** Tests only: the groups to show. */
  groups?: readonly OptionGroupDef[];
}

/** The Stage options in their groups. */
export function OptionsList({
  options,
  onChange,
  compact = false,
  groups = OPTION_GROUPS,
}: OptionsListProps) {
  return (
    <Compact.Provider value={compact}>
      {groups
        .filter((group) => group.rows.length + group.advanced.length > 0)
        .map((group) => (
          <OptionGroup
            key={group.id}
            group={group}
            options={options}
            onChange={onChange}
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
}: {
  group: OptionGroupDef;
  options: StageOptions;
  onChange: OnChange;
}) {
  const compact = useContext(Compact);
  const heading = `options-${group.id}`;
  const rows = (defs: readonly OptionRowDef[]) => (
    <ul className={`flex flex-col ${compact ? "gap-3" : "gap-4"}`}>
      {defs.map((row) => (
        <OptionRow
          key={row.key}
          row={row}
          options={options}
          onChange={onChange}
        />
      ))}
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
        className={`${pill(compact)} gap-3 self-start bg-white text-ink shadow-ledge-sm`}
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
  const compact = useContext(Compact);
  const name = t(row.name);
  const atDefault = isDefault(options, row);
  const reset = (
    <button
      type="button"
      aria-label={t("options.resetLabel", { name })}
      {...(atDefault ? { "aria-disabled": true } : {})}
      onClick={() => {
        if (!atDefault) onChange({ [row.key]: defaults[row.key] });
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
        {t(row.help)}
      </p>
      <p className={`mt-1 ${compact ? "text-base" : "text-xl"} text-mute`}>
        {t("options.default", { value: row.defaultText() })}
      </p>
    </div>
  );
  if (compact) {
    return (
      <li
        className="flex flex-col gap-3 rounded-card bg-white px-4 py-4"
        data-option={row.key}
      >
        {texts}
        <div className="flex flex-wrap items-center gap-2">
          {row.control(options, onChange)}
          {reset}
        </div>
      </li>
    );
  }
  return (
    <li
      className="flex items-center gap-8 rounded-card bg-white px-8 py-5"
      data-option={row.key}
    >
      {texts}
      <div className="flex shrink-0 items-center gap-4">
        {row.control(options, onChange)}
      </div>
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
  "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full bg-ink text-white shadow-ledge-ink";

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
  const compact = useContext(Compact);
  const stepClass = `${STEP_BASE} ${compact ? "size-12" : "size-14"}`;
  const iconClass = compact ? "size-6" : "size-7";
  const move = (by: number) => {
    const next = Math.min(max, Math.max(min, value + by));
    if (next !== value) onSet(next);
  };
  return (
    <div className={`flex items-center ${compact ? "gap-2" : "gap-4"}`}>
      <button
        type="button"
        aria-label={t("options.down", { name })}
        {...(value <= min ? { "aria-disabled": true } : {})}
        onClick={() => {
          move(-step);
        }}
        className={`${stepClass} ${value <= min ? "opacity-45" : ""}`}
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
        {...(value >= max ? { "aria-disabled": true } : {})}
        onClick={() => {
          move(step);
        }}
        className={`${stepClass} ${value >= max ? "opacity-45" : ""}`}
      >
        <Icon name="plus" className={iconClass} />
      </button>
    </div>
  );
}
