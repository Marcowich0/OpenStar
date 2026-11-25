import { colourName } from "../i18n/colourNames";
import { tokenVar, type PaletteKey } from "../theme/tokens";

export interface SwatchProps {
  /** A Party colour. Golden yellow, passed grey and slate are not offered. */
  colour: PaletteKey;
  /** Size utilities from the caller. */
  className?: string;
}

/**
 * A Party colour shown on its own: a disc with a white rim and a ledge,
 * labelled with the colour's display name ("Tangerine") for assistive tech.
 */
export function Swatch({ colour, className = "size-12" }: SwatchProps) {
  return (
    <span
      role="img"
      aria-label={colourName(colour)}
      className={`inline-block shrink-0 rounded-full border-4 border-white shadow-ledge-sm ${className}`}
      style={{ backgroundColor: tokenVar(colour) }}
    />
  );
}
