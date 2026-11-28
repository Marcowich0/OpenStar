import { avatarIconUrl } from "../avatars/avatarIcons";
import type { Avatar as AvatarValue } from "../generated/Avatar";
import { tokenVar, type PaletteKey } from "../theme/tokens";
import { avatarFace, initialOf } from "./avatarFace";

export interface AvatarProps {
  /** The Party member's or Profile's name: the label, and the initial. */
  name: string;
  avatar: AvatarValue;
  /**
   * The owner's colour: the Party colour inside a Party, the Profile's
   * favourite colour outside one (Profile lists, High-score tables).
   */
  colour: PaletteKey;
  /** The diameter in px in the reference frame; under 32 shows the initial. */
  size: number;
  /** Layout utilities from the caller. */
  className?: string;
}

// Everything is drawn on a 100-unit grid, so the proportions below are
// percentages of the diameter.
const RIM = 7;
const ICON = 55;
// The icons' outline and mark widths, on their own 64-unit grid
// (see avatars/avatarIcons.ts).
const ICON_OUTLINE = 6;
const ICON_DETAIL = 3.5;
// Half of the initial's stroke shows outside the letter: 3.5 % of the diameter.
const INITIAL_STROKE = 7;

/**
 * An avatar (v1 spec #55, "Avatars and covers"): a disc in its owner's
 * colour with a white rim and a ledge, carrying the owner's icon from the
 * built-in set, or their outlined initial where it is drawn under 32 px.
 * Labelled with the name for assistive tech.
 */
export function Avatar({
  name,
  avatar,
  colour,
  size,
  className = "",
}: AvatarProps) {
  return (
    <span
      role="img"
      aria-label={name}
      className={`inline-block shrink-0 rounded-full shadow-ledge-sm ${className}`}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 100 100" className="block size-full" aria-hidden="true">
        <circle
          cx="50"
          cy="50"
          r={50 - RIM / 2}
          strokeWidth={RIM}
          style={{ fill: tokenVar(colour), stroke: tokenVar("--color-white") }}
        />
        {avatarFace(size) === "icon" ? (
          <AvatarIcon avatar={avatar} />
        ) : (
          <text
            x="50"
            y="50"
            dy="0.35em"
            textAnchor="middle"
            fontSize="50"
            fontWeight="700"
            strokeWidth={INITIAL_STROKE}
            strokeLinejoin="round"
            paintOrder="stroke fill"
            className="font-sans"
            style={{
              fill: tokenVar("--color-white"),
              stroke: tokenVar("--color-on-bright"),
            }}
          >
            {initialOf(name)}
          </text>
        )}
      </svg>
    </span>
  );
}

/** The icon, centred over 55 % of the disc: ink outline, white fill, ink marks. */
function AvatarIcon({ avatar }: { avatar: AvatarValue }) {
  // Dark in every theme: the marks sit on the white glyph and the Party colour.
  const ink = tokenVar("--color-on-bright");
  return (
    <svg
      x={(100 - ICON) / 2}
      y={(100 - ICON) / 2}
      width={ICON}
      height={ICON}
      viewBox="0 0 64 64"
      overflow="visible"
    >
      <use
        href={avatarIconUrl(avatar.key, "glyph")}
        strokeWidth={ICON_OUTLINE}
        strokeLinejoin="round"
        style={{ fill: ink, stroke: ink }}
      />
      <use
        href={avatarIconUrl(avatar.key, "glyph")}
        style={{ fill: tokenVar("--color-white"), stroke: "none" }}
      />
      <use
        href={avatarIconUrl(avatar.key, "detail")}
        strokeWidth={ICON_DETAIL}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ fill: ink, stroke: ink }}
      />
    </svg>
  );
}
