import {
  Label,
  RadioButton,
  RadioField,
  RadioGroup,
  Text,
} from "react-aria-components";

import { colourName } from "../i18n/colourNames";
import { Swatch } from "../ui/Swatch";
import type { PaletteKey } from "../theme/tokens";
import type { ColourChoice } from "./joinForm";

export interface ColourPickerProps {
  label: string;
  /** Shown under the label (why some colours are crossed out). */
  hint?: string;
  choices: readonly ColourChoice[];
  value: PaletteKey | null;
  onChange: (colour: PaletteKey) => void;
}

/**
 * Party colours to pick from, each a swatch with its palette name, so colour
 * is never the only cue. A held colour is crossed out and can't be picked.
 */
export function ColourPicker({
  label,
  hint,
  choices,
  value,
  onChange,
}: ColourPickerProps) {
  return (
    <RadioGroup
      value={value}
      onChange={(key) => {
        const choice = choices.find((c) => c.colour === key);
        if (choice && !choice.held) onChange(choice.colour);
      }}
      className="flex flex-col gap-2"
    >
      <Label className="text-lg font-semibold">{label}</Label>
      {hint ? (
        <Text slot="description" className="text-ink-2">
          {hint}
        </Text>
      ) : null}
      <div className="grid grid-cols-3 gap-2">
        {choices.map(({ colour, held }) => (
          <RadioField key={colour} value={colour} isDisabled={held}>
            <RadioButton
              className={[
                "flex cursor-pointer flex-col items-center gap-1 rounded-card-sm p-2 text-base font-semibold outline-none",
                "data-focus-visible:outline-6 data-focus-visible:outline-yellow",
                "data-selected:bg-surface data-selected:shadow-ledge-sm",
                "data-disabled:cursor-not-allowed data-disabled:opacity-45",
              ].join(" ")}
            >
              <span aria-hidden="true" className="relative">
                <Swatch colour={colour} className="size-11" />
                {held ? (
                  <span className="absolute top-1/2 left-0 h-1 w-full -translate-y-1/2 -rotate-45 rounded-full bg-ink" />
                ) : null}
              </span>
              <span className={held ? "line-through" : ""}>
                {colourName(colour)}
              </span>
            </RadioButton>
          </RadioField>
        ))}
      </div>
    </RadioGroup>
  );
}
