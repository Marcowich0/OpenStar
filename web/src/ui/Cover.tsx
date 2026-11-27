import { useMemo, useState, type ReactNode } from "react";

import { tokenVar } from "../theme/tokens";
import {
  generatedCover,
  generatedCoverSvg,
  type CoverSong,
} from "./generatedCover";

export interface CoverProps {
  /** The Song's cover image, or `null` when the Library found none. */
  src: string | null;
  /**
   * The Song the cover belongs to: without a cover image, or when it does
   * not load, it shows the Song's generated cover (spec #242). `null` while
   * the Song is not known yet: a plain tile.
   */
  song: CoverSong | null;
  /** The white rim's thickness in px (about 9 on the selected carousel cover). */
  rim: number;
  /**
   * Load the image only once it nears the screen (a long list of covers
   * fetched on demand, such as USDB search results).
   */
  lazy?: boolean;
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
  song,
  rim,
  lazy = false,
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
        backgroundColor:
          image === null
            ? tokenVar(song?.tileColour ?? "--color-cream-2")
            : undefined,
      }}
    >
      {image === null ? (
        song !== null && <GeneratedArt song={song} />
      ) : (
        <img
          src={image}
          alt=""
          draggable={false}
          loading={lazy ? "lazy" : undefined}
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

/** The Song's generated cover, drawn with the theme's tokens. */
function GeneratedArt({ song }: { song: CoverSong }) {
  const { id, title, tileColour } = song;
  const svg = useMemo(
    () =>
      generatedCoverSvg(generatedCover({ id, title, tileColour }), {
        resolve: tokenVar,
      }),
    [id, title, tileColour],
  );
  return (
    <div
      data-testid="generated-cover"
      aria-hidden="true"
      className="absolute inset-0"
      // Markup built by `generatedCoverSvg` alone, which escapes the title's
      // letter and every resolved value.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
