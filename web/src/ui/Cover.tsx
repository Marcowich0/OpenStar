import { useState, type ReactNode } from "react";

import { avatarIconUrl } from "../avatars/avatarIcons";
import { tokenVar, type PaletteKey } from "../theme/tokens";

export interface CoverProps {
  /** The Song's cover image, or `null` when the Library found none. */
  src: string | null;
  /**
   * The generated tile's colour: the palette key the Library picks from the
   * Song's identity (v1 spec: Library, #46). Shown when there is no cover or
   * it does not load.
   */
  tileColour: PaletteKey;
  /** The white rim's thickness in px (about 9 on the selected carousel cover). */
  rim: number;
  /** Size and layout utilities from the caller (the cover is square). */
  className?: string;
  /** Laid over the cover (for example a "preparing" label). */
  children?: ReactNode;
}

/**
 * A Song's cover (v1 spec #55, "Avatars and covers"): a rounded square with
 * a white rim and a ledge. Decorative: the Song's title is shown beside it.
 */
export function Cover({
  src,
  tileColour,
  rim,
  className = "w-32",
  children,
}: CoverProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const image = src !== null && src !== failed ? src : null;
  return (
    <div
      data-testid="cover"
      className={`relative aspect-square shrink-0 overflow-hidden border-white shadow-ledge ${className}`}
      style={{
        borderWidth: rim,
        borderStyle: "solid",
        borderRadius: "14%",
        backgroundColor: image === null ? tokenVar(tileColour) : undefined,
      }}
    >
      {image === null ? (
        <GeneratedTile />
      ) : (
        <img
          src={image}
          alt=""
          draggable={false}
          className="block size-full object-cover"
          onError={() => {
            setFailed(image);
          }}
        />
      )}
      {children}
    </div>
  );
}

/** The generated tile's mark: a faint white note on the tile colour. */
function GeneratedTile() {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden="true"
      className="absolute inset-[22%] opacity-35"
    >
      <use
        href={avatarIconUrl("note", "glyph")}
        style={{ fill: tokenVar("--color-white") }}
      />
    </svg>
  );
}
